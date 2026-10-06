import { PoolStatus } from './pool-status.enum';

/**
 * The driver's view of who is aboard (PRD D4).
 *
 * Deliberately **not** carrying any per-passenger fare. PRD §6.5 lets the driver
 * see names, seats, and the *pool total* — the wireframe in §5.5 D4 shows exactly
 * those three and no individual price — because a figure one passenger paid is
 * not the driver's to compare against another's. The total is enough to know what
 * the trip is worth, and it is the only money on this view.
 */
export type PoolManifestView = {
  poolId: string;
  plate: string;
  model: string;
  status: PoolStatus;
  seatCapacity: number;
  occupiedSeats: number;
  /** `seatCapacity - occupiedSeats`, computed here so no screen does arithmetic. */
  openSeats: number;
  members: PoolMemberView[];
  /** Sum of every member's frozen fare, which is what PRD D4 calls the pool total. */
  poolTotalPoysha: number;
};

/** One seat held by one passenger. No fare, by PRD §6.5. */
export type PoolMemberView = {
  membershipId: string;
  rideId: string;
  passengerName: string;
  seats: number;
  pickupZoneName: string;
  destinationZoneName: string;
  joinedAt: Date;
};

/**
 * The manifest, or an explicit `null` when there is no open pool.
 *
 * An envelope rather than a 404, for the reason `MyTeslaView` is one: "you have
 * not accepted anyone yet" is the ordinary state of a driver who just signed in,
 * not a missing resource, and a page treating it as an error would show "could
 * not load" on the screen whose job is to say "no passengers yet" (D4, D28).
 */
export type MyPoolView = {
  pool: PoolManifestView | null;
};
