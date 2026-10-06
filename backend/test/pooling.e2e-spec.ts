import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createApp } from '../src/app.factory';
import { MyPoolView, PoolManifestView } from '../src/pool/pool.types';
import { RideView } from '../src/ride/ride.types';
import { MatchableRideView } from '../src/tesla/tesla.types';
import { assertTestDatabase, resetE2eRows } from './helpers';

/**
 * The pooling story end to end: how a request becomes a promise a Tesla keeps,
 * how a pool is opened and filled, how the feed narrows, and how every promise
 * heals or is withdrawn when the world moves (D27, D32, PRD §5.3, §5.6, §6.1).
 *
 * The database it runs against is `dhaka_tesla_pool_test`, migrated manually
 * (see `assertTestDatabase`). Every passenger and the driver are `e2e-*@pool.test`
 * accounts so the suite cleans up after itself without touching anything else.
 *
 * The `it` blocks are deliberately sequential: they describe one morning's
 * journey, and each step's assertion depends on the state the previous step just
 * established. Splitting them into independent tests would force each one to
 * rebuild the same world and test the rebuild, not the story.
 */
const PASSWORD = 'e2e-password-123';

type Agent = ReturnType<typeof request.agent>;

describe('Pooling (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let dataSource: DataSource;

  let driver: Agent;
  let nusrat: Agent;
  let rafiq: Agent;
  let shirin: Agent;
  let salma: Agent;
  let mirpur: Agent;

  // The ride each passenger created, kept so later steps can re-read it.
  const rides: Partial<Record<string, RideView>> = {};
  const fares: Record<string, number> = {};

  const signIn = async (
    key: string,
    name: string,
    role: 'driver' | 'passenger',
  ): Promise<Agent> => {
    const agent = request.agent(server);
    const email = `e2e-${key}@pool.test`;
    await agent
      .post('/api/v1/auth/register')
      .send({ name, email, password: PASSWORD, role })
      .expect(HttpStatus.CREATED);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(HttpStatus.OK);
    return agent;
  };

  const askRide = async (
    agent: Agent,
    key: string,
    pickupZoneCode: string,
    destinationZoneCode: string,
  ): Promise<RideView> => {
    const created = await agent
      .post('/api/v1/rides')
      .send({ pickupZoneCode, destinationZoneCode, seatsRequested: 1 })
      .expect(HttpStatus.CREATED);
    const ride = created.body as RideView;
    rides[key] = ride;
    fares[key] = ride.fareEstimatePoysha;
    return ride;
  };

  const refresh = async (agent: Agent, key: string): Promise<RideView> => {
    const response = await agent
      .get(`/api/v1/rides/${rides[key]!.id}`)
      .expect(HttpStatus.OK);
    const ride = response.body as RideView;
    rides[key] = ride;
    return ride;
  };

  const historyStatuses = (ride: RideView): string[] =>
    ride.statusHistory.map((entry) => entry.toStatus);

  const driverFeed = async (): Promise<MatchableRideView[]> => {
    const response = await driver
      .get('/api/v1/tesla/requests')
      .expect(HttpStatus.OK);
    return response.body as MatchableRideView[];
  };

  const driverFeedIds = async (): Promise<string[]> =>
    (await driverFeed()).map((request) => request.id);

  const driverPool = async (): Promise<PoolManifestView> => {
    const response = await driver
      .get('/api/v1/tesla/pool')
      .expect(HttpStatus.OK);
    return (response.body as MyPoolView).pool!;
  };

  beforeAll(async () => {
    await assertTestDatabase();

    app = await createApp();
    await app.init();
    server = app.getHttpServer();
    dataSource = app.get(DataSource);

    await resetE2eRows(dataSource);

    driver = await signIn('driver', 'E2E Driver', 'driver');
    await driver
      .post('/api/v1/tesla')
      .send({ plate: 'E2E-POOL-01', capacity: 3 })
      .expect(HttpStatus.CREATED);

    nusrat = await signIn('nusrat', 'Nusrat', 'passenger');
    rafiq = await signIn('rafiq', 'Rafiq', 'passenger');
    shirin = await signIn('shirin', 'Shirin', 'passenger');
    salma = await signIn('salma', 'Salma', 'passenger');
    mirpur = await signIn('mirpur', 'Mirpur', 'passenger');
  });

  afterAll(async () => {
    await resetE2eRows(dataSource);
    await app.close();
  });

  it('keeps a request REQUESTED while no driver is online', async () => {
    const ride = await askRide(nusrat, 'nusrat', 'banani', 'mohakhali');
    expect(ride.status).toBe('REQUESTED');
    expect(historyStatuses(ride)).toEqual(['REQUESTED']);

    // The feed is a broadcast of open requests: an offline driver still sees it.
    expect(await driverFeedIds()).toContain(ride.id);
  });

  it('lists a shareable sibling and a route that can never share', async () => {
    await askRide(rafiq, 'rafiq', 'banani', 'gulshan_1'); // shares banani corridor
    await askRide(mirpur, 'mirpur', 'banani', 'mirpur'); // never shares (D27)

    const feedIds = await driverFeedIds();
    expect(feedIds).toContain(rides.rafiq!.id);
    expect(feedIds).toContain(rides.mirpur!.id);
  });

  it('promotes every unassigned request to MATCHED when the driver goes online', async () => {
    await driver
      .post('/api/v1/tesla/availability')
      .send({ availability: 'ONLINE' })
      .expect(HttpStatus.OK);

    for (const key of ['nusrat', 'rafiq', 'mirpur'] as const) {
      const ride = await refresh(
        key === 'nusrat' ? nusrat : key === 'rafiq' ? rafiq : mirpur,
        key,
      );
      // No pool yet, so every request is a candidate this Tesla could seed (D27).
      expect(ride.status).toBe('MATCHED');
      expect(historyStatuses(ride)).toEqual(['REQUESTED', 'MATCHED']);
    }
  });

  it('opens the pool on the first accept and freezes the fare', async () => {
    const accepted = await driver
      .post(`/api/v1/tesla/requests/${rides.nusrat!.id}/accept`)
      .expect(HttpStatus.CREATED);
    const manifest = accepted.body as PoolManifestView;

    expect(manifest.seatCapacity).toBe(3);
    expect(manifest.occupiedSeats).toBe(1);
    expect(manifest.openSeats).toBe(2);
    expect(manifest.members).toHaveLength(1);
    expect(manifest.members[0].rideId).toBe(rides.nusrat!.id);
    expect(manifest.poolTotalPoysha).toBe(fares.nusrat);

    const ride = await refresh(nusrat, 'nusrat');
    expect(ride.status).toBe('ACCEPTED');
    expect(historyStatuses(ride)).toEqual(['REQUESTED', 'MATCHED', 'ACCEPTED']);
  });

  it('narrows the feed to riders who can share the anchored pool', async () => {
    const feedIds = await driverFeedIds();
    // Rafiq shares the banani corridor; Mirpur's destination never does.
    expect(feedIds).toContain(rides.rafiq!.id);
    expect(feedIds).not.toContain(rides.mirpur!.id);
  });

  it('refuses an incompatible accept before capacity is considered', async () => {
    const refused = await driver
      .post(`/api/v1/tesla/requests/${rides.mirpur!.id}/accept`)
      .expect(HttpStatus.CONFLICT);
    expect((refused.body as { message: string }).message).toBe(
      'These requests cannot share a Tesla: the pickup zones must be identical and the destinations must share a corridor',
    );
  });

  it('lets a second passenger join the open pool, growing the pool total', async () => {
    const joined = await rafiq
      .post(`/api/v1/rides/${rides.rafiq!.id}/join`)
      .expect(HttpStatus.CREATED);
    const ride = joined.body as RideView;
    expect(ride.status).toBe('ACCEPTED');

    const pool = await driverPool();
    expect(pool.occupiedSeats).toBe(2);
    expect(pool.openSeats).toBe(1);
    expect(pool.members.map((member) => member.rideId)).toEqual([
      rides.nusrat!.id,
      rides.rafiq!.id,
    ]);
    expect(pool.poolTotalPoysha).toBe(fares.nusrat + fares.rafiq);
  });

  it('fills the pool to capacity with a third shared request', async () => {
    const ride = await askRide(shirin, 'shirin', 'banani', 'mohakhali');
    // Created while the driver is online with an open pool that fits it.
    expect(ride.status).toBe('MATCHED');

    await shirin
      .post(`/api/v1/rides/${ride.id}/join`)
      .expect(HttpStatus.CREATED);

    const pool = await driverPool();
    expect(pool.occupiedSeats).toBe(3);
    expect(pool.openSeats).toBe(0);
    expect(pool.members).toHaveLength(3);
    expect(pool.poolTotalPoysha).toBe(
      fares.nusrat + fares.rafiq + fares.shirin,
    );
  });

  it('empties the feed at capacity and refuses the last seat (E1)', async () => {
    expect(await driverFeedIds()).toHaveLength(0);

    // Every other waiting rider is a compatible one-seater with no free seat.
    const waiting = await askRide(salma, 'salma', 'banani', 'gulshan_1');
    expect(waiting.status).toBe('REQUESTED');

    const acceptRefused = await driver
      .post(`/api/v1/tesla/requests/${waiting.id}/accept`)
      .expect(HttpStatus.CONFLICT);
    const joinRefused = await salma
      .post(`/api/v1/rides/${waiting.id}/join`)
      .expect(HttpStatus.CONFLICT);
    expect((acceptRefused.body as { message: string }).message).toBe(
      'That Tesla is full — its last seat went to another passenger. Try again.',
    );
    expect((joinRefused.body as { message: string }).message).toBe(
      'That Tesla is full — its last seat went to another passenger. Try again.',
    );
  });

  it('returns the seat on cancel and re-promotes a waiting ride', async () => {
    await rafiq
      .post(`/api/v1/rides/${rides.rafiq!.id}/cancel`)
      .expect(HttpStatus.OK);
    const cancelled = await refresh(rafiq, 'rafiq');
    expect(cancelled.status).toBe('CANCELLED');
    expect(historyStatuses(cancelled)).toEqual([
      'REQUESTED',
      'MATCHED',
      'ACCEPTED',
      'CANCELLED',
    ]);

    const pool = await driverPool();
    expect(pool.occupiedSeats).toBe(2);
    expect(pool.openSeats).toBe(1);

    // The freed seat restores Salma's match (D32: the promise heals itself).
    const rePromoted = await refresh(salma, 'salma');
    expect(rePromoted.status).toBe('MATCHED');
    const feedIds = await driverFeedIds();
    expect(feedIds).toContain(rePromoted.id);
    expect(feedIds).not.toContain(cancelled.id);
  });

  it('refuses going offline while passengers are assigned (E2)', async () => {
    const refused = await driver
      .post('/api/v1/tesla/availability')
      .send({ availability: 'OFFLINE' })
      .expect(HttpStatus.CONFLICT);
    expect((refused.body as { message: string }).message).toBe(
      'You still have assigned passengers on your Tesla. Complete the trip before going offline.',
    );
  });

  it('allows going offline once the pool is empty, withdrawing MATCHED promises', async () => {
    await nusrat
      .post(`/api/v1/rides/${rides.nusrat!.id}/cancel`)
      .expect(HttpStatus.OK);
    await shirin
      .post(`/api/v1/rides/${rides.shirin!.id}/cancel`)
      .expect(HttpStatus.OK);

    const pool = await driverPool();
    expect(pool.occupiedSeats).toBe(0);
    expect(pool.openSeats).toBe(3);
    expect(pool.members).toHaveLength(0);

    await driver
      .post('/api/v1/tesla/availability')
      .send({ availability: 'OFFLINE' })
      .expect(HttpStatus.OK);

    // D32: the driver left, so the promises they were the last standing
    // candidate for are withdrawn, not left dangling.
    const salmaRide = await refresh(salma, 'salma');
    expect(salmaRide.status).toBe('REQUESTED');
    const mirpurRide = await refresh(mirpur, 'mirpur');
    expect(mirpurRide.status).toBe('REQUESTED');
  });

  it('never lets a passenger touch a ride they do not own (NFR-1)', async () => {
    const response = await nusrat
      .post(`/api/v1/rides/${rides.mirpur!.id}/join`)
      .expect(HttpStatus.NOT_FOUND);
    expect((response.body as { message: string }).message).toBe(
      `Ride ${rides.mirpur!.id} was not found`,
    );
  });

  it('keeps the driver feed behind the driver role', async () => {
    const response = await nusrat
      .get('/api/v1/tesla/requests')
      .expect(HttpStatus.FORBIDDEN);
    expect((response.body as { message: string }).message).toBe(
      'This action is restricted to: driver',
    );
  });
});
