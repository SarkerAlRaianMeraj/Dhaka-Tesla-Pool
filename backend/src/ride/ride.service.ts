import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  isCancellableRideStatus,
  RIDE_STATUS_LABELS,
  RideStatus,
} from '../common/enums/ride-status.enum';
import { ZoneService, ZoneView } from '../zone/zone.service';
import { MatchingService } from '../matching/matching.service';
import { PoolService } from '../pool/pool.service';
import { CreateRideRequestDto } from './dto/create-ride-request.dto';
import { QuoteRideDto } from './dto/quote-ride.dto';
import {
  BASE_FARE_POYSHA,
  distanceChargePoysha,
  estimateFare,
  manhattanDistanceKm,
} from './fare';
import { Ride } from './ride.entity';
import { RideStatusHistory } from './ride-status-history.entity';
import {
  QuoteView,
  RideStatusHistoryView,
  RideView,
  RideZoneView,
} from './ride.types';

/** Relations every read loads, because every screen shows zones and history. */
const READ_RELATIONS = {
  passenger: true,
  pickupZone: true,
  destinationZone: true,
  statusHistory: true,
};

@Injectable()
export class RideService {
  constructor(
    @InjectRepository(Ride) private readonly rideRepository: Repository<Ride>,
    @InjectRepository(RideStatusHistory)
    private readonly historyRepository: Repository<RideStatusHistory>,
    private readonly dataSource: DataSource,
    private readonly zoneService: ZoneService,
    // Whether a seat can be claimed is `PoolService`'s call (D13); joining hands
    // the ride over to the same single path that accepts for a driver.
    private readonly poolService: PoolService,
    // Whether a ride is `MATCHED` is recomputed after every write that can move
    // a candidate Tesla in or out of serving it.
    private readonly matchingService: MatchingService,
  ) {}

  /**
   * Prices a journey without creating anything (FR-P2.2).
   *
   * A separate endpoint rather than a dry-run flag on `POST /rides`, because the
   * quote is the most frequent call in the product: every change to the pickup or
   * destination select refires it. Making the read path incapable of writing is
   * stronger than trusting a parameter to stay false.
   */
  async quote(quoteRideDto: QuoteRideDto): Promise<QuoteView> {
    const { distanceKm } = await this.resolveJourney(quoteRideDto);
    const fare = estimateFare(distanceKm);

    return {
      distanceKm,
      baseFarePoysha: fare.baseFarePoysha,
      distanceChargePoysha: fare.distanceChargePoysha,
      poolDiscountPoysha: fare.poolDiscountPoysha,
      fareEstimatePoysha: fare.totalPoysha,
      // Always false: occupancy is unknown before a Tesla exists, so the estimate
      // shown here is the solo fare. See `fare.ts`.
      pooled: false,
    };
  }

  /**
   * Creates a request and records that fact (FR-P2.4, PRD §5.2 `D -> E -> F`).
   *
   * The ride and its first history row are written in one transaction. A ride with
   * no history row would render as a blank timeline and would look like a tracking
   * bug rather than a data problem, which is a much worse thing to debug later.
   *
   * The request starts in `REQUESTED` because that is the true answer to "has a
   * suitable Tesla been identified?" at the moment of its own insertion. The
   * matcher then runs (PRD's "< 60 s from request to MATCHED" is < 60 ms here),
   * and if an online Tesla can already carry it the returned ride reads
   * `MATCHED` — the two-step chain is written in the same request that caused it.
   */
  async createRequest(
    createRideRequestDto: CreateRideRequestDto,
    passengerId: string,
  ): Promise<RideView> {
    const { pickup, destination, distanceKm } =
      await this.resolveJourney(createRideRequestDto);

    const fare = estimateFare(distanceKm);

    const saved = await this.dataSource.transaction(async (manager) => {
      const ride = await manager.getRepository(Ride).save(
        manager.getRepository(Ride).create({
          passenger: { id: passengerId } as Ride['passenger'],
          pickupZone: { id: pickup.id } as Ride['pickupZone'],
          destinationZone: { id: destination.id } as Ride['destinationZone'],
          seatsRequested: createRideRequestDto.seatsRequested,
          distanceKm: distanceKm.toFixed(2),
          fareEstimatePoysha: fare.totalPoysha,
          status: RideStatus.REQUESTED,
        }),
      );

      await manager.getRepository(RideStatusHistory).save({
        ride: { id: ride.id } as Ride,
        fromStatus: null,
        toStatus: RideStatus.REQUESTED,
      });

      return ride;
    });

    await this.matchingService.reconcile();

    return this.findOneOwned(saved.id, passengerId);
  }

