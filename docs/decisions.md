# Decisions — Dhaka Tesla Pool

**Status:** Phase 1 complete. Each decision records what was chosen, the realistic alternative, why the choice fits a ride-pooling MVP, and what would make us change it. Product-level versions of these rules live in `PRD_Dhaka_Tesla_Pool.md` §6.

The course standards (`backend/rules.md`, `frontend/rules.md`) are the source of truth for day-to-day structure and style. D16–D21 record every place this codebase deliberately departs from them; the README points here rather than restating them, so the list cannot drift.

| # | Decision | Status |
|---|---|---|
| D1 | Geography is a predefined Dhaka zone list, not a routing API | settled (PRD §6.1) |
| D2 | Matching = same pickup zone + intersecting destination corridors | settled (PRD §6.1) |
| D3 | Fare = base + distance − 20% distance-charge discount, integer poysha | settled (PRD §6.2) |
| D4 | Fares recomputed once at `STARTED`, when occupancy is final | settled (PRD §6.2) |
| D5 | Seat claim is a locked transaction with a database-level capacity check | settled (PRD §6.3) |
| D6 | Polling for live status instead of WebSockets | settled (PRD §9.3 A3) |
| D7 | Passengers may join a matchable pool without per-join driver approval | settled (PRD §9.3 A2) |
| D8 | Stack: NestJS 11 + Next.js 16 + PostgreSQL + TypeORM | settled (Phase 1) |
| D9 | `zones` table added beyond the SRS entity list | settled, applied in Phase 1 |
| D10 | `pools.seat_capacity` denormalised to make the capacity check a real constraint | to expand in Phase 4 |
| D11 | TeslaPay balance stored on `users` rather than a separate wallets table | to expand in Phase 6 |
| D12 | One active pool per Tesla, enforced by a partial unique index | settled, applied in Phase 4 |
| D13 | Fixed lock order and a transaction-manager rule for seat claims | settled, applied in Phase 4 |
| D14 | bcrypt via `bcryptjs` instead of the native binding | settled, applied in Phase 1 |
| D15 | JWT delivered as an httpOnly cookie, Bearer header kept as a fallback | settled, applied in Phase 1 |
| D16 | UUID primary keys instead of incrementing integers | settled, applied in Phase 1 |
| D17 | Migrations instead of `synchronize: true` | settled, applied in Phase 0 |
| D18 | No `express-session`; the JWT cookie is the session | settled, applied in Phase 1 |
| D19 | Tailwind 4 CSS-first configuration, no `tailwind.config.ts` | settled, applied in Phase 1 |
| D20 | The web app runs on port 3001, not the standard 3000 | settled, applied in Phase 1 |
| D21 | Identity is owned by the auth module, so `src/user/` holds only the entity | settled, applied in Phase 1 |
| D22 | Ride zones are UUID foreign keys, not code strings | settled, applied in Phase 2 |
| D23 | The sharing discount floors to whole poysha | settled, applied in Phase 2 |

## Why the obvious alternatives were rejected

### D5 — Seat capacity
- **Redis seat counter:** faster, but capacity would live outside the transactional database, and a cache eviction during the race would silently overbook. Rejected: the guarantee must survive the cache being wrong (NFR-2).
- **Optimistic retry loop:** correct only if the retry loop is bounded and re-reads under a constraint; more code paths for the same guarantee. Rejected in favour of one pessimistic lock — one code path is easier to explain and to test.
- **Serialisable transaction:** also correct, but aborts under contention rather than waiting. Rejected for now; revisit if p99 latency becomes a problem.

### D6 — Live status
- **WebSockets:** the "right" answer for a production ride-hailing product, and the first thing to reach for in an interview. Rejected for the MVP because it adds a second transport, a reconnect strategy, and an infrastructure decision — none of which the brief asks for (NFR-7). Revisit when wait times make polling visibly janky.

### D8 — Framework versions
- NestJS, Express, Fastify, and plain Node were all candidates. NestJS wins on guard/pipe/module conventions that make authorization reviewable and consistent, which is what the "backend design" criterion actually rewards. Versions are pinned to a stable major rather than the newest release; a stable, documented API beats a fresh major for a submission that must run reproducibly on an evaluator's machine.

### D9 — A `zones` reference table, beyond the SRS entity list
The SRS entity list has no geography, but FR-M1 requires matching by pickup zone and destination corridor, and the fare rule is defined over zone distance. Both are impossible without somewhere to put the eight Dhaka zones.

