import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthCoreModule } from '../common/auth/auth-core.module';
import { MatchingModule } from '../matching/matching.module';
import { PoolModule } from '../pool/pool.module';
import { ZoneModule } from '../zone/zone.module';
import { Ride } from './ride.entity';
import { RideStatusHistory } from './ride-status-history.entity';
import { RideController } from './ride.controller';
import { RideService } from './ride.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, RideStatusHistory]),
    // `AuthCoreModule` rather than `AuthModule`: the guard needs to verify a JWT,
    // and importing the whole auth module would drag registration and password
    // hashing into a module that has no use for them (D21).
    AuthCoreModule,
    // Imported for `ZoneService.requireByCodes`, which is how a client-supplied
    // zone code becomes a zone row (D22).
    ZoneModule,
    // Imported for `PoolService` — joining and cancelling a pooled ride both
    // need the claimed seat to move through the one path that owns it (D13).
    PoolModule,
    // The matcher re-runs after a ride is created (to decide `MATCHED`) and
    // after a cancellation (the freed seats may make other rides matchable).
    MatchingModule,
  ],
  controllers: [RideController],
  providers: [RideService],
  exports: [RideService],
})
export class RideModule {}
