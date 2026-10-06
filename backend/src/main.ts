import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app.factory';
import { INSECURE_DEV_JWT_SECRET } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get(ConfigService);

  const port = config.get<number>('app.port');
  if (port === undefined) {
    throw new Error('app.port must be configured');
  }

  // Production refuses this secret outright, so reaching here means development
  // or test. It is still worth shouting about: a developer who never opens .env
  // would otherwise ship a publicly known signing key without realising it.
  if (config.get<string>('jwt.secret') === INSECURE_DEV_JWT_SECRET) {
    new Logger('Bootstrap').warn(
      'JWT_SECRET is the built-in development secret. Anyone who has read this repository can forge a session cookie. Do not run a deployed instance this way.',
    );
  }

  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(
    `Dhaka Tesla Pool API ready on http://localhost:${port}/api/v1 [${config.get<string>('app.env')}]`,
  );
}

void bootstrap();
