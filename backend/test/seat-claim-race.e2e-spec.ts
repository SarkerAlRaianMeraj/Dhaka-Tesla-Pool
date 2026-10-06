import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createApp } from '../src/app.factory';
import { PoolManifestView } from '../src/pool/pool.types';
import { RideView } from '../src/ride/ride.types';
import { assertTestDatabase, resetE2eRows } from './helpers';

/**
 * The two promises PRD §5.4 and D13 make: exactly one claimer gets the last
 * seat, and the claim path's `FOR UPDATE` lock is what serialises the losers.
 *
 * Two layers of proof, deliberately:
 *
 * 1. A real race. Six passengers fire `join` at the same open pool with two
 *    free seats. Exactly two 201s, exactly four last-seat refusals, and the
 *    pool never shows more occupied seats than it has (D10, NFR-2).
 *
 * 2. The mechanism. Two raw transactions take the same pool row's advisory
 *    lock as the claim path does. The second read cannot return until the first
 *    transaction commits — so a loser, by construction, "reads the winner's
 *    row and waits" (PRD §5.4) rather than deciding on a stale occupancy.
 */
const PASSWORD = 'e2e-password-123';
const LAST_SEAT_TAKEN =
  'That Tesla is full — its last seat went to another passenger. Try again.';

type Agent = ReturnType<typeof request.agent>;