- **Chosen:** `zones` with a coordinate grid (`x_km`, `y_km`), a `corridors` table, and a `zone_corridors` join table. Manhattan distance on the grid is the fare input; corridor intersection is half the matching rule.
- **Alternative considered:** deriving geography from coordinates embedded in each ride request. Rejected — the zones would drift out of agreement between requests, "Banani" would stop being the same place, and the fare would stop being verifiable by hand (FR-F1).
- **Cost:** zone data is now schema the application depends on, so it is seeded by migration rather than left empty. Real road routing stays out of scope either way (assumption A5).

### D12 — One active pool per Tesla
Seat assignment locks a pool row and checks capacity against it. That guarantee is only as good as the assumption that a Tesla has exactly one active pool. If the pool row were created lazily on first acceptance, two concurrent accepts could each create a pool, leaving Bullet with 2 + 1 seats instead of 3 — capacity respected, but the product broken: two pools for one vehicle, and the demo story of a single shared Tesla impossible to reproduce.

- **Fix:** a partial unique index, `UNIQUE (tesla_id) WHERE status IN ('FORMING','ACTIVE')`. The database then guarantees the invariant; a losing insert fails and the claim retries against the existing pool.
- **Alternative considered:** creating the pool at acceptance of the first request inside the same locked transaction. Still racy, because two transactions can both observe "no active pool" before either inserts.
- **Cost:** a completed pool must leave the index range before a new one can open, so pool status transitions have to be written carefully. This is acceptable: the trip is over before a new pool starts.

### D13 — Fixed lock order, and every claim read inside the transaction
A row lock protects only the rows it is taken on, inside the transaction that took it. Two ways to quietly break D5: reading the pool through the default entity manager instead of the transaction manager (the read is served outside the transaction, so it can be stale), and taking locks in a different order in two code paths (classic deadlock, which the database resolves by aborting one transaction — turning a capacity guarantee into a user-visible error).

- **Fix, both parts:** seat claims go through a single function; every read and write in it uses the transaction manager; and locks are always acquired **pool row first, then ride request** — one global order, so no cycle can form.
- **Alternative considered:** `SERIALIZABLE` isolation for the claim transaction, letting the database abort conflicts instead of waiting. Correct, but it converts contention into failed requests that must be retried. Revisit if p99 latency under load becomes a problem.

### D14 — Password hashing: bcrypt, in the pure-JavaScript build
`backend/rules.md` specifies bcrypt. `bcryptjs` implements the same algorithm in JavaScript rather than as a native addon, because the submission has to build and run on a machine with nothing but Node installed — a native `bcrypt` needs a compiler toolchain and a rebuild after every Node upgrade. The hashes are identical in format and strength; only the implementation differs.

- **Cost:** `bcryptjs` is roughly 30-40% slower than the native binding at 10 rounds. That is irrelevant at MVP traffic and irrelevant to correctness.
- **Note:** bcrypt reads at most 72 bytes of a password, so the DTO caps the length at 72 characters. Silently ignoring the rest would make two different long passwords interchangeable.

### D15 — The JWT is an httpOnly cookie, with `Authorization: Bearer` kept as a fallback
An earlier draft kept the token in `localStorage` and accepted the XSS exposure. `frontend/rules.md` requires an httpOnly cookie that client JavaScript never reads, and it is also the better design: a token that script cannot read cannot be exfiltrated by a script injection bug. The login response therefore carries no token at all — only the user and the lifetime — and the browser holds it in `access_token` (`httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`).

- **CSRF:** `SameSite=Lax` already blocks the browser from attaching this cookie to a cross-site `POST`, and the API only accepts JSON bodies with an explicit content type, so no separate CSRF token is needed for this MVP. Documented rather than assumed.
- **CORS:** the browser will only store and send the cookie if the response carries `Access-Control-Allow-Credentials`, so the client sets `withCredentials: true` and the API keeps an explicit origin list. `origin: true` was rejected because it reflects any origin *and* pairs it with credentials.
- **Scripts keep working:** the guard accepts `Authorization: Bearer <token>` when no cookie is present, so `curl`, Postman, and the demonstration scripts work without a cookie jar. When both are present the cookie wins.
- **Cost:** SSR cannot call authenticated endpoints, because the browser's cookie is not available to the Next.js server. Authenticated pages are therefore client-rendered, which also matches the rendering-strategy table in `frontend/rules.md` (dashboards are CSR).

