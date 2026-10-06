/**
 * The ride lifecycle, exactly as published in `PRD_Dhaka_Tesla_Pool.md` §5.2 and
 * §6.4.
 *
 * Phase 2 can only enter `REQUESTED` and `CANCELLED`; the intermediate states exist
 * here from the start so the column's CHECK constraint, the API's vocabulary, and
 * the audit trail all speak the same language from the first migration. Adding a
 * state later then costs one enum member rather than a data migration.
 */
export enum RideStatus {
  REQUESTED = 'REQUESTED',
  MATCHED = 'MATCHED',
  ACCEPTED = 'ACCEPTED',
  DRIVER_ARRIVED = 'DRIVER_ARRIVED',
  STARTED = 'STARTED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/**
 * The states a passenger may cancel from (PRD §6.4).
 *
 * `STARTED` is deliberately absent: once the trip is under way the passenger has
 * been picked up, and cancelling would strand the driver. `COMPLETED` and
 * `CANCELLED` are terminal and equally absent.
 */
export const CANCELLABLE_RIDE_STATUSES: readonly RideStatus[] = [
  RideStatus.REQUESTED,
  RideStatus.MATCHED,
  RideStatus.ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
];

export const isCancellableRideStatus = (status: RideStatus): boolean =>
  CANCELLABLE_RIDE_STATUSES.includes(status);

/**
 * The states a seat may be claimed from: a ride nobody has been assigned yet
 * (PRD §5.2 and §5.3).
 *
 * `MATCHED` means a Tesla was identified; `REQUESTED` means it has not, and a
 * driver may still accept such a ride because doing so is what creates the pool
 * (PRD §5.3 `D -> E -> G`). Both therefore admit a claim, and everything after
 * `ACCEPTED` does not — a second driver cannot claim a seat that is already held.
 *
 * Deliberately the complement of neither `CANCELLABLE` nor anything else: these
 * are three separate questions about a lifecycle, and collapsing them into one
 * shared list would make adding a state a change with four meanings.
 */
export const CLAIMABLE_RIDE_STATUSES: readonly RideStatus[] = [
  RideStatus.REQUESTED,
  RideStatus.MATCHED,
];

export const isClaimableRideStatus = (status: RideStatus): boolean =>
  CLAIMABLE_RIDE_STATUSES.includes(status);

/**
 * Plain-language labels for the passenger, per the messaging rules in PRD §5.6.
 *
 * A bare `DRIVER_ARRIVED` tells a passenger nothing about what to do next, which is
 * the whole complaint the tracker screen exists to fix.
 */
export const RIDE_STATUS_LABELS: Record<RideStatus, string> = {
  [RideStatus.REQUESTED]: 'Waiting for a Tesla',
  [RideStatus.MATCHED]: 'Finding your Tesla',
  [RideStatus.ACCEPTED]: 'Seat reserved, fare frozen',
  [RideStatus.DRIVER_ARRIVED]: 'Your driver has arrived',
  [RideStatus.STARTED]: 'On the way',
  [RideStatus.COMPLETED]: 'Completed',
  [RideStatus.CANCELLED]: 'Cancelled',
};
