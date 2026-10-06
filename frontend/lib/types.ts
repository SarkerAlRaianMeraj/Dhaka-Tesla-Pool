export type Role = "passenger" | "driver";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  teslaPayBalancePoysha: number;
};

/** The login response body carries no token - it travels in an httpOnly cookie. */
export type LoginResponse = {
  message: string;
  expiresInSeconds: number;
  user: SessionUser;
};

export type RegisterResponse = {
  message: string;
  user: SessionUser;
};

export type Zone = {
  id: string;
  code: string;
  name: string;
  xKm: number;
  yKm: number;
  corridors: { code: string; name: string }[];
};

/**
 * The ride lifecycle, mirroring the API's `RideStatus` enum.
 *
 * The union is written out rather than derived from the API response so a typo in
 * a status is a compile error here instead of an unstyled badge at runtime. The
 * full set is present even though Phase 2 only enters `REQUESTED` and `CANCELLED`,
 * because matching arrives in Phase 3 and the values already exist server-side.
 */
export type RideStatus =
  | "REQUESTED"
  | "MATCHED"
  | "ACCEPTED"
  | "DRIVER_ARRIVED"
  | "STARTED"
  | "COMPLETED"
  | "CANCELLED";

/**
 * A zone as it appears inside a ride.
 *
 * Distinct from `Zone` because the API omits `corridors` here; no screen in Phase 2
 * shows a ride's corridors, and typing them as present would invite reading
 * `undefined.length` into a crash.
 */
export type RideZone = Omit<Zone, "corridors">;

/**
 * A fare preview. Every field is shown to the passenger before they commit
 * (FR-F1), and the breakdown is kept in the response so the screen can render the
 * same lines again on the detail page without recomputing anything.
 */
export type RideQuote = {
  distanceKm: number;
  baseFarePoysha: number;
  distanceChargePoysha: number;
  poolDiscountPoysha: number;
  fareEstimatePoysha: number;
  /** Always false in Phase 2: no Tesla exists yet when a request is priced. */
  pooled: boolean;
};

export type RideStatusHistoryEntry = {
  id: string;
  fromStatus: RideStatus | null;
  toStatus: RideStatus;
  statusLabel: string;
  changedAt: string;
};

export type Ride = {
  id: string;
  passengerId: string;
  pickupZone: RideZone;
  destinationZone: RideZone;
  seatsRequested: number;
  distanceKm: number;
  baseFarePoysha: number;
  distanceChargePoysha: number;
  fareEstimatePoysha: number;
  status: RideStatus;
  /** Plain-language status from the API; never render the raw enum to a passenger. */
  statusLabel: string;
  /** The API decides this, so the cancel button matches what will actually work. */
  cancellable: boolean;
  statusHistory: RideStatusHistoryEntry[];
  createdAt: string;
  updatedAt: string;
};

/**
 * Whether a driver's Tesla is offering rides, mirroring the API's
 * `TeslaAvailability`. Two states only, and Phase 3 needs no more: a driver who
 * goes offline mid-trip still owes that ride, so availability governs new requests
 * and never assignments already made.
 */
export type TeslaAvailability = "OFFLINE" | "ONLINE";

/**
 * The driver's own Tesla (FR-D3.1).
 *
 * `capacity` is fixed at registration (US-D2) and is returned on every read so the
 * summary screen shows the same number Phase 4 reasons about, rather than a copy
 * the browser remembers from form state.
 */
export type Tesla = {
  id: string;
  plate: string;
  model: string;
  capacity: number;
  availability: TeslaAvailability;
  createdAt: string;
  updatedAt: string;
};

/**
 * `GET /tesla/me` always answers 200 and wraps the empty case as `tesla: null`.
 *
 * The envelope exists because of what the API does *not* send: a bare `null` return
 * reaches the browser as a zero-length body, so `response.data` is `undefined` and
 * "nothing registered" is indistinguishable from "no payload". Reading
 * `data.tesla` rather than `data` keeps that distinction explicit.
 */
export type MyTesla = {
  tesla: Tesla | null;
};

/**
 * One open request in a driver's feed (FR-D3.3, FR-M2).
 *
 * No passenger identity, and none is missed: this is a broadcast of open requests,
 * so naming the passenger would turn the feed into a directory of who wants a ride
 * where. Zone names are carried alongside codes so the row can be read without a
 * second lookup.
 */
export type MatchableRide = {
  id: string;
  pickupZoneCode: string;
  pickupZoneName: string;
  destinationZoneCode: string;
  destinationZoneName: string;
  seatsRequested: number;
  fareEstimatePoysha: number;
  status: RideStatus;
  /** Always true: what survives the feed's filters is by construction carryable (D27). */
  matchable: boolean;
  createdAt: string;
};

/**
 * One passenger holding a seat in a Tesla's pool (PRD D4).
 *
 * Deliberately no fare: the manifest shows names, seats, and the pool total — a
 * figure one passenger paid is not the driver's to compare against another's (PRD
 * §6.5).
 */
export type PoolMember = {
  membershipId: string;
  rideId: string;
  passengerName: string;
  seats: number;
  pickupZoneName: string;
  destinationZoneName: string;
  joinedAt: string;
};

/**
 * The driver's view of who is aboard (PRD D4, D5).
 *
 * `openSeats` is computed on the server, so no screen does the arithmetic and a
 * 3-seat Tesla with two aboard can never be rendered as "one free" by a client
 * that forgot to subtract.
 */
export type PoolManifest = {
  poolId: string;
  plate: string;
  model: string;
  status: string;
  seatCapacity: number;
  occupiedSeats: number;
  openSeats: number;
  members: PoolMember[];
  /** Sum of every member's frozen fare — the pool total the driver sees (PRD D4). */
  poolTotalPoysha: number;
};

/**
 * `GET /tesla/pool`, the envelope for "no open pool yet".
 *
 * The same shape as `MyTeslaView`: "no passengers aboard" is the ordinary opening
 * state of a driver who just registered, so it travels as `pool: null` inside a
 * 200 rather than as a 404 that would read like a fault (D28).
 */
export type MyPool = {
  pool: PoolManifest | null;
};