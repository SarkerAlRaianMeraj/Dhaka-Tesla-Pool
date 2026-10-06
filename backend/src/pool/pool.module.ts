import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthCoreModule } from '../common/auth/auth-core.module';
import { Ride } from '../ride/ride.entity';
import { RideStatusHistory } from '../ride/ride-status-history.entity';
import { Tesla } from '../tesla/tesla.entity';
import { ZoneModule } from '../zone/zone.module';
import { PoolMembership } from './pool-membership.entity';
import { PoolService } from './pool.service';
import { Pool } from './pool.entity';

/**
 * Owns the seat-claim path and everything it reasons about.
 *
 * `PoolService` reads `ride_requests` and `ride_status_history` and `teslas`
 * through the same transaction manager, and they are registered here so the
 * claim path is self-contained in this module: its guarantees do not depend on a
 * ride or tesla module happening to have registered an entity first. The
 * registrations are harmless duplicates of `RideModule`'s and `TeslaModule`'s.
 *
 * `AuthCoreModule` is imported for `JwtAuthGuard`'s `JwtService`, which the
 * controllers that host the accept and join routes need; `ZoneModule` for the
 * corridor index the matching rule is built from.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Pool,
      PoolMembership,
      Ride,
      RideStatusHistory,
      Tesla,
    ]),
    ZoneModule,
    AuthCoreModule,
  ],
  providers: [PoolService],
  exports: [PoolService],
})
export class PoolModule {}
