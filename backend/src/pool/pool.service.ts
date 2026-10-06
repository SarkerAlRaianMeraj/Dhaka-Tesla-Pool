import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  isClaimableRideStatus,
  RideStatus,
} from '../common/enums/ride-status.enum';
import { Ride } from '../ride/ride.entity';
import { RideStatusHistory } from '../ride/ride-status-history.entity';
import { Tesla } from '../tesla/tesla.entity';
import {
  buildCorridorIndex,
  canShare,
  MatchableRequest,
} from '../tesla/matching';
import { ZoneService } from '../zone/zone.service';
import { PoolMembership } from './pool-membership.entity';
import { OPEN_POOL_STATUSES } from './pool-status.enum';
import { Pool } from './pool.entity';
import { MyPoolView, PoolManifestView, PoolMemberView } from './pool.types';

/**
 * The one place a seat is taken or given back (PRD §6.3, SRS FR-C1/NFR-2).
 *
 * ## Why everything here is one function
 *
 * D13: every read and write of `pools`, `pool_memberships`, and the ride's status
 * goes through this service and through a single transaction manager. Splitting
 * the claim across an "accept" service and a "join" service would give two places
 * that decide capacity, and two places that decide capacity is how two callers
 * both believe they held the last seat.
 *
 * `acceptForDriver` and `joinForPassenger` differ only in how the pool is
 * *resolved* — a driver creates theirs, a passenger finds one — and then share
 * `claim`.
 *
 * ## Lock order
 *
 * D13 fixes it: **the pool row, then the ride request.** Every path obeys it, and
 * pools are always taken in ascending `id` order when more than one is a
 * candidate, so no two transactions can each wait for the other's pool.
 *
 * PRD §5.4 shows the sequence directly: `BEGIN; SELECT pool FOR UPDATE` (the
 * second claimant waits), then the membership and the counter together, then the
 * loser re-reads and is refused.
 *
 * ## What makes overbooking impossible
 *
 * Two independent things, deliberately both present:
 *
 * 1. `assertCapacity` runs *under the pool lock*, so it produces a 409 with
 *    readable copy rather than a constraint error the caller cannot act on.
 * 2. `ck_pools_not_overbooked` refuses the write outright if (1) is ever skipped
 *    by a future code path — which is what PRD §6.3 means by "not merely checked
 *    in application code".
 *
 * Because (1) runs first, (2) is unreachable in correct operation. That is the
 * point: a test asserting a clean 409 proves the application check ran, while the
 * constraint stands ready to catch the version of this file that forgets to.
 *
 * ## Why the pool is opened with `ON CONFLICT` rather than a caught exception
 *
 * A caught unique violation aborts the Postgres transaction it happened in, so
 * "insert, catch `23505`, re-read" would leave nowhere to continue. `ON CONFLICT
 * DO NOTHING ... RETURNING` resolves the race atomically and returns nothing on
 * conflict, so the loser simply reads the winner's row and waits for its lock —
 * which is exactly the wait PRD §5.4 draws.
 */
@Injectable()
export class PoolService {
  /** PRD §5.6 / E1: name the cause and offer retry. Never a spinner or a generic failure. */
  static readonly LAST_SEAT_TAKEN =
    'That Tesla is full — its last seat went to another passenger. Try again.';

  /** PRD §6.1 stated back at the caller when two requests may not share. */
  static readonly CANNOT_SHARE =
    'These requests cannot share a Tesla: the pickup zones must be identical and the destinations must share a corridor';

  /** Joining needs a pool that already exists — PRD §5.3 opens one on accept. */
  static readonly NO_OPEN_POOL =
    'No pool is open on your route yet. Wait for a driver to accept, then try again.';

  /** PRD §5.6 / E2, driver-facing half. The passenger's copy lives on the ride. */
  static readonly CANNOT_GO_OFFLINE =
    'You still have assigned passengers on your Tesla. Complete the trip before going offline.';

  constructor(
    @InjectRepository(Pool)
    private readonly poolRepository: Repository<Pool>,
    @InjectRepository(PoolMembership)
    private readonly membershipRepository: Repository<PoolMembership>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly dataSource: DataSource,
    private readonly zoneService: ZoneService,
  ) {}

