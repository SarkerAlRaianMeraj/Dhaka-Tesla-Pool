# Entity-relationship diagram

Generated from the live database after `npm run migration:run`, so it reflects the
migrations rather than a hand-maintained copy. Phase 4 covers `users`, `zones`,
`corridors`, `zone_corridors`, `ride_requests`, `ride_status_history`, `teslas`,
`pools`, and `pool_memberships`; the Phase 5-6 tables are listed at the end as not
yet created.

Every primary key is a UUID (D16) and the schema is built from versioned migrations
rather than `synchronize` (D17).

## Relationships

```
users (1) ──────< (n) ride_requests            passenger_id, ON DELETE CASCADE
users (1) ──────< (n) teslas                   driver_id, ON DELETE CASCADE
zones (1) ──────< (n) ride_requests            pickup_zone_id, ON DELETE RESTRICT
zones (1) ──────< (n) ride_requests            destination_zone_id, ON DELETE RESTRICT
teslas (1) ──────< (n) pools                   tesla_id, ON DELETE CASCADE
pools (1) ──────< (n) pool_memberships         pool_id, ON DELETE RESTRICT
ride_requests (1) ──< (n) ride_status_history  ride_request_id, ON DELETE CASCADE
ride_requests (1) ──(1) pool_memberships       ride_request_id (US-R4: at most one seat anywhere, ON DELETE RESTRICT)
zones (n) ──────< (n) >────── corridors        zone_corridors (join table)
```

## users

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | varchar(120) | no | |
| email | varchar(180) | no | |
| password_hash | varchar(255) | no | |
| role | varchar(20) | no | |
| tesla_pay_balance_poysha | integer | no | 0 |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

- PK `users_pkey`
- UNIQUE `uq_users_email (email)`
- CHECK `ck_users_role`: `role IN ('passenger','driver')`
- CHECK `ck_users_balance_non_negative`: `tesla_pay_balance_poysha >= 0`

## zones

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| code | varchar(40) | no | |
| name | varchar(60) | no | |
| x_km | numeric(6,2) | no | |
| y_km | numeric(6,2) | no | |

- PK `zones_pkey`
- UNIQUE `uq_zones_code (code)`
- INDEX `idx_zones_coordinates (x_km, y_km)`

`x_km` and `y_km` are a published grid in kilometres, not map coordinates. The fare
is Manhattan distance on this grid, so any fare can be checked by hand
(`backend/src/ride/fare.ts`).

## corridors

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| code | varchar(60) | no | |
| name | varchar(120) | no | |

- PK `corridors_pkey`
- UNIQUE `uq_corridors_code (code)`

## zone_corridors

| Column | Type | Null | Default |
|---|---|---|---|
| zone_id | uuid | no | |
| corridor_id | uuid | no | |

- PK `zone_corridors_pkey (zone_id, corridor_id)`
- FK `zone_id -> zones.id` ON DELETE CASCADE
- FK `corridor_id -> corridors.id` ON DELETE CASCADE
- INDEX `idx_zone_corridors_corridor (corridor_id)`

## ride_requests

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| passenger_id | uuid | no | |
| pickup_zone_id | uuid | no | |
| destination_zone_id | uuid | no | |
| seats_requested | smallint | no | |
| distance_km | numeric(6,2) | no | |
| fare_estimate_poysha | integer | no | |
| status | varchar(20) | no | 'REQUESTED' |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

- PK `ride_requests_pkey`
- FK `passenger_id -> users.id` ON DELETE CASCADE
- FK `pickup_zone_id -> zones.id` ON DELETE RESTRICT
- FK `destination_zone_id -> zones.id` ON DELETE RESTRICT
- CHECK `ck_ride_requests_status`: the seven PRD states
- CHECK `ck_ride_requests_seats`: `1 <= seats_requested <= 3`
- CHECK `ck_ride_requests_fare_non_negative`: `fare_estimate_poysha >= 0`
- CHECK `ck_ride_requests_zones_differ`: `pickup_zone_id <> destination_zone_id`
- INDEX `idx_ride_requests_passenger_created (passenger_id, created_at)`

Zones are foreign keys rather than strings (D22), because FR-DB1 asks for real
relationships and a string cannot enforce that a zone exists. The API accepts zone
*codes*; the service resolves them.

