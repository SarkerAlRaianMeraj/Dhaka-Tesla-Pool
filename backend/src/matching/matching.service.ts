import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  CLAIMABLE_RIDE_STATUSES,
  RideStatus,
} from '../common/enums/ride-status.enum';
import { OPEN_POOL_STATUSES } from '../pool/pool-status.enum';
import { Pool } from '../pool/pool.entity';
import { Ride } from '../ride/ride.entity';
import { RideStatusHistory } from '../ride/ride-status-history.entity';
import { TeslaAvailability } from '../tesla/tesla-availability.enum';
import {
  buildCorridorIndex,
  canShare,
  MatchableRequest,
} from '../tesla/matching';
import { Tesla } from '../tesla/tesla.entity';
import { ZoneService } from '../zone/zone.service';

/**
 * The ride-side of matching: `REQUESTED` and `MATCHED` are not two static states
 * a driver writes, they are the honest answer to "does a suitable online Tesla
 * with free capacity exist for this request right now" (PRD §5.2, status table).
 *
 * ## Why the status has to be re-derived, not just written
 *
 * `MATCHED` is a claim that a Tesla can still be found; that claim must be true
 * when the passenger reads it. Three events change the candidate set while a ride
 * is still unassigned, and each one is where the status needs rechecking:
 *
 * - a new request appears (its creation is where `MATCHED` is first decided, and
 *   PRD's "< 60 s from request to MATCHED" is why `POST /rides` calls this
 *   inline rather than waiting for a background job);
 * - a driver goes online or offline (an offline Tesla is no longer a candidate);
 * - a claim happens (accepting or joining both occupies seats and, on a first
 *   accept, anchors the pool's pickup zone — either can make a ride that fit
 *   before not fit the pool as it now stands).
 *
 * ## D32 — `MATCHED` can be withdrawn
 *
 * When the last candidate disappears — the driver who was online goes offline, or
 * the pool fills, or the driver accepts a route a pending ride no longer shares —
 * the ride returns to `REQUESTED` ("waiting for a Tesla"). Keeping it `MATCHED`
 * would let the tracker say "finding your Tesla" about a Tesla that cannot be
 * found, which is exactly the "driver offline" empty state the PRD's P3 row asks
 * to distinguish from a genuine wait. Online is the definitionally reversible
 * case, so the transition is recorded in the audit trail on both journeys.
 *
 * ## Concurrency: every write is a compare-and-set
 *
 * `reconcile` decides a ride's desired state from what it read, then re-affirms
 * that read in the `WHERE` clause of the update. A concurrent claim (which is
 * also compare-and-set, D25) wins by moving the ride to `ACCEPTED` first; this
 * matcher's update then affects zero rows and it skips the ride without writing
 * a history row the audit trail cannot explain.
 *
 * ## Scale, honestly
 *
 * In a fleet these two queries become a real sweep — O(unassigned rides × online
 * Teslas) per event. The demo has one Tesla and a handful of rides; the sweep is
 * the point here, and a future phase can move it to a periodic batch without
 * changing what the status *means*. It is called inline today so the web UI sees
 * the two-step history written in the same request that caused it.
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(RideStatusHistory)
    private readonly historyRepository: Repository<RideStatusHistory>,
    @InjectRepository(Tesla)
    private readonly teslaRepository: Repository<Tesla>,
    @InjectRepository(Pool)
    private readonly poolRepository: Repository<Pool>,
    private readonly dataSource: DataSource,
    private readonly zoneService: ZoneService,
  ) {}

  /**
   * Brings every unassigned ride's status back in line with the candidates that
   * genuinely exist, then returns how many moved in each direction.
   *
   * Idempotent: a ride already holding its desired state is left untouched, and
   * a run where nothing changed writes nothing.
   */
  async reconcile(): Promise<{ promoted: number; demoted: number }> {
    const index = buildCorridorIndex(await this.zoneService.list());
    const outputs = await this.loadCandidateTeslas();

    const rides = await this.rideRepository.find({
      where: { status: In(CLAIMABLE_RIDE_STATUSES) },
      relations: { pickupZone: true, destinationZone: true },
    });

    const pending: { ride: Ride; from: RideStatus; to: RideStatus }[] = [];
    for (const ride of rides) {
      const request: MatchableRequest = {
        pickupZoneCode: ride.pickupZone.code,
        destinationZoneCode: ride.destinationZone.code,
      };

      const canServe = outputs.some(
        (tesla) =>
          tesla.openSeats >= ride.seatsRequested &&
          tesla.anchors.every((anchor) => canShare(anchor, request, index)),
      );

      const desired = canServe ? RideStatus.MATCHED : RideStatus.REQUESTED;

      if (desired !== ride.status) {
        pending.push({ ride, from: ride.status, to: desired });
      }
    }

    if (pending.length === 0) {
      return { promoted: 0, demoted: 0 };
    }

    let promoted = 0;
    let demoted = 0;

    await this.dataSource.transaction(async (manager) => {
      for (const move of pending) {
        const { affected } = await manager
          .getRepository(Ride)
          .update({ id: move.ride.id, status: move.from }, { status: move.to });

        // A concurrent claim (or another reconcile) moved the row first; that
        // writer owns the history for it.
        if (affected !== 1) {
          continue;
        }

        if (move.to === RideStatus.MATCHED) {
          promoted += 1;
        } else {
          demoted += 1;
        }

        await manager.getRepository(RideStatusHistory).save({
          ride: { id: move.ride.id } as Ride,
          fromStatus: move.from,
          toStatus: move.to,
        });
      }
    });

    if (demoted > 0) {
      this.logger.log(
        `${demoted} ride${demoted === 1 ? '' : 's'} returned to REQUESTED because no online Tesla can serve it`,
      );
    }

    return { promoted, demoted };
  }

  /**
   * Every online Tesla reduced to the two facts this rule reads: how many seats
   * are free, and which routes the pool (if one is open) is already anchored to.
   *
   * A Tesla with no open pool has no anchors, so it is a candidate for *any*
   * request — the Phase 3 feed's position (D27), unchanged by the pool that an
   * accept will set its pickup from.
   */
  private async loadCandidateTeslas(): Promise<
    { openSeats: number; anchors: MatchableRequest[] }[]
  > {
    const online = await this.teslaRepository.find({
      where: { availability: TeslaAvailability.ONLINE },
    });

    const outputs: { openSeats: number; anchors: MatchableRequest[] }[] = [];
    for (const tesla of online) {
      const pool = await this.poolRepository.findOne({
        where: {
          tesla: { id: tesla.id },
          status: In(OPEN_POOL_STATUSES),
        },
        relations: {
          memberships: {
            rideRequest: { pickupZone: true, destinationZone: true },
          },
        },
      });

      outputs.push({
        openSeats:
          pool === null
            ? tesla.capacity
            : Math.max(0, pool.seatCapacity - pool.occupiedSeats),
        anchors: (pool?.memberships ?? []).map((membership) => ({
          pickupZoneCode: membership.rideRequest.pickupZone.code,
          destinationZoneCode: membership.rideRequest.destinationZone.code,
        })),
      });
    }

    return outputs;
  }
}
