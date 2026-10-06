import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AppConfiguration, buildConfiguration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { PoolModule } from './pool/pool.module';
import { RideModule } from './ride/ride.module';
import { TeslaModule } from './tesla/tesla.module';
import { ZoneModule } from './zone/zone.module';

export const configurationFactory = (): AppConfiguration =>
  buildConfiguration(validateEnv(process.env));

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configurationFactory],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.database'),
        ssl: config.get<boolean>('database.ssl')
          ? { rejectUnauthorized: false }
          : false,
        autoLoadEntities: true,
        // Schema only ever changes through a reviewed migration; `synchronize`
        // would happily rewrite tables and is the classic way to lose data.
        synchronize: false,
      }),
    }),
    HealthModule,
    AuthModule,
    ZoneModule,
    RideModule,
    TeslaModule,
    // Phase 4: owns `pools` and `pool_memberships`, registered alongside the
    // modules that write to them so `autoLoadEntities` knows the schema exists.
    PoolModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // `*path` rather than `*`: the newer path-to-regexp requires a named
    // wildcard, and `*` only still works through an auto-conversion warning.
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
