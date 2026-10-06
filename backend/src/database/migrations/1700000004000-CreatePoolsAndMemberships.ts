import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 schema: the seats a Tesla is offering, and who holds them.
 *
 * ## Why capacity lives in two places
 *
 * `pools.seat_capacity` is a copy of `teslas.capacity` (D10), because a CHECK
 * constraint cannot reference another table. Without the copy, the ceiling PRD
 * §6.3 insists is "not merely checked in application code" would have nowhere to
 * live: `occupied_seats <= seat_capacity` needs both numbers on the same row.
 * The copy's drift risk is accepted because capacity is fixed at registration
 * (`US-D2`) and there is no update path that could lower it under passengers who
 * are already aboard.
 *
 * `ck_pools_not_overbooked` is therefore the belt to the claim transaction's
 * braces. The application lock is what makes concurrent claims *separate*; this
 * constraint is what makes an overbooking *impossible* even if a future code path
 * skips the lock. D13.
 *
 * ## Why the unique index is partial
 *
 * `uq_pools_active_tesla` covers only pools in `FORMING` or `ACTIVE`, so the rule
 * "one open pool per Tesla" is what the database enforces rather than "one pool
 * ever". A driver who completed Tuesday's trip may open another tonight, and the
 * closed row must not block them. The insert-then-retry in the claim path exists
 * precisely because this index can fire between two concurrent first accepts —
 * the loser re-reads and joins the winner's pool instead of creating a rival.
 *
 * ## Why nothing cascades into a membership
 *
 * Both foreign keys here are `RESTRICT`. `occupied_seats` is denormalised, so
 * deleting a pooled ride — or its pool — would leave a counter with no rows
 * behind it and a driver whose car can never fill again. A hard delete failing
 * loudly is strictly better than that. Cancelling does not touch this: PRD §6.4
 * makes cancellation a status change whose service code removes the membership
 * and returns the seat in the same transaction as the status write.
 *
 * The one non-obvious consequence is account deletion: deleting a passenger who
 * holds a seat would fail until their ride is dealt with. There is no delete
 * endpoint today, so nothing can hit this, and a future one meeting a loud
 * constraint is the intended outcome rather than an accident.
 *
 * As in Phases 2 and 3, the status vocabulary is duplicated rather than imported,
 * so the schema's history does not depend on application code's future.
 */
export class CreatePoolsAndMemberships1700000004000 implements MigrationInterface {
  name = 'CreatePoolsAndMemberships1700000004000';

  /** Mirrors `PoolStatus`. A closed pool must never block the next trip. */
  private static readonly OPEN_STATUSES = ['FORMING', 'ACTIVE'];

  /** Every state `pools.status` may hold, for the CHECK constraint. */
  private static readonly STATUSES = [
    'FORMING',
    'ACTIVE',
    'COMPLETED',
    'CANCELLED',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const inList = (values: readonly string[]): string =>
      values.map((value) => `'${value}'`).join(', ');

    await queryRunner.query(`
      CREATE TABLE "pools" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tesla_id" uuid NOT NULL,
        -- D10: a copy of teslas.capacity, kept on this row so the CHECK below
        -- has both numbers in one place.
        "seat_capacity" smallint NOT NULL,
        "occupied_seats" smallint NOT NULL DEFAULT 0,
        "status" varchar(20) NOT NULL DEFAULT 'FORMING',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_pools_status"
          CHECK ("status" IN (${inList(CreatePoolsAndMemberships1700000004000.STATUSES)})),
        -- Agrees with ck_teslas_capacity (1-3) and ck_ride_requests_seats (1-3).
        -- The three bounds have to match or a pool could be opened for a Tesla
        -- that cannot hold any single passenger.
        CONSTRAINT "ck_pools_capacity"
          CHECK ("seat_capacity" BETWEEN 1 AND 3),
        -- An occupancy below zero would mean a seat released twice, which is a
        -- bug worth catching at the row it corrupted.
        CONSTRAINT "ck_pools_occupied_floor"
          CHECK ("occupied_seats" >= 0),
        -- PRD §6.3 / SRS FR-C1, NFR-2: the database itself refuses to record
        -- more occupied seats than the vehicle can carry.
        CONSTRAINT "ck_pools_not_overbooked"
          CHECK ("occupied_seats" <= "seat_capacity"),
        -- A pool with no vehicle is not a pool anybody can drive.
        CONSTRAINT "fk_pools_tesla"
          FOREIGN KEY ("tesla_id") REFERENCES "teslas" ("id")
          ON DELETE CASCADE
      )
    `);

    // Partial on purpose: "one *open* pool per Tesla". The predicate is written
    // out rather than derived from the application's enum for the same reason
    // every other vocabulary here is duplicated - the constraint has to hold
    // regardless of what the code currently believes.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_pools_active_tesla" ON "pools" ("tesla_id")
      WHERE "status" IN (${inList(CreatePoolsAndMemberships1700000004000.OPEN_STATUSES)})
    `);

    // The partial index deliberately does not serve every pool of a Tesla: it
    // skips COMPLETED and CANCELLED rows. History reads ("what did this driver
    // carry last week?") need an index that does not.
    await queryRunner.query(`
      CREATE INDEX "idx_pools_tesla" ON "pools" ("tesla_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "pool_memberships" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pool_id" uuid NOT NULL,
        "ride_request_id" uuid NOT NULL,
        -- Frozen at assignment as base + distance, with no sharing discount
        -- yet (PRD §6.2 step 1). Recomputed for every member together at
        -- STARTED, when occupancy is final.
        "passenger_fare_poysha" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_pool_memberships_fare_non_negative"
          CHECK ("passenger_fare_poysha" >= 0),
        CONSTRAINT "fk_pool_memberships_pool"
          FOREIGN KEY ("pool_id") REFERENCES "pools" ("id")
          ON DELETE RESTRICT,
        CONSTRAINT "fk_pool_memberships_ride"
          FOREIGN KEY ("ride_request_id") REFERENCES "ride_requests" ("id")
          ON DELETE RESTRICT,
        -- US-R4, and the stronger of the two possible uniques: a ride holds a
        -- seat in at most one pool anywhere, not merely at most once per pool.
        CONSTRAINT "uq_pool_memberships_ride"
          UNIQUE ("ride_request_id")
      )
    `);

    // Serves the manifest's "who is aboard" read, which is ordered by join time.
    await queryRunner.query(`
      CREATE INDEX "idx_pool_memberships_pool" ON "pool_memberships" ("pool_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse dependency order: memberships block the pools they point at, and
    // pools block the teslas they point at.
    await queryRunner.query(`DROP TABLE IF EXISTS "pool_memberships"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pools"`);
  }
}