## Departures from the course standards

Each of these contradicts a specific line in `backend/rules.md` or `frontend/rules.md`. They are decisions, not accidents: the standard is followed everywhere it does not conflict with a requirement of this brief.

### D16 — UUID primary keys instead of incrementing integers
`backend/rules.md:131` shows a bare `@PrimaryGeneratedColumn()`, which in PostgreSQL means an auto-incrementing integer. Every entity here uses `@PrimaryGeneratedColumn('uuid')`.

- **Why:** a pooled ride exposes its identifiers to two strangers and appears in URLs, logs, and audit records. Sequential integers let anyone who registers after Nusrat infer how many accounts exist, and let someone enumerate a ride by counting up. UUIDs remove that inference for free.
- **Cost:** 16 bytes instead of 4, no clustered insert locality, and indices grow faster. Irrelevant at MVP volume; it becomes a real consideration only past the scale the reasoning in Phase 10 addresses.
- **Alternative considered:** integer keys with an opaque public id per ride. Rejected — two identifiers for one row is more state to keep consistent than one identifier that is safe to expose.

### D17 — Migrations instead of `synchronize: true`
`backend/rules.md:436` sets `synchronize: true` in the TypeORM connection options. This project runs versioned migrations from `backend/src/database/migrations/` and never enables it.

- **Why:** `synchronize` derives the schema from the entity classes at boot. That means a half-finished refactor silently changes production data, there is no record of what the schema was at any past commit, and rolling back is impossible. The brief (§6, §12) requires a reproducible install from migrations, and asks for a seed that reviewers can run — neither is reproducible if the database rebuilds itself from whatever the current entities happen to say.
- **Cost:** every schema change needs a migration written by hand, and an entity change that forgets its migration is a runtime error rather than a silent fix.
- **Alternative considered:** `synchronize` in development and migrations in production. Rejected — the two would drift, and the environment where a bug appears would never be the environment where it was found.

### D18 — No `express-session`; the JWT cookie is the session
`backend/rules.md:332` sets up `express-session` with a cookie. This project stores nothing in a server-side session store; the signed JWT *is* the session, delivered in the httpOnly cookie described in D15.

- **Why:** a server-side session needs somewhere to keep sessions. That is either a shared store — which breaks the moment the API is run as more than one instance — or an in-process `MemoryStore`, which silently drops every session on restart and is explicitly not for production. The brief's NFR-5 asks for a stack reproducible with `docker compose up` on a machine that only has Docker, and adding a session store is exactly the kind of "advanced technology" the brief rules out (NFR-7).
- **Cost:** the token cannot be revoked before it expires. Logout clears the cookie client-side and server-side, but a stolen token stays valid until its lifetime ends. The mitigation is a short expiry plus D15's rule that the client cannot read the token to begin with.
- **Alternative considered:** `express-session` plus a database-backed store. Correct for a conventional app, and the wrong shape for an MVP whose entire state model already lives in PostgreSQL.

### D19 — Tailwind 4 CSS-first configuration, no `tailwind.config.ts`
`frontend/rules.md:47` lists `tailwind.config.ts` with `plugins: [require("daisyui")]` (lines 284–290). This project has no Tailwind config file at all: `frontend/app/globals.css` contains `@import "tailwindcss"` and `@plugin "daisyui"`.

- **Why:** Tailwind 4 moved configuration into CSS. A `tailwind.config.ts` would need the `@config` directive to be loaded at all, so keeping one would mean writing the file in a compatibility mode that the installed major version no longer recommends. The dependency is already declared in `package.json` either way.
- **Cost:** a reader expecting the familiar config file has to look in `globals.css` instead. The theme choice is now a `@plugin "daisyui" { themes: … }` block rather than a `daisyui.themes` array.

### D20 — The web app runs on port 3001, not the standard 3000
`frontend/rules.md:21-22` runs the web app on `localhost:3000` and suggests changing the port in `package.json`. This project runs the API on 3000 (it is a `/api/v1` service the standard assumes already exists) and the web app on 3001, set in `frontend/package.json` and mapped by `WEB_PORT` in `docker-compose.yml`.

