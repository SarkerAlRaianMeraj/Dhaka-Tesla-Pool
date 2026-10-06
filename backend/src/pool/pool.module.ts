import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pool } from './pool.entity';
import { PoolMembership } from './pool-membership.entity';

/**
 * Owns `pools` and `pool_memberships`.
 *
 * Commit 1 of Phase 4 registers the entities and nothing else: the schema, the
 * constraints, and the vocabulary are a reviewable unit before any code is
 * allowed to write to them. The claim path, the accept and join endpoints, and
 * the driver's manifest arrive in the commits that follow, so this module grows
 * providers rather than moving them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Pool, PoolMembership])],
})
export class PoolModule {}