  /**
   * Opens or joins the driver's pool and holds a seat for `rideId` (FR-D4,
   * US-D4, PRD §5.3 `E -> G`).
   *
   * 201 semantics belong to the caller; this returns the manifest, because what
   * a driver wants immediately after accepting is "who is aboard now" (D4).
   */
  async acceptForDriver(
    tesla: Tesla,
    rideId: string,
  ): Promise<PoolManifestView> {
    await this.dataSource.transaction((manager) =>
      this.claim(manager, rideId, {
        mode: 'driver-accept',
        teslaId: tesla.id,
        seatCapacity: tesla.capacity,
      }),
    );

    // Re-read outside the transaction so the manifest reflects the commit rather
    // than the transaction manager's own snapshot.
    return this.requireManifest(tesla.id);
  }

  /**
   * Holds a seat for the caller's own ride in an existing open pool (PRD A2,
   * D7: no per-join driver approval).
   *
   * The passenger does not name a pool. There is nothing to choose between that
   * a passenger could see — who is driving is not part of the request — so the
   * server resolves it, which also means a passenger cannot join a pool they
   * happen to know the id of but do not fit.
   */
  async joinForPassenger(rideId: string, passengerId: string): Promise<void> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId, passenger: { id: passengerId } },
    });

    // Another passenger's ride is a 404, not a 403 (NFR-1): a 403 would confirm
    // the id exists, which is the existence leak `findOneOwned` already avoids.
    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }

    await this.dataSource.transaction((manager) =>
      this.claim(manager, rideId, { mode: 'passenger-join' }),
    );
  }

  /**
   * The driver's manifest, or `null` when they have no open pool (D4, D28).
   *
   * `teslaId` rather than the whole entity: every caller here already resolved
   * the Tesla through `TeslaService`, and taking only what is used keeps this
   * service independent of how that resolution happened.
   */
  async getManifest(teslaId: string): Promise<MyPoolView> {
    const pool = await this.poolRepository.findOne({
      where: { tesla: { id: teslaId }, status: In(OPEN_POOL_STATUSES) },
      order: { createdAt: 'DESC' },
    });

    return { pool: pool === null ? null : await this.buildManifest(pool.id) };
  }

  private async requireManifest(teslaId: string): Promise<PoolManifestView> {
    const { pool } = await this.getManifest(teslaId);
    if (pool === null) {
      // Unreachable: the claim just created or used an open pool. Held as an
      // invariant rather than typed away, because a silently missing manifest
      // would render as an empty car to a driver who just accepted somebody.
      throw new ConflictException('The pool could not be read after claiming');
    }
    return pool;
  }

  /**
   * Does this driver still owe a ride? (PRD §5.6 / E2)
   *
   * Read rather than inferred from availability: the assignment lives on the
   * membership, so a driver who went offline and came back still owes the same
   * trip, and availability never describes work already taken.
   */
  async hasAssignedPassengers(teslaId: string): Promise<boolean> {
    const openPool = await this.poolRepository.findOne({
      where: { tesla: { id: teslaId }, status: In(OPEN_POOL_STATUSES) },
    });

    if (openPool === null) {
      return false;
    }

    const memberships = await this.membershipRepository.count({
      where: { pool: { id: openPool.id } },
    });

    return memberships > 0;
  }

  /**
   * **D13, half one — call this before touching the ride.**
   *
   * Finds the membership this ride already holds and locks its pool, so a
   * cancellation and a claim cannot both be adjusting `occupied_seats` at once.
   * Returns `null` for a ride that holds no seat, which is the common case and
   * needs no lock at all.
   *
   * Split from `releaseSeat` because the ordering has to be visible at the call
   * site: the lock must precede the ride's status write, and the seat must be
   * returned only after that write has succeeded. A single method called at the
   * wrong point in `RideService.cancel` would silently invert both.
   */
  async lockRidePool(
    manager: EntityManager,
    rideId: string,
  ): Promise<PoolMembership | null> {
    const membership = await manager.getRepository(PoolMembership).findOne({
      where: { rideRequest: { id: rideId } },
      relations: { pool: true },
    });

    if (membership === null) {
      return null;
    }

    await this.lockPoolRow(manager, membership.pool.id);
    return membership;
  }

  /**
   * **D13, half two — call this after the ride is `CANCELLED`.**
   *
   * Removes the membership and gives the seat back (PRD §6.4: "the seat returns
   * to the pool and the pool total is recomputed"). The counter moves by the same
   * number of seats the claim added, and only inside a transaction that already
   * holds the pool lock from `lockRidePool`.
   *
   * `ck_pools_occupied_floor` is the backstop here rather than a friendly
   * message: releasing more than was held is not something a user can cause, so
   * it is a bug and should surface as one.
   */
  async releaseSeat(
    manager: EntityManager,
    membership: PoolMembership,
    seats: number,
  ): Promise<void> {
    const pool = await manager.getRepository(Pool).findOne({
      where: { id: membership.pool.id },
    });
    if (pool === null) {
      throw new ConflictException(
        'The pool holding this seat no longer exists',
      );
    }

    await manager.getRepository(PoolMembership).delete({ id: membership.id });

    await manager
      .getRepository(Pool)
      .update(
        { id: pool.id, occupiedSeats: pool.occupiedSeats },
        { occupiedSeats: pool.occupiedSeats - seats },
      );
  }

  // ---------------------------------------------------------------- claims

  /**
   * The single claim path. Both public entry points end here.
   *
   * Order is D13, without exception: resolve and lock the pool, lock the ride,
   * then validate against state that can no longer move.
   */
  private async claim(
    manager: EntityManager,
    rideId: string,
    source:
      | { mode: 'driver-accept'; teslaId: string; seatCapacity: number }
      | { mode: 'passenger-join' },
  ): Promise<void> {
    const pool = await this.resolvePool(manager, source);
    const lockedPool = await this.lockPoolRow(manager, pool.id);

    const ride = await this.lockRideRow(manager, rideId);
    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }
    PoolService.assertClaimable(ride);

    const request = await this.loadRequest(manager, rideId);
    const members = await this.loadMembers(manager, lockedPool.id);
    PoolService.assertCompatible(request, members, await this.corridorIndex());

    const seats = request.seatsRequested;
    PoolService.assertCapacity(lockedPool, seats);

    await manager.getRepository(PoolMembership).save(
      manager.getRepository(PoolMembership).create({
        pool: { id: lockedPool.id } as PoolMembership['pool'],
        rideRequest: { id: rideId } as PoolMembership['rideRequest'],
        // Frozen as base + distance with no discount, because occupancy is not
        // final until the trip starts (PRD §6.2 step 1). The stored estimate is
        // already exactly that figure and is what the passenger was shown.
        passengerFarePoysha: Number(ride.fareEstimatePoysha),
      }),
    );

    // Compare-and-set on the counter itself, so the write verifies what it read
    // under the lock rather than trusting it (D25). Under the lock this cannot
    // lose — if it ever does, the caller hears "full" rather than a 500.
    const { affected } = await manager
      .getRepository(Pool)
      .update(
        { id: lockedPool.id, occupiedSeats: lockedPool.occupiedSeats },
        { occupiedSeats: lockedPool.occupiedSeats + seats },
      );
    if (affected !== 1) {
      throw new ConflictException(PoolService.LAST_SEAT_TAKEN);
    }

    const { affected: rideUpdated } = await manager
      .getRepository(Ride)
      .update(
        { id: rideId, status: ride.status },
        { status: RideStatus.ACCEPTED },
      );
    if (rideUpdated !== 1) {
      // The row moved between the lock and this write, which the lock exists to
      // make impossible. Re-read rather than report a stale reason.
      const current = await manager
        .getRepository(Ride)
        .findOne({ where: { id: rideId } });
      throw PoolService.explainUnclaimable(current?.status ?? ride.status);
    }

    await manager.getRepository(RideStatusHistory).save(
      manager.getRepository(RideStatusHistory).create({
        ride: { id: rideId } as Ride,
        fromStatus: ride.status,
        toStatus: RideStatus.ACCEPTED,
      }),
    );
  }

  /**
   * Finds or opens the pool this claim belongs to, **before** it is locked.
   *
   * A driver's first accept opens one; every later accept and every passenger
   * join finds it. The passenger path only ever finds: PRD §5.3 opens a pool on
   * accept, so there is nothing for a joining passenger to create.
   */
  private async resolvePool(
    manager: EntityManager,
    source:
      | { mode: 'driver-accept'; teslaId: string; seatCapacity: number }
      | { mode: 'passenger-join' },
  ): Promise<Pool> {
    if (source.mode === 'passenger-join') {
      const candidates = await manager.getRepository(Pool).find({
        where: { status: In(OPEN_POOL_STATUSES) },
        // Ascending id everywhere a transaction has a choice of pools, so two
        // claims can never each lock the pool the other holds (D13).
        order: { id: 'ASC' },
      });

      if (candidates.length === 0) {
        throw new ConflictException(PoolService.NO_OPEN_POOL);
      }

      return candidates[0];
    }

    // One path rather than "look, then insert, then catch": a caught unique
    // violation would abort the transaction. `ON CONFLICT` resolves the race
    // against `uq_pools_active_tesla` atomically and answers with nothing when
    // somebody else's pool won, which is when we read theirs.
    const created = await manager.query<{ id: string }[]>(
      `INSERT INTO "pools" ("tesla_id", "seat_capacity")
       VALUES ($1, $2)
       ON CONFLICT ("tesla_id") WHERE "status" IN ('FORMING', 'ACTIVE')
       DO NOTHING
       RETURNING "id"`,
      [source.teslaId, source.seatCapacity],
    );

    if (created.length > 0) {
      return manager.getRepository(Pool).findOneByOrFail({ id: created[0].id });
    }

    const existing = await manager.getRepository(Pool).findOne({
      where: { tesla: { id: source.teslaId }, status: In(OPEN_POOL_STATUSES) },
    });
    if (existing === null) {
      throw new ConflictException('Could not open a pool on your Tesla');
    }
    return existing;
  }

  /**
   * `SELECT ... FOR UPDATE` on the pool row.
   *
   * **No relations joined, deliberately.** TypeORM would emit `FOR UPDATE` across
   * an outer join, which Postgres refuses on the nullable side. Whatever needs
   * relating is loaded by a second, unlocked query — reference data or rows this
   * transaction is about to write anyway.
   */
  private async lockPoolRow(
    manager: EntityManager,
    poolId: string,
  ): Promise<Pool> {
    const pool = await manager.getRepository(Pool).findOne({
      where: { id: poolId },
      lock: { mode: 'pessimistic_write' },
    });

    if (pool === null) {
      // The pool disappeared between resolving it and locking it, which needs
      // both a concurrent delete and this transaction to have begun — and no
      // endpoint deletes a pool.
      throw new ConflictException('That pool no longer exists');
    }

    return pool;
  }

  /** `SELECT ... FOR UPDATE` on the ride, for the same reason as `lockPoolRow`. */
  private async lockRideRow(
    manager: EntityManager,
    rideId: string,
  ): Promise<Ride> {
    const ride = await manager.getRepository(Ride).findOne({
      where: { id: rideId },
      lock: { mode: 'pessimistic_write' },
    });

    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }

    return ride;
  }

  private static assertClaimable(ride: Ride): void {
    if (!isClaimableRideStatus(ride.status)) {
      throw PoolService.explainUnclaimable(ride.status);
    }
  }

  private static explainUnclaimable(status: RideStatus): ConflictException {
    if (status === RideStatus.CANCELLED) {
      return new ConflictException(
        'This ride was cancelled and cannot claim a seat',
      );
    }
    if (status === RideStatus.COMPLETED) {
      return new ConflictException(
        'This ride is already complete and cannot claim a seat',
      );
    }
    // ACCEPTED, DRIVER_ARRIVED or STARTED: somebody holds this seat already.
    return new ConflictException('This ride already holds a seat');
  }

  /**
   * PRD §6.1, applied against every member already aboard.
   *
   * Every member, not merely the first incompatible one a convenient query might
   * surface: the rule is pairwise over the whole pool, and a pool where any pair
   * is incompatible is one that should never have formed.
   */
  private static assertCompatible(
    request: MatchableRequest,
    members: PoolMembership[],
    index: ReturnType<typeof buildCorridorIndex>,
  ): void {
    for (const member of members) {
      const other: MatchableRequest = {
        pickupZoneCode: member.rideRequest.pickupZone.code,
        destinationZoneCode: member.rideRequest.destinationZone.code,
      };

      if (!canShare(request, other, index)) {
        throw new ConflictException(PoolService.CANNOT_SHARE);
      }
    }
  }

  /**
   * The capacity decision, under the lock (PRD §6.3, SRS FR-R2).
   *
   * Seats asked for rather than "one", because a request may legitimately hold
   * two or three seats and a pool with one seat free must refuse it. The message
   * is E1 whatever the arithmetic, since the caller cannot tell a race from a
   * stale feed and PRD §5.6 wants the same copy for both.
   */
  private static assertCapacity(pool: Pool, seats: number): void {
    if (pool.occupiedSeats + seats > pool.seatCapacity) {
      throw new ConflictException(PoolService.LAST_SEAT_TAKEN);
    }
  }

  // ------------------------------------------------------------------ reads

  private async corridorIndex(): Promise<
    ReturnType<typeof buildCorridorIndex>
  > {
    // Built per claim rather than cached: the feed is the hot path, and this
    // runs once per claim, not once per pair. `ZoneService` caches its rows, so
    // the cost is inverting eight zones, not in a query.
    return buildCorridorIndex(await this.zoneService.list());
  }

  /** Zones for one ride, after it has been locked, as a bare matching request. */
  private async loadRequest(
    manager: EntityManager,
    rideId: string,
  ): Promise<MatchableRequest & { seatsRequested: number }> {
    const ride = await manager.getRepository(Ride).findOne({
      where: { id: rideId },
      relations: { pickupZone: true, destinationZone: true },
    });

    if (ride === null) {
      throw new NotFoundException(`Ride ${rideId} was not found`);
    }

    return {
      pickupZoneCode: ride.pickupZone.code,
      destinationZoneCode: ride.destinationZone.code,
      seatsRequested: ride.seatsRequested,
    };
  }

  /** Who is aboard, in join order, with what they need to be shown. */
  private async loadMembers(
    manager: EntityManager,
    poolId: string,
  ): Promise<PoolMembership[]> {
    return manager.getRepository(PoolMembership).find({
      where: { pool: { id: poolId } },
      relations: {
        rideRequest: { pickupZone: true, destinationZone: true },
      },
      order: { createdAt: 'ASC' },
    });
  }

  /** Assembles PRD D4. No per-passenger fare, per §6.5. */
  private async buildManifest(poolId: string): Promise<PoolManifestView> {
    const pool = await this.poolRepository.findOne({
      where: { id: poolId },
      relations: { tesla: true },
    });

    if (pool === null) {
      throw new NotFoundException('That pool no longer exists');
    }

    const rows = await this.membershipRepository.find({
      where: { pool: { id: poolId } },
      relations: {
        rideRequest: {
          passenger: true,
          pickupZone: true,
          destinationZone: true,
        },
      },
      order: { createdAt: 'ASC' },
    });

    const members: PoolMemberView[] = rows.map((row) => ({
      membershipId: row.id,
      rideId: row.rideRequest.id,
      passengerName: row.rideRequest.passenger.name,
      seats: row.rideRequest.seatsRequested,
      pickupZoneName: row.rideRequest.pickupZone.name,
      destinationZoneName: row.rideRequest.destinationZone.name,
      joinedAt: row.createdAt,
    }));

    return {
      poolId: pool.id,
      plate: pool.tesla.plate,
      model: pool.tesla.model,
      status: pool.status,
      seatCapacity: pool.seatCapacity,
      occupiedSeats: pool.occupiedSeats,
      openSeats: Math.max(0, pool.seatCapacity - pool.occupiedSeats),
      members,
      // The only money on this view (PRD §6.5): the sum of frozen fares, which
      // is what §5.5 D4 calls the pool total.
      poolTotalPoysha: rows.reduce(
        (total, row) => total + row.passengerFarePoysha,
        0,
      ),
    };
  }
}
