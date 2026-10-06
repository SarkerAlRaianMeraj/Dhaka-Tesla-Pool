import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { validateEnv } from '../src/config/env.validation';

/**
 * Email pattern every e2e suite registers, so cleanup can identify its own rows
 * without deleting anything a human made on the database being tested.
 */
export const E2E_EMAIL_PATTERN = 'e2e-%@pool.test';

/**
 * Fails the suite with an instruction instead of a raw error when the test
 * database is missing or not migrated.
 *
 * The database bootstrap is deliberately manual (`DATABASE_NAME=dhaka_tesla_pool_test
 * npm run migration:run`) rather than automated in a global setup: the schema is
 * owned by migrations, not by tests, and a test runner that created or altered
 * the schema itself would quietly make "the build is green" depend on a schema
 * the deployed environment does not have. Skipping the bootstrap therefore must
 * be unmissable — hence a probe whose failure names the exact command to run.
 */
export async function assertTestDatabase(): Promise<void> {
  // This probe runs before the app boots, so `ConfigModule`'s dotenv load has
  // not happened yet. Loading `backend/.env` ourselves hands the probe exactly
  // the credentials the app is about to connect with.
  loadDotenv();

  const env = validateEnv(process.env);
  const client = new Client({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    const result = await client.query(
      `SELECT to_regclass('public.zones') AS zones, to_regclass('public.pools') AS pools`,
    );
    const row = result.rows[0] as {
      zones: string | null;
      pools: string | null;
    };
    if (!row?.zones || !row?.pools) {
      throw new Error(
        `tables are missing (zones=${JSON.stringify(row?.zones ?? null)}, pools=${JSON.stringify(row?.pools ?? null)})`,
      );
    }
  } catch (cause) {
    const detail = cause instanceof Error ? `\n  ${cause.message}` : '';
    throw new Error(
      `The e2e suite needs the "${env.DATABASE_NAME}" database to exist and be migrated.` +
        `\n  Run:  createdb ${env.DATABASE_NAME}` +
        `\n  then: DATABASE_NAME=${env.DATABASE_NAME} npm run migration:run` +
        `\n  (from "backend/"). Tests never create or alter the schema (see assertTestDatabase).` +
        detail,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Removes every row the e2e suites could have created, leaving the test database
 * exactly as migrations left it.
 *
 * Order matters: `pool_memberships` is `ON DELETE RESTRICT` on both its foreign
 * keys, so the passengers and driver an e2e suite registered are deleted only
 * after the seats they hold are released. Anything else cascades — rides and
 * their history from the passenger, pools from the Tesla.
 */
export async function resetE2eRows(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `DELETE FROM "pool_memberships" m
      WHERE m."ride_request_id" IN (
        SELECT r."id" FROM "ride_requests" r
          JOIN "users" u ON u."id" = r."passenger_id"
         WHERE u."email" LIKE '${E2E_EMAIL_PATTERN}'
      )
         OR m."pool_id" IN (
        SELECT p."id" FROM "pools" p
          JOIN "teslas" t ON t."id" = p."tesla_id"
          JOIN "users" u ON u."id" = t."driver_id"
         WHERE u."email" LIKE '${E2E_EMAIL_PATTERN}'
      )`,
  );
  await dataSource.query(
    `DELETE FROM "users" WHERE "email" LIKE '${E2E_EMAIL_PATTERN}'`,
  );
}