- **Why:** two processes cannot both bind 3000 on a development machine. Moving the API instead would break the standard's own assumption that the NestJS backend is the thing already on 3000.
- **Cost:** the URLs in the README and in the demo video differ from the standard's. The variable is declared in one place per app, so changing it back is a one-line edit.

### D21 — Identity is owned by the auth module, so `src/user/` holds only the entity
`backend/rules.md:32` shows each module folder holding a module, controller, service, entity, and `dto/` files. `backend/src/user/` contains only `user.entity.ts`, because registration, login, and profile are all auth endpoints (US-P1) and live in `backend/src/auth/`.

- **Why:** creating a `UserController` and `UserService` with no endpoints of their own would be scaffolding written to satisfy a folder shape rather than to serve a requirement. `auth.service.ts` is where a user is actually created and read.
- **Cost:** a reader looking for user endpoints under `src/user/` will not find them; the answer is one hop away in `src/auth/`, which `auth.module.ts` imports by entity path.
- **Alternative considered:** a real `user` module owning `GET /users/me`. Rejected for now — it would split identity across two modules for one endpoint, and Phase 6 (TeslaPay balance, rating history) is the point at which a user module earns its existence.

### D22 — Ride zones are UUID foreign keys, not code strings
The SRS conceptual model shows `RIDE_REQUEST.pickupZone` and `destinationZone` as strings. The schema stores two `uuid` columns with foreign keys to `zones`.

- **Why:** FR-DB1 requires proper relationships, constraints, and indexes throughout, and a string column cannot enforce that a zone exists. The SRS itself notes the physical schema is an implementation deliverable rather than something it fixes. Foreign keys also make "Banani" a single row that cannot drift in spelling between two requests.
- **Cost:** every read of a ride needs the zone relation loaded, or a join. The alternative — a denormalised copy of the zone name for display — would reintroduce the drift this avoids.
- **Note:** the API still *accepts* zone codes, because that is what a client has; the service resolves a code to a row and the request stores the row's id.

### D23 — The sharing discount floors to whole poysha
The 20% discount is `distanceCharge / 5`. When the distance charge is not divisible by 5, the PRD does not say which way to round, and the two obvious answers genuinely disagree: for a charge of 3 poysha, `Math.floor` gives 0 and `Math.round` gives 1.

- **Chosen:** `Math.floor`. The discount is something taken *off* a passenger's fare, so rounding it down never overcharges, and the result stays exactly reproducible by hand — which is the property FR-F1 and NFR-6 actually ask for.
- **Alternative considered:** `Math.round`, which is marginally more generous on average. Rejected because "we round in the passenger's favour here" is a sentence nobody should have to defend in a viva.
- **Scope of the edge case:** for the published one-decimal zone grid every charge is a multiple of 100 and therefore divisible by 5, so this never actually triggers today. It is specified now so that changing a zone's coordinates later cannot silently change the rounding behaviour.

### D24 — Production refuses the published JWT secret instead of trusting the operator
`backend/src/config/env.validation.ts` gives `JWT_SECRET` a built-in default so a fresh clone boots with no configuration. That default is a literal in this repository, so a deployment started with the variable unset would sign and verify every session with a key any reader already has, and could mint a valid `access_token` cookie for an arbitrary user id. The default is also long enough to satisfy a minimum-length rule, which is why length alone would never have caught it.

- **Chosen:** the default remains available to development and test, and is refused **by identity** when `NODE_ENV=production`, together with the `.env.example` placeholder and any secret shorter than 32 characters. `main.ts` logs a warning whenever the built-in secret is in use.
- **Why keep a default at all:** removing it would make the API refuse to boot on a fresh clone, converting a security control into an onboarding tax. The exposure is specific to production, so the rule is specific to production.
- **Why identity and not just length:** both published values are longer than 32 characters, so a minimum-length check waves them straight through. Only comparing against the known values distinguishes a placeholder from a real secret.
- **Cost:** the two published strings must be kept in step between `env.validation.ts` and `.env.example`. A renamed default silently stops being refused.
- **Note on Compose:** `docker-compose.yml` already uses `${JWT_SECRET:?...}`, but that form refuses only an *absent* value, so it happily accepts a copied-but-unedited `.env.example`. The application-level check is the one that actually holds. Compose also defaults `NODE_ENV` to `development`, so a container only exercises this rule once the operator sets `NODE_ENV=production` — deliberate, because the production cookie sets `Secure` and would not be stored over the plain-HTTP local setup.

