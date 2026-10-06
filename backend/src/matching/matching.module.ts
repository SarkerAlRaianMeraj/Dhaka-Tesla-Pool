import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pool } from '../pool/pool.entity';
import { Ride } from '../ride/ride.entity';
import { RideStatusHistory } from '../ride/ride-status-history.entity';
import { Tesla } from '../tesla/tesla.entity';
import { ZoneModule } from '../zone/zone.module';
import { MatchingService } from './matching.service';

/**
 * Owns the ride-side of matching: whether an unassigned ride is `REQUESTED`
 * ("no suitable Tesla identified") or `MATCHED` ("a suitable online Tesla with
 * free capacity has been identified", PRD §5.2 and the status glossary).
 *
 * `MatchingService` reads `ride_requests`, `ride_status_history`, `teslas`, and
 * `pools` through its own repositories rather than through `PoolService`,
 * precisely so this module is imported **out of** the claim path, never into it:
 * the matcher runs *after* a claim commits, never inside one, and a
 * `PoolModule -> MatchingModule` edge would just be a second way to write a
 * cycle. `ZoneModule` carries the corridor index the rule is built from.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, RideStatusHistory, Tesla, Pool]),
    ZoneModule,
  ],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
