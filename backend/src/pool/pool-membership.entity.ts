import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Ride } from '../ride/ride.entity';
import { Pool } from './pool.entity';

/**
 * One passenger's place in one pool (SRS §4.3 `POOL_MEMBERSHIP`).
 *
 * **`ride_request_id` is unique, which is what makes membership unambiguous
 * (US-R4).** A composite `UNIQUE (pool_id, ride_request_id)` would only stop the
 * same ride joining the same pool twice; the column-level unique forbids a ride
 * from appearing in *two* pools at once, which is the invariant the product
 * actually needs — a passenger cannot hold a seat in one Tesla and another seat
 * in a different one. The stronger constraint also makes the weaker one
 * redundant, so only the stronger exists and `idx_pool_memberships_pool` serves
 * the lookups by pool.
 *
 * **`passenger_fare_poysha` is frozen here at assignment** (PRD §6.2, step 1):
 * base + distance, with no sharing discount yet, because occupancy is not final
 * until the trip starts. It is written on join and re-written for every member
 * together at `STARTED`, which is why the figure is stored per member rather than
 * derived each time — the manifest has to show a total that will not move when a
 * later event changes nothing for an earlier passenger.
 *
 * **Neither foreign key cascades.** A pooled ride that is hard-deleted would
 * silently strand an `occupied_seats` count with no rows behind it, and the same
 * is true of a pool. `RESTRICT` turns both into a loud failure that forces the
 * canceller to deal with the seat first (PRD §6.4's "the seat returns to the
 * pool"), rather than a quiet inconsistency that only surfaces as a driver who
 * can never fill their car again.
 */
@Entity('pool_memberships')
@Unique('uq_pool_memberships_ride', ['rideRequest'])
@Index('idx_pool_memberships_pool', ['pool'])
export class PoolMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `RESTRICT`: see the class note — empty the pool before deleting it. */
  @ManyToOne(() => Pool, (pool) => pool.memberships, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'pool_id' })
  pool: Pool;

  /** `RESTRICT`: cancelling a ride is a status change, never a row deletion. */
  @ManyToOne(() => Ride, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'ride_request_id' })
  rideRequest: Ride;

  /** The fare this passenger owes, frozen at assignment and recomputed at STARTED. */
  @Column({ type: 'integer', name: 'passenger_fare_poysha' })
  passengerFarePoysha: number;

  /**
   * When the seat was claimed. Not in the SRS's minimal shape, but the manifest
   * and the audit trail both want the order of boarding to survive
   * `updated_at` moving under them.
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