### D25 — A single-entity state transition is a compare-and-set, not a checked write
`RideService.cancel()` used to read a ride's status, confirm it was cancellable, and then write `CANCELLED` inside a transaction that re-checked nothing. Two simultaneous requests both observed `REQUESTED` and both committed, leaving two `REQUESTED -> CANCELLED` rows in the trail NFR-3 exists to make trustworthy.

- **Chosen:** the expected status moves into the `WHERE` clause — `UPDATE ... WHERE id = ? AND status = <the status just validated>` — and `affected !== 1` means another writer won. The winner alone appends history; the loser re-reads so it can name the real current status instead of a stale reason.
- **Why no pessimistic lock is needed:** Postgres takes a row lock for the second `UPDATE` and re-evaluates the predicate against the committed row at READ COMMITTED, so the loser updates nothing. The database arbitrates the race; application timing does not.
- **Why this is not in tension with the pessimistic lock accepted for pool capacity (`AI_USAGE.md`):** seat claims contend for one shared occupancy counter, so several claimants genuinely serialise on a single row and a lock is the honest expression of that. A cancel touches one entity's own status, which nobody else is incrementing, so a conditional update says exactly what is true without serialising anything. Two mechanisms for two different problems, not a contradiction and not drift.
- **Cost:** the contended path costs one extra read, and both cancellation messages now come from a single helper so the fast path and the race path cannot describe the same refusal differently.
- **This is the template for Phase 4.** Whatever claims the last seat should likewise decide inside the statement that writes, not in a check that precedes it. The defect here was a corrupted audit trail, which is why it was demonstrated with eight concurrent requests against the live database rather than assumed from reading the code — and why Phase 9 formalises it as a test.

### D26 — Driver setup gets its own `/tesla` route, with availability on the Tesla row
`US-D2` ("I own exactly one Tesla with a fixed capacity") has no screen ID in `PRD_Dhaka_Tesla_Pool.md` §5.4; the screen table runs from D1 (sign in) straight to D2 (availability toggle and Tesla summary). So where registration lives is a judgement call, and it was decided rather than looked up.

- **Chosen:** a dedicated `/tesla` route. Its empty state is the registration form; once a Tesla exists the same route becomes the summary plus the online/offline toggle, which is exactly what screen D2 describes. The driver's dashboard card links to it, mirroring the passenger card that links to `/rides/request`.
- **Why not inline on the dashboard:** that card already exists and already says "arrives in phase 3" (`frontend/app/dashboard/page.tsx:116`), so the home for it is uncontroversial. But the dashboard also renders the zone list and the TeslaPay panel, and `PRD` §5.6 requires every screen to define its loading, error, and empty states — a form competing with unrelated content gives those states nowhere to live.
- **Why not a sign-up step:** it would delay every new driver on the path to the feed, change the sign-up click-through that Phase 1 already verified, and walk a returning driver through a step they do not need.
- **Availability is a status column on `teslas`,** not a separate table or a `driver` column. One driver owns exactly one Tesla, so the state has exactly one home, and error E2 ("driver goes offline with an assigned passenger") is a *guard* on that column rather than new state: the assignment survives, the ride stays `ACCEPTED`, and the passenger is told the driver is reconnecting.

### D27 — The matching rule is pairwise, so Phase 3 ships the predicate and an unfiltered feed
`PRD` §6.1 defines compatibility between two *requests*: "two requests may share one Tesla if and only if their pickup zones are identical AND their destination corridors overlap". A Tesla has a plate and a capacity and nothing else — no pickup zone. So with no active pool there is no anchor for a single request to be "compatible with", while `US-D3` still requires that non-matching requests be absent from the feed.

- **Chosen:** Phase 3 delivers `canShare()` as a pure function, verified against the three worked examples in §6.1, and the driver feed lists `REQUESTED` rides. Pairwise exclusion is demonstrated in Phase 4, where an accepted request gives the comparison something to compare against.
- **Why not invent an anchor now:** giving the Tesla a pickup zone at registration would contradict `US-D2`, which says registration provides plate and capacity. Seeding a second Tesla purely to watch a request disappear would add a driver arrangement the PRD's cast does not contain, to demonstrate something that becomes real for free one phase later.
- **Why the predicate is written in Phase 3 even though the feed cannot use it yet:** corridor overlap is the one rule in the project with a genuinely counter-intuitive case. Mohakhali belongs to *both* `banani_gulshan` and `dhanmondi_farmgate`, and that single fact is the only reason Nusrat, Rafiq, and Shirin can share Bullet. An implementation that treats a destination as having one corridor is wrong in a way that stays invisible until Phase 4 tries to pool three real riders.
- **Note:** a destination zone's corridor set is the input, not a single corridor. The rule is "exists a corridor containing destination A and a corridor containing destination B that share at least one zone".

