import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tesla } from '../tesla/tesla.entity';
import { PoolMembership } from './pool-membership.entity';
import { PoolStatus } from './pool-status.enum';

/**
 * The seats one Tesla is currently offering, and how many of them are taken
 * (SRS §4.3 `POOL`, PRD §6.3).
 *
 * Three properties carry Phase 4's correctness argument:
 *
 * **`seat_capacity` is a denormalised copy of `teslas.capacity` (D10).** A CHECK
 * constraint cannot reach across tables, so without a copy on this row the
 * ceiling the database is supposed to refuse to violate would not exist — it
 * would live in application code, which is exactly the "future code path that
 * forgets the check" PRD §6.3 rules out. The copy costs one drift risk, accepted
 * in D10 because capacity is fixed at registration and no update path exists to
 * change it underneath passengers who are already aboard.
 *
 * **`occupied_seats` is the counter the CHECK constrains.** It is written only by
 * the single claim path, inside a transaction that holds this row's lock, and
 * only membership removals that the service performs can lower it. Nothing else
 * in the schema may delete a membership: both foreign keys on
 * `pool_memberships` are `RESTRICT`, so a hard delete of a ride or a pool fails
 * loudly instead of leaving a counter that no longer describes reality.
 *
 * **`status` is the open/closed answer, not a trip phase.** Whether a driver may
 * start a second pool is decided by `uq_pools_active_tesla`, a partial index over
 * `FORMING` and `ACTIVE` alone — so a closed pool never blocks the next trip.
 */
@Entity('pools')
@Index('uq_pools_active_tesla', ['tesla'], {
  unique: true,
  where: "\"status\" IN ('FORMING', 'ACTIVE')",
})
export class Pool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * `CASCADE`: a pool is a property of the Tesla it sits on and means nothing
   * without it. An empty pool therefore disappears with the vehicle, while a
   * populated one cannot — the memberships RESTRICT that deletion — so the
   * counter is never orphaned alongside a row it described.
   */
  @ManyToOne(() => Tesla, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'tesla_id' })
  tesla: Tesla;

  /**
   * The ceiling, copied from the Tesla at creation and never edited (D10).
   *
   * Present on this row solely so `ck_pools_not_overbooked` can be a real
   * constraint. It is not the authority on capacity — `teslas.capacity` is — and
   * the claim path copies rather than re-derives it.
   */
  @Column({ type: 'smallint', name: 'seat_capacity' })
  seatCapacity: number;

  /**
   * Seats currently held, 0 to `seatCapacity`.
   *
   * Denormalised for the same reason: the ceiling has to be checkable on one row.
   * The truth is a count of `pool_memberships`, and the claim path writes both in
   * one transaction so they cannot disagree within it.
   */
  @Column({ type: 'smallint', name: 'occupied_seats', default: 0 })
  occupiedSeats: number;

  @Column({ type: 'varchar', length: 20, default: PoolStatus.FORMING })
  status: PoolStatus;

  /** Who is aboard, in the order they joined (PRD D4's manifest). */
  @OneToMany(() => PoolMembership, (membership) => membership.pool)
  memberships: PoolMembership[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
