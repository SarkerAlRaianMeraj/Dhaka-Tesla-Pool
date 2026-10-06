import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApp } from '../src/app.factory';
import { assertTestDatabase } from './helpers';

describe('Health (e2e)', () => {
  let app: INestApplication;
  let server: App;

  beforeAll(async () => {
    // The health read is meaningless without a reachable database, so the
    // friendly "did you create the test database?" probe runs first here too.
    await assertTestDatabase();

    app = await createApp();
    await app.init();
    // `getHttpServer()` is typed `any`; this cast is the escape hatch
    // `supertest`'s own `App` type exists for, and it keeps the typed-lint
    // rules from flagging the hand-off as an unsafe argument.
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports healthy while the database is reachable', async () => {
    const response = await request(server).get('/api/v1/health').expect(200);
    const body = response.body as {
      status: string;
      info: Record<string, { status: string }>;
    };

    expect(body.status).toBe('ok');
    expect(body.info.database?.status).toBe('up');
  });

  it('echoes a request id so a client can quote it in a bug report', async () => {
    const response = await request(server)
      .get('/api/v1/health')
      .set('x-request-id', 'phase-0-check')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('phase-0-check');
  });
});