### D28 - Three framework defaults that silently broke Phase 3, and what they now cost
Phase 3 hit three failures that all *looked* like application bugs and were none of them. Each was found by running the system, not by reading it, and each is now recorded because the fix is a small local habit rather than an obvious global setting.

- **`@UseGuards` on a controller does not make its guard's dependencies resolvable.** `TeslaController` guards every route with `DriverGuard`, which needs `JwtService` from `AuthCoreModule`. `DriverGuard` was passed as a class reference, so Nest tried to instantiate it in `TeslaModule`'s context and could not find `JwtService`; the app refused to boot. Importing `AuthCoreModule` into `TeslaModule` fixed it. **Cost:** any future feature module that guards its own controller must import `AuthCoreModule` too. Centralising guard dependencies is tempting, but it would change how Phase 1 and 2 are wired for no gain now.
- **The global `ValidationPipe` does not skip missing properties.** It is created in `main.ts` without `skipMissingProperties`, so `@IsInt() @Min(1) capacity?: number` rejects a request that simply omits `capacity` — the intended "use the default" case. `@ValidateIf((dto) => dto.capacity !== undefined)` on the property fixes it. **Cost:** every optional validated DTO field in the project needs `@ValidateIf`. Flipping `skipMissingProperties` globally would be the alternative, but that would silently change the meaning of every other optional field, so it was rejected.
- **A `null` return from a Nest handler is a zero-length body, not `null`.** `GET /tesla/me` returning `null` for "no Tesla registered" produced an empty 200. That is not merely untidy: the client received `undefined`, and the page then rendered a Tesla summary with `undefined` seats for a driver who had registered nothing. The handler now returns `{ tesla: ... }` and the client reads `response.data?.tesla ?? null`, so "absent" is an explicit, typed value rather than a missing one. **Cost:** read endpoints that can legitimately return nothing should wrap the result. This is recorded here rather than in Phase 7's error-envelope work because it is a *success*-path shape, not an error.

### D29 - The passenger dashboard was rebuilt from a design brief, and every fabricated number in it was refused
A 985-line design specification (`frontend/dhaka-tesla-pool-frontend-spec.md`) described a passenger home screen: an 88px floating rail, a booking panel, a route-intelligence map with a radar sweep, a four-stage progress track, and a last-ride strip. It was precise about CSS and silent about provenance. Its copy described a screen full of numbers that no part of this system produces: a named driver, a four-minute ETA, "4 Teslas nearby", "92% charge", a `৳54` fare, and an explicit "simulated live fleet activity" caption over an SVG map.

- **Chosen:** build the screen, keep every element that has a data source, and refuse the ones that do not. Real: the eight zones from `GET /zones`, the fare from `POST /rides/quote`, the TeslaPay balance from the session, the trip status from `GET /rides`, the two zone names on the map markers. Refused: the driver, the ETA, the fleet count, the charge level. The map is drawn in CSS and SVG and says so in its own copy.
- **Why the brief's fare formula was dropped rather than ported.** The spec carried a browser-side fare formula. Porting it would create a second implementation of `fare.ts` in another language, and the two would eventually disagree by one paisa - with the browser's copy being the one on screen and therefore believed. The dashboard shows what `POST /rides/quote` last answered and nothing else, so the number displayed is by construction the number charged.
- **Why "no driver assigned yet" rather than an empty avatar.** `Ride` has no driver field until an assignment exists, and nothing assigns one until Phase 4. Rendering a name, a plate or a star rating would be inventing a person on a screen reached by signing in. The progress track maps `RideStatus` to four stages, so with only `REQUESTED` reachable the first stage completes and the rest stay pending - the track cannot claim progress the server has not made.
- **Why the design system is honoured literally.** The OKLCH tokens, the radii, the shadows and the six keyframes are `@theme` values in `globals.css`, so a component asks for `bg-mint` rather than restating a colour. Fidelity is cheap here and expensive to retrofit; the numbers that were *invented* were the expensive part.
- **Fonts are committed, not fetched.** Figtree and Outfit are variable `.woff2` files in `public/fonts/` loaded through `next/font/local`. `next/font/google` would have made every build depend on reaching Google; the local loader also emits an automatic fallback face, which is what keeps the swap from shifting layout.
- **Wallet and Profile are absent from the rail.** The spec marked them visual-only. There is no `/wallet` or `/profile` route, and a nav item that navigates nowhere is a defect in a working product, not a placeholder. Wallet top-ups are Phase 6 and can arrive with something behind them.
- **The rail is 88px wide above 700px and gone below it,** and the global navbar and footer are withheld on `/dashboard` by a route-aware `Chrome` wrapper in the root layout, so the dashboard does not have to hide a shell it does not own. The driver branch of `/dashboard` keeps the plain page it had.
- **Cost:** the brief and the screen can now drift, and nothing detects that automatically. The spec is committed as the design source so a reviewer can diff intent against implementation, but there is no visual-regression test; that is Phase 7's job if it is wanted.