`seats_requested` is capped at 3 because the only Tesla in the brief is a 3-seater
Bullet. A match now also checks the pool's real headroom (`open_seats >=
seats_requested`, D32), but the column bound stays: it guarantees a passenger can
never ask for more than the largest Tesla the schema admits.

## ride_status_history

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| ride_request_id | uuid | no | |
| from_status | varchar(20) | **yes** | |
| to_status | varchar(20) | no | |
| changed_at | timestamptz | no | now() |

- PK `ride_status_history_pkey`
- FK `ride_request_id -> ride_requests.id` ON DELETE CASCADE
- CHECK `ck_ride_status_history_from_status`: nullable, or one of the seven states
- CHECK `ck_ride_status_history_to_status`: one of the seven states
- INDEX `idx_ride_status_history_ride_changed (ride_request_id, changed_at)`

Append-only. The current status also lives on `ride_requests` because every read
needs it; this table exists so the *path* is not lost. A ride that went
REQUESTED → MATCHED → CANCELLED and one that was never matched are indistinguishable
from `status` alone.

`from_status` is nullable because the first row of every ride is its creation.

## teslas

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| driver_id | uuid | no | |
| plate | varchar(20) | no | |
| model | varchar(60) | no | 'Tesla Model 3' |
| capacity | smallint | no | |
| availability | varchar(20) | no | 'OFFLINE' |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

- PK `teslas_pkey`
- FK `driver_id -> users.id` ON DELETE CASCADE
- UNIQUE `uq_teslas_driver (driver_id)` — one Tesla per driver is a database fact (US-D2)
- UNIQUE `uq_teslas_plate (plate)`
- CHECK `ck_teslas_availability`: `availability IN ('OFFLINE','ONLINE')`
- CHECK `ck_teslas_capacity`: `1 <= capacity <= 3`
- CHECK `ck_teslas_plate_not_blank`: `length(btrim(plate)) > 0`
- INDEX `idx_teslas_availability (availability)`

`capacity` is immutable — it is fixed at registration (US-D2) and everything Phase 4
reasons about assumes it never moves, so there is no update path that could lower it
under passengers who are already aboard.

Availability is a status column rather than a table (D26), because one driver owns
exactly one Tesla and the state has exactly one home. Going offline with an assigned
passenger is refused by the service (error E2), not by extra state.

## pools

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| tesla_id | uuid | no | |
| seat_capacity | smallint | no | |
| occupied_seats | smallint | no | 0 |
| status | varchar(20) | no | 'FORMING' |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

- PK `pools_pkey`
- FK `tesla_id -> teslas.id` ON DELETE CASCADE
- CHECK `ck_pools_status`: `status IN ('FORMING','ACTIVE','COMPLETED','CANCELLED')`
- CHECK `ck_pools_capacity`: `1 <= seat_capacity <= 3`
- CHECK `ck_pools_occupied_floor`: `occupied_seats >= 0`
- CHECK `ck_pools_not_overbooked`: `occupied_seats <= seat_capacity`
- UNIQUE INDEX `uq_pools_active_tesla (tesla_id) WHERE status IN ('FORMING','ACTIVE')`
- INDEX `idx_pools_tesla (tesla_id)`

`seat_capacity` is a copy of `teslas.capacity` (D10): a CHECK constraint cannot
reference another table, and PRD §6.3 insists the ceiling is "not merely checked in
application code". `ck_pools_not_overbooked` is the belt to the claim transaction's
braces — the application's row lock is what makes concurrent claims *separate*, the
constraint is what makes an overbooking *impossible even if a later code path skips
the lock* (D13).

The active-pool unique index is partial deliberately (D12): it is "one *open* pool
per Tesla", so a closed pool never blocks the next trip, and it is why the claim path
insert-then-retries — two concurrent first accepts can both see "no pool" and the
loser joins the winner's pool instead of opening a rival.

## pool_memberships

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| pool_id | uuid | no | |
| ride_request_id | uuid | no | |
| passenger_fare_poysha | integer | no | |
| created_at | timestamptz | no | now() |

- PK `pool_memberships_pkey`
- FK `pool_id -> pools.id` ON DELETE RESTRICT
- FK `ride_request_id -> ride_requests.id` ON DELETE RESTRICT
- CHECK `ck_pool_memberships_fare_non_negative`: `passenger_fare_poysha >= 0`
- UNIQUE `uq_pool_memberships_ride (ride_request_id)` — a ride holds a seat in at most one pool anywhere (US-R4)
- INDEX `idx_pool_memberships_pool (pool_id)`

`passenger_fare_poysha` is frozen at assignment as base + distance with no sharing
discount yet (PRD §6.2 step 1); it is recomputed for every member together at
STARTED, when occupancy is final.

Both foreign keys are `RESTRICT` on purpose: `occupied_seats` is denormalised, so a
hard delete of a ride or pool would leave a counter with no rows behind it and a
Tesla that can never fill again. There is no delete endpoint today, so nothing hits
this; the only consequence is that any future account deletion must deal with held
seats first — a loud constraint is the intended outcome, not an accident.

## Not yet created

`payments` and `ratings` arrive in Phases 5-6, per SRS §4.3. The SRS also lists
`vehicles` and `pool_members`; this project calls the former `teslas` and the latter
`pool_memberships` (with a `seat_capacity` column where the SRS's capacity is
enforced — `docs/architecture.md` §4 and D12/D13).

## Reproducing

```bash
cd backend
npm run migration:run        # applies 1700000001000..1700000004000
```

Targeting a test database reuses the same runner:

```bash
DATABASE_NAME=dhaka_tesla_pool_test npm run migration:run
```

`migrations` is TypeORM's own bookkeeping table and is not part of the domain model.