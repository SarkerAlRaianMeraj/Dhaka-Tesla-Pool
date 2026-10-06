import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthCoreModule } from '../common/auth/auth-core.module';
import { MatchingModule } from '../matching/matching.module';
import { PoolModule } from '../pool/pool.module';
import { Ride } from '../ride/ride.entity';
import { ZoneModule } from '../zone/zone.module';
import { TeslaController } from './tesla.controller';
import { Tesla } from './tesla.entity';
import { TeslaService } from './tesla.service';

/**
 * `Ride` is registered here because the driver feed reads `ride_requests`, and
 * `ZoneModule` is imported because the feed labels each request with its pickup
 * and destination (FR-D3.3).
 *
 * `PoolModule` is imported for `PoolService`, which owns whether a seat can be
 * claimed and therefore hosts the accept and manifest routes' logic (D13).
 *
 * `AuthCoreModule` is imported for the guard's own dependency rather than for a
 * service this module uses: `JwtAuthGuard` takes `JwtService`, and a controller
 * decorator cannot inject it. Without this the application fails to start with
 * `UnknownDependenciesException`, which typecheck and unit tests cannot see —
 * both resolve the controller without building the module's injector.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Tesla, Ride]),
    ZoneModule,
    AuthCoreModule,
    PoolModule,
    // Reconciles `REQUESTED`/`MATCHED` after availability flips and accepts;
    // imported here rather than by `PoolModule` so the matcher stays out of the
    // claim path's module graph (no cycle, and no shared writer for D13).
    MatchingModule,
  ],
  controllers: [TeslaController],
  providers: [TeslaService],
})
export class TeslaModule {}