### D30 - The booking form derives its default route instead of writing it from an effect
The dashboard opens on Banani -> Gulshan, so something has to choose those two zones once `GET /zones` returns. The first implementation stored the choice in state and set it from an effect, which React 19's `react-hooks/set-state-in-effect` rule correctly refused: writing state synchronously in an effect body causes a second render pass, and the rule exists because that pattern is where stale-state bugs live.

- **Chosen:** the selected codes are *overrides*, not the selection. `useRideBooking` holds two empty strings and derives the effective pickup and destination from the zone list with `useMemo`; an override wins only once the passenger chooses. The derived pair is what the selectors display, what the quote is keyed on, and what the request posts.
- **Why this is better than the effect even setting aside the lint rule:** if the zone list ever changes, the defaults are recomputed instead of persisting a code that may no longer exist. The earlier version guarded with `if (pickup)` and would have kept a stale code indefinitely.
- **Cost:** reading the hook's return now means reading the derived value, not the state, so `pickupZoneCode` is deliberately not the setter's twin. Renaming the setters to `setPickupOverride` is what keeps that legible.

### D31 - The design became a daisyUI theme, and `themes: false` because omitting it ships two themes you did not ask for
The Kinetic Glass Rails brief is written at the CSS layer: OKLCH tokens, three radii, one box-shadow recipe, six keyframes. The app is daisyUI 5.7.47 on Tailwind 4.3.3, whose CSS-first configuration means a theme is a `@plugin "daisyui/theme"` block. So the whole rollout became one decision: express the design as a daisyUI theme, and let every existing `btn`, `badge`, `input`, `alert` and `navbar` restyle itself, rather than restyling each screen's controls one at a time.

- **Chosen:** `@plugin "daisyui/theme" { name: "kinetic"; ... }` in `globals.css`, `data-theme="kinetic"` on `<html>`, and the OKLCH values mirrored into an `@theme static` block so components ask for `bg-mint` and `text-ink` instead of restating colours.
- **`themes: false` is load-bearing, and this is the whole reason D31 exists.** daisyUI treats a custom theme as *additive*. The first version declared `kinetic` and assumed that replaced the defaults; the built CSS carried `corporate` and `violet` alongside it, and the app was one `data-theme` typo away from a stock palette. `themes: false` disables the built-in set so kinetic is the only theme compiled. **Cost:** if a stock theme is ever wanted, it has to be named in that block deliberately.
- **The rollout is light-only by decision, not by accident.** A `business --prefersdark` variant was written to satisfy the brief's `theme-controller` toggle and shipped broken - the media block was invalid CSS, so it silently produced no rules. It was removed rather than repaired, and the dark toggle was removed with it. **Cost:** there is no dark mode and no system-preference path. Adding one later means a second theme block plus a stored user preference; it is not a flag flip, and pretending otherwise is how the broken variant happened.
- **`link-primary` is mint, and mint on paper is not readable.** The design maps its single accent to both `primary` and the link colour, but the accent on the paper canvas is roughly 1.4:1. Restyling the design was rejected as the more expensive change, so links use forest. **Cost:** two greens coexist, and `link-primary` remains a token that does not meet contrast - it is left truthful rather than quietly redefined.
- **The theme lives in two blocks that must agree.** daisyUI reads the `@plugin "daisyui/theme"` block and Tailwind emits the utilities from the `@theme` block; neither reads the other. Changing a colour means changing both. `@theme static` forces emission even when Tailwind's content scan finds no usage, which is what makes `text-ink` exist at all.
- **One `Panel`, and the old copies are still there.** `components/ui/panel.tsx` holds the 26px radius / `border-ink/6` / white / `0 20px 48px` recipe, plus `Eyebrow`, `PrimaryAction`, `StatusPill` and `Skeleton`. The dashboard's four components already had those four values written literally, and they were left that way. **Cost:** the recipe exists in two places until someone consolidates, which is a separate decision with its own regression surface.
- **`StatusPill` consumes `statusBadgeClass`,** so the status-to-colour mapping stays in `lib/format.ts` and the component only adds the pill shape. The dashboard, the rides list and the ride detail therefore cannot disagree about what `REQUESTED` looks like.
- **Two small defects the rollout fixed rather than inherited:** `<select>` was styled `input input-bordered`, which is not a daisyUI select and rendered with text-field metrics; and the global `FormError` was a boxed alert, where an error next to the field it belongs to is a second, competing announcement.
- **Cost:** the theme is verified by harness rather than by eye. The whole-app check compares the *computed* daisyUI token against the Tailwind utility rather than a literal, because the browser serialises OKLCH as `lab()` and a naive equality test fails against correct CSS. It also fails the build if any stock hue survives, so `themes: false` cannot silently regress.

