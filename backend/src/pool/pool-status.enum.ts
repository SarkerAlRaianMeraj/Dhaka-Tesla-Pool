/**
 * The lifecycle of a pool of seats on one Tesla.
 *
 * Four states are declared now because `pools.status` needs a CHECK vocabulary
 * from its first migration, and adding a state later costs a data migration
 * rather than one enum member. **Phase 4 writes only `FORMING`.**
 *
 * `FORMING` is the state a pool enters when the driver first accepts a request
 * and stays in for as long as passengers may still join — which, in Phase 4, is
 * the whole product. `ACTIVE` is the driver's explicit decision to stop taking
 * more passengers and arrive (PRD §5.3's `Arrive`), and `COMPLETED`/`CANCELLED`
 * close the pool with the trip.
 *
 * The distinction matters beyond bookkeeping: `uq_pools_active_tesla` is a
 * *partial* index covering only `FORMING` and `ACTIVE`, so a driver may start a
 * fresh pool the moment their last one closes, while still being unable to start
 * a second one while the first is open. The two sets have to agree, which is why
 * both this enum and the migration's vocabulary are spelled out rather than one
 * being derived from the other.
 */
export enum PoolStatus {
  FORMING = 'FORMING',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/**
 * The states that count as an *open* pool: one that holds seats and blocks the
 * driver from starting another.
 *
 * Used by the partial unique index in the migration and by the service when it
 * looks for the driver's current pool. Declared once here so the index and the
 * query cannot drift apart — a state added to the index but not to this list
 * would produce a pool the service never finds.
 */
export const OPEN_POOL_STATUSES: readonly PoolStatus[] = [
  PoolStatus.FORMING,
  PoolStatus.ACTIVE,
];

export const isOpenPoolStatus = (status: PoolStatus): boolean =>
  OPEN_POOL_STATUSES.includes(status);
