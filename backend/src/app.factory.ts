import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Builds the API exactly as `main.ts` boots it, stopping short of `listen`.
 *
 * `main.ts` reads the port and binds the socket; the e2e suites instead bind
 * supertest to the same `HttpServer` object. Both entry points get the same
 * global prefix, cookie parsing, CORS, helmet, and validation pipeline because
 * both go through this one function — a test that rewrote the pipeline for
 * itself would be a test that can pass against a pipeline the real server does
 * not run (NFR: the committed spec must describe the deployed app, not a
 * test-only twin).
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const corsOrigin = config.get<string>('app.corsOrigin');
  if (corsOrigin === undefined) {
    throw new Error('app.corsOrigin must be configured');
  }

  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  // Reads the httpOnly session cookie. `cookie-parser` is not Express middleware
  // that Nest wraps for us, so it is registered explicitly.
  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigin.split(','),
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    // Required for the browser to send and store the session cookie. The origin
    // list above stays explicit, because `origin: true` would reflect any origin
    // and pair it with credentials.
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableShutdownHooks();

  return app;
}