### D32 - `MATCHED` is an answer that is re-derived, not a promise a ride owns
`MATCHED` means "an ONLINE Tesla with free capacity that can share this request exists *right now*", so it stops being true the moment the candidate set changes, and a passenger-facing status that was not rechecked would be lying. Three events change the candidate set while a ride is unassigned: a new request appears (its creation is where `MATCHED` is first decided), a driver goes online or offline, and a claim happens — accepting or joining both occupy seats, and the first accept anchors the pool's pickup zone, any of which can leave a formerly matchable ride with no Tesla that fits.

- **Chosen:** every event that moves the candidate set calls `MatchingService.reconcile()`, which rebuilds the candidate list from the fleet and re-derives each unassigned ride's desired state from what it read; only genuine flips write a history row, through the same compare-and-set template as D25, so a concurrent claim that moves the ride to `ACCEPTED` first wins and the matcher's update affects nothing. A `MATCHED` ride whose last candidate vanishes returns to `REQUESTED` — "waiting for a Tesla" — keeping the PRD P3 row's "driver offline" state distinguishable from a wait that can never end.
- **Why withdrawal is not part of the claim transaction:** the claim path stays one lock (D5, D13). A passenger who loses the last seat is told by E1 in the same request that robbed them; the loser's status is re-derived by the reconcile that follows. Putting withdrawal inside the accept/join transaction would make the system's one serial point do two jobs and give a seat race two failure modes instead of one. The guarantee the brief cares about is that nobody overbooks — that lives in the claim, and it is why only the claim carries the lock.
- **Alternative considered:** a periodic background sweep that withdraws stale `MATCHED` rows without coupling reconciliation to each event. Equivalent semantics, more machinery, and a wall-clock window where the status is demonstrably stale with nobody reasonably to blame. The inline call today also means the UI sees the two-step history written in the same request that caused it. The service's scale note keeps this as a recognised future option that would not change what the status *means*.
- **Cost:** `reconcile` is O(unassigned rides × online Teslas) per event, trivial for the brief's fleet; the note marks the volume where it becomes a background batch. A loser can observe a one-event-stale `MATCHED` only if nothing subsequently triggers a reconcile, and every event that could change the answer calls one.

## Trade-offs we are knowingly accepting

1. **Denormalised pool capacity (D10):** occupancy can drift from the Tesla's current capacity if a capacity were ever editable. It is fixed at registration, so the drift cannot occur today; a trigger would remove the assumption if that ever changes.
2. **Single-instance deployment:** correctness of seat assignment depends on one database, not on one API instance — the API can be replicated horizontally today. Only migrations are single-flight, enforced by the compose topology.
3. **Polling:** trades latency for simplicity. Documented as assumption A3.
4. **Money in integer poysha:** no fractional poysha exist, so rounding rules are explicit and testable, at the cost of not supporting sub-unit pricing.