  /** The passenger's own rides, newest first (FR-P4.1, FR-P5.2). */
  async listMine(passengerId: string): Promise<RideView[]> {
    const rides = await this.rideRepository.find({
      where: { passenger: { id: passengerId } },
      relations: READ_RELATIONS,
      order: { createdAt: 'DESC' },
    });

    return rides.map((ride) => this.toView(ride));
  }

  /**
   * One ride, if the caller owns it (FR-P4.2).
   *
   * Another passenger's ride is a 404, not a 403 (NFR-1). A 403 would confirm the
   * ride exists, which is exactly the existence leak the brief rules out, and the
   * ids are UUIDs only by luck — sequential ones would turn this into an enumeration.
   */
  async findOneOwned(rideId: string, passengerId: string): Promise<RideView> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId, passenger: { id: passengerId } },
      relations: READ_RELATIONS,
      order: { statusHistory: { changedAt: 'ASC' } },
    });

    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }

    return this.toView(ride);
  }

  /**
   * Cancels a ride the caller owns (FR-P4.3, PRD §6.4).
   *
   * Refused once the trip has started: the passenger is already in the vehicle, and
   * the driver has driven to collect them. Cancelling at that point would strand
   * both of them.
   *
   * If the ride holds a seat in a pool, the seat returns to the pool and the pool
   * total is recomputed (PRD §6.4). Both happen in the same transaction as the
   * status write, with the pool lock taken before the ride's (D13) — so a
   * cancellation and a concurrent claim of the seat it frees can never both think
   * they worked.
   *
   * The transition is a compare-and-set rather than a checked write. Two taps on
   * "cancel" can arrive at once, and reading the status first and then writing it
   * would let both observe `REQUESTED` and both commit, leaving two
   * `REQUESTED -> CANCELLED` rows in an audit trail that exists to be
   * reconstructable (NFR-3). Deciding inside the `WHERE` clause hands the decision
   * to the database: Postgres locks the row for the second writer and re-evaluates
   * the predicate against the committed row, so the loser updates nothing and is
   * told the current status. No pessimistic lock is needed for this (D25).
   */
  async cancel(rideId: string, passengerId: string): Promise<RideView> {
    const ride = await this.findOwnedEntity(rideId, passengerId);

    if (!isCancellableRideStatus(ride.status)) {
      throw this.cancellationConflict(ride.status);
    }

    const fromStatus = ride.status;

    await this.dataSource.transaction(async (manager) => {
      // D13: the pool is locked before the ride is written. Discovering whether
      // a seat exists is a read; only when one does is the pool locked, and the
      // comparison against the ride must not run until the pool is held.
      const membership = await this.poolService.lockRidePool(manager, ride.id);

      const { affected } = await manager
        .getRepository(Ride)
        .update(
          { id: ride.id, status: fromStatus },
          { status: RideStatus.CANCELLED },
        );

      if (affected !== 1) {
        // The row no longer holds the status validated a moment ago, so a
        // concurrent cancel (or a driver transition) won. Re-read rather than
        // report a stale reason, so the message names the real current state.
        const current = await manager
          .getRepository(Ride)
          .findOne({ where: { id: ride.id } });

        throw this.cancellationConflict(
          current?.status ?? RideStatus.CANCELLED,
        );
      }

      // The seat returns to the pool only now, when the cancellation is a fact
      // this transaction has committed to — a status write that later failed must
      // not have already given the seat away (PRD §6.4).
      if (membership !== null) {
        await this.poolService.releaseSeat(
          manager,
          membership,
          ride.seatsRequested,
        );
      }

      await manager.getRepository(RideStatusHistory).save({
        ride: { id: ride.id } as Ride,
        fromStatus,
        toStatus: RideStatus.CANCELLED,
      });
    });

    // The freed seats may push an unassigned request back up to `MATCHED`
    // (a candidate that was full now fits), so the payback is reconciled too.
    await this.matchingService.reconcile();

    return this.findOneOwned(ride.id, passengerId);
  }

  /**
   * Joins the caller's ride to an open pool sharing their route (PRD A2, D7:
   * passengers join without per-join driver approval).
   *
   * The server resolves the pool, because there is nothing in a request a
   * passenger could use to name one — and an endpoint that accepted a pool id
   * would let a passenger join a pool whose riders they do not fit. `PoolService`
   * performs the same locked claim as a driver's accept, so a passenger and a
   * driver racing for the same last seat go through the same decision.
   */
  async joinPool(rideId: string, passengerId: string): Promise<RideView> {
    await this.poolService.joinForPassenger(rideId, passengerId);
    // A join occupies a seat, which may drop other unassigned rides below the
    // fleet's remaining capacity; the matcher re-runs so `MATCHED` stays true.
    await this.matchingService.reconcile();
    return this.findOneOwned(rideId, passengerId);
  }

  /**
   * The single wording for a refused cancellation.
   *
   * Shared by the upfront check and the race path so the two cannot drift apart
   * and start describing the same refusal in two different ways.
   */
  private cancellationConflict(status: RideStatus): ConflictException {
    return new ConflictException(
      status === RideStatus.STARTED
        ? 'This ride has already started and can no longer be cancelled'
        : `This ride is ${RIDE_STATUS_LABELS[status]} and can no longer be cancelled`,
    );
  }

  /**
   * Validates a journey's zones and measures it.
   *
   * Both the preview and the request go through here, so a price can never be shown
   * for a combination the server would then refuse to create.
   */
  private async resolveJourney(dto: QuoteRideDto): Promise<{
    pickup: ZoneView;
    destination: ZoneView;
    distanceKm: number;
  }> {
    const [pickup, destination] = await this.zoneService.requireByCodes([
      dto.pickupZoneCode,
      dto.destinationZoneCode,
    ]);

    if (pickup.id === destination.id) {
      throw new BadRequestException(
        'Pickup and destination must be different zones',
      );
    }

    return {
      pickup,
      destination,
      distanceKm: manhattanDistanceKm(pickup, destination),
    };
  }

  private async findOwnedEntity(
    rideId: string,
    passengerId: string,
  ): Promise<Ride> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId, passenger: { id: passengerId } },
    });

    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }

    return ride;
  }

  /**
   * Maps a ride to what the passenger is shown.
   *
   * `distanceChargePoysha` is recomputed from the stored distance rather than stored
   * a second time. It is a pure function of `distance_km`, so a second column could
   * only ever disagree with the first; the stored estimate stays authoritative
   * because it is what the passenger was actually shown.
   */
  private toView(ride: Ride): RideView {
    const distanceKm = Number(ride.distanceKm);
    const history = [...ride.statusHistory].sort(
      (left, right) => left.changedAt.getTime() - right.changedAt.getTime(),
    );

    return {
      id: ride.id,
      passengerId: ride.passenger.id,
      pickupZone: this.toZoneView(ride.pickupZone),
      destinationZone: this.toZoneView(ride.destinationZone),
      seatsRequested: ride.seatsRequested,
      distanceKm,
      baseFarePoysha: BASE_FARE_POYSHA,
      distanceChargePoysha: distanceChargePoysha(distanceKm),
      fareEstimatePoysha: ride.fareEstimatePoysha,
      status: ride.status,
      statusLabel: RIDE_STATUS_LABELS[ride.status],
      cancellable: isCancellableRideStatus(ride.status),
      statusHistory: history.map((entry): RideStatusHistoryView => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        statusLabel: RIDE_STATUS_LABELS[entry.toStatus],
        changedAt: entry.changedAt,
      })),
      createdAt: ride.createdAt,
      updatedAt: ride.updatedAt,
    };
  }

  /**
   * Maps a zone reached through a ride's foreign key.
   *
   * `numeric` columns arrive as strings, so the grid coordinates are converted here
   * rather than being handed to the fare rule as `"3.0"`. That conversion is the
   * only reason this mapper exists — `ZoneService` already has its own, and it
   * loads the corridor join that a ride does not need.
   */
  private toZoneView(zone: Ride['pickupZone']): RideZoneView {
    return {
      id: zone.id,
      code: zone.code,
      name: zone.name,
      xKm: Number(zone.xKm),
      yKm: Number(zone.yKm),
    };
  }
}