describe('Seat claim race (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let dataSource: DataSource;

  beforeAll(async () => {
    await assertTestDatabase();

    app = await createApp();
    await app.init();
    server = app.getHttpServer();
    dataSource = app.get(DataSource);

    await resetE2eRows(dataSource);
  });

  afterAll(async () => {
    await resetE2eRows(dataSource);
    await app.close();
  });

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

  it('gives the last seats to exactly two of six simultaneous claimers', async () => {
    const driver = await signIn('driver', 'E2E Driver', 'driver');
    await driver
      .post('/api/v1/tesla')
      .send({ plate: 'E2E-RACE-01', capacity: 3 })
      .expect(HttpStatus.CREATED);
    await driver
      .post('/api/v1/tesla/availability')
      .send({ availability: 'ONLINE' })
      .expect(HttpStatus.OK);

    // First passenger anchors the pool: 1 aboard, 2 seats left.
    const anchor = await signIn('anchor', 'Anchor', 'passenger');
    const anchorRide = (
      await anchor
        .post('/api/v1/rides')
        .send({
          pickupZoneCode: 'banani',
          destinationZoneCode: 'gulshan_1',
          seatsRequested: 1,
        })
        .expect(HttpStatus.CREATED)
    ).body as RideView;
    await driver
      .post(`/api/v1/tesla/requests/${anchorRide.id}/accept`)
      .expect(HttpStatus.CREATED);

    // Six riders all decide, at the same time, to take the two free seats.
    const racers = await Promise.all(
      ['rafiq', 'shirin', 'salma', 'maliha', 'jahid', 'tanvir'].map((key) =>
        (async (): Promise<{ key: string; agent: Agent; ride: RideView }> => {
          const agent = await signIn(
            key,
            key.charAt(0).toUpperCase() + key.slice(1),
            'passenger',
          );
          const ride = (
            await agent
              .post('/api/v1/rides')
              .send({
                pickupZoneCode: 'banani',
                destinationZoneCode: 'gulshan_1',
                seatsRequested: 1,
              })
              .expect(HttpStatus.CREATED)
          ).body as RideView;
          return { key, agent, ride };
        })(),
      ),
    );

    const outcomes = await Promise.all(
      racers.map(async (racer) => {
        const response = await racer.agent.post(
          `/api/v1/rides/${racer.ride.id}/join`,
        );
        return { key: racer.key, status: response.status, body: response.body };
      }),
    );

    const winners = outcomes.filter(
      (outcome) => outcome.status === HttpStatus.CREATED,
    );
    const losers = outcomes.filter(
      (outcome) => outcome.status !== HttpStatus.CREATED,
    );

    // Counts are deterministic even though which two riders win is not.
    expect(winners).toHaveLength(2);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      expect((loser.body as { message?: string }).message).toBe(
        LAST_SEAT_TAKEN,
      );
    }

    // The pool settled at exactly capacity, never a seat above it (D10, NFR-2).
    const poolResponse = await driver
      .get('/api/v1/tesla/pool')
      .expect(HttpStatus.OK);
    const pool = (poolResponse.body as { pool: PoolManifestView | null }).pool!;
    expect(pool.occupiedSeats).toBe(3);
    expect(pool.openSeats).toBe(0);
    expect(pool.seatCapacity).toBe(3);

    const onBoard = pool.members.map((member) => member.rideId).sort();
    const winnersOnBoard = winners
      .map(
        (winner) => racers.find((racer) => racer.key === winner.key)!.ride.id,
      )
      .sort();
    expect(onBoard).toEqual([anchorRide.id, ...winnersOnBoard].sort());

    // Losers keep a claimable ride and hold no seat.
    for (const loser of losers) {
      const racer = racers.find((r) => r.key === loser.key)!;
      const ride = (
        await racer.agent
          .get(`/api/v1/rides/${racer.ride.id}`)
          .expect(HttpStatus.OK)
      ).body as RideView;
      expect(['REQUESTED', 'MATCHED']).toContain(ride.status);
    }
    expect(onBoard).toHaveLength(new Set(onBoard).size); // no ride twice
  });

  it('serialises two claim transactions on the same pool row', async () => {
    // A second driver so the assertion runs against a real free seat.
    const driver = await signIn('locksmith', 'E2E Lock Smith', 'driver');
    await driver
      .post('/api/v1/tesla')
      .send({ plate: 'E2E-RACE-02', capacity: 3 })
      .expect(HttpStatus.CREATED);
    await driver
      .post('/api/v1/tesla/availability')
      .send({ availability: 'ONLINE' })
      .expect(HttpStatus.OK);

    const anne = await signIn('anne', 'Anne', 'passenger');
    const anneRide = (
      await anne
        .post('/api/v1/rides')
        .send({
          pickupZoneCode: 'banani',
          destinationZoneCode: 'mohakhali',
          seatsRequested: 1,
        })
        .expect(HttpStatus.CREATED)
    ).body as RideView;
    const opened = await driver
      .post(`/api/v1/tesla/requests/${anneRide.id}/accept`)
      .expect(HttpStatus.CREATED);
    const poolId = (opened.body as PoolManifestView).poolId;

    const runnerA = dataSource.createQueryRunner();
    const runnerB = dataSource.createQueryRunner();
    try {
      await runnerA.startTransaction();
      await runnerB.startTransaction();

      // The claim path's exact read shape: lock the pool row before deciding.
      const aRead = await runnerA.query(
        `SELECT "occupied_seats" FROM "pools" WHERE "id" = $1 FOR UPDATE`,
        [poolId],
      );
      const aOccupied = Number(
        (aRead[0] as { occupied_seats: string }).occupied_seats,
      );
      expect(aOccupied).toBe(1);

      // B asks for the same row while A holds the lock. B's read must not
      // resolve until A commits — the "loser waits" half of PRD §5.4.
      let bSettled = false;
      let bValue: number | null = null;
      const bPromise = runnerB
        .query(
          `SELECT "occupied_seats" FROM "pools" WHERE "id" = $1 FOR UPDATE`,
          [poolId],
        )
        .then((rows: unknown[]) => {
          bSettled = true;
          bValue = Number(
            (rows[0] as { occupied_seats: string }).occupied_seats,
          );
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(bSettled).toBe(false);

      // A claims the seat under the lock, exactly as the claim path does...
      await runnerA.query(
        `UPDATE "pools" SET "occupied_seats" = "occupied_seats" + 1 WHERE "id" = $1`,
        [poolId],
      );
      await runnerA.commitTransaction();

      // ...and only now does B's recheck return, seeing the seat gone.
      await bPromise;
      expect(bValue).toBe(aOccupied + 1);

      const finalRead = await runnerB.query(
        `SELECT "occupied_seats" FROM "pools" WHERE "id" = $1`,
        [poolId],
      );
      expect(
        Number((finalRead[0] as { occupied_seats: string }).occupied_seats),
      ).toBe(aOccupied + 1);
      await runnerB.rollbackTransaction();
    } finally {
      await runnerA.release();
      await runnerB.release();
    }
  });
});
