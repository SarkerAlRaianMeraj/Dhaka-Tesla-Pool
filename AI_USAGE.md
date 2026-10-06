# AI Usage Log

Disclosed per SRS §7.6 and the challenge brief §8: AI tools are permitted, must be disclosed, and every line of shipped code must remain explainable and modifiable by the team.

## Tools used

| Tool | Used for |
|---|---|
| opencode (Claude-based coding agent, running in a terminal) | Writing and refactoring source files, scaffolding configuration, drafting documentation, and running build/lint/test commands |
| Web search / documentation lookups | Verifying library APIs and versions before use rather than relying on recall |
| The challenge brief and SRS | Requirements, acceptance criteria, and the story cast — all human-authored inputs to this project |

## Phase-by-phase record

| Phase | What the AI produced | What a human decided or checked |
|---|---|---|
| 0 | Scaffold, compose topology, health probe, migration runner | Topology, ports, the local-PostgreSQL development stance |
| 1 | Entity and migration code, auth endpoints and guards, the three screens, the axios client and Zod schemas | Every product rule; bcrypt over scrypt; the httpOnly cookie over `localStorage`; all departures from the course standards (D14–D21), each reviewed and recorded |
| 2 | Fare rule as a pure function, the quote/create/list/cancel endpoints and their migration, the three ride screens, and a post-merge security review (below) | The fare model and its rounding (D23); zones as UUID foreign keys (D22); each audit finding and whether to fix it now or defer it |
| 3 | Tesla registration and availability endpoints and their migration, the pure `canShare()` predicate, the matchable-request feed, and the `/tesla` screen | The matching rule itself came from PRD §6.1, not from the AI (D27); a dedicated `/tesla` route rather than a dashboard panel (D26); the feed staying unfiltered until rides are assigned to a Tesla; and **the first exception to the no-test-files rule below, which a human approved after being told the trade-off** |
| 4a | The passenger dashboard rebuilt from an uploaded design specification: local variable fonts, the OKLCH token set and keyframes, the rail, booking panel, map panel, progress track and last-ride strip, and the two hooks behind them | Keeping the real API instead of the brief's simulated data; dropping the brief's browser-side fare formula; refusing the brief's invented driver, ETA, fleet count and charge level (D29); committing the font files rather than fetching from Google at build time; omitting the Wallet and Profile rail items because no routes exist; deriving the default route from the zone list rather than writing it from an effect (D30); and whether the brief itself is committed as the design source |
| 4b | The same design rolled across the eight remaining routes, expressed once as a daisyUI theme so every existing `btn`, `badge`, `input`, `select`, `toggle` and `navbar` restyles itself: the shared `Panel`/`Eyebrow`/`StatusPill`/`PrimaryAction`/`Skeleton` primitives, the landing page, both auth screens, the three rides screens, the driver's Tesla page, the 404, and all three loading boundaries | Dropping dark mode rather than repairing the brief's broken `--prefersdark` variant (D31); `themes: false`, without which a stock daisyUI palette ships alongside the custom theme; forest links instead of the brief's unreadable mint links; the register page's role dropdown becoming two radio cards; whether auth screens keep the global navbar |
| 4 (pooling) | The pooling slice: the `pools`/`pool_memberships` schema (D10 denormalised capacity constraint, D12 partial unique index, RESTRICT FKs), the single locked claim path (D13 fixed lock order, E1), `MatchingService` reconciling `MATCHED` and its D32 withdrawal, the driver feed narrowed to what one Tesla could serve, the request/availability/accept/`/tesla/pool` endpoints, the pooling screens on the passenger and driver sides, and the committed e2e suite (`test/helpers.ts`, `test/pooling.e2e-spec.ts`, `test/seat-claim-race.e2e-spec.ts`) behind a shareable `createApp()` factory | The capacity mechanism itself — the pessimistic row lock plus a database CHECK (the "accepted suggestion" below) — and that withdrawal lives outside the claim transaction (D32); the manual test-database bootstrap (the schema belongs to migrations, so tests must never create or alter it and failing loudly with the exact `migration:run` command is the intended UX); e2e running with `maxWorkers=1` because the suites share `e2e-*@pool.test` users; and the second approved exception to the no-test-files rule (below) |

### What the design rollout changed, and what it did not

The dashboard proved the visual system on one route. Rolling it across the rest meant
deciding how far a shared component should reach, and refusing two kinds of change
that would have looked like progress.

- **The theme was made the single source of the palette.** Rather than restyling each
  screen's controls, the OKLCH tokens, three radii and the box-shadow recipe became
  `@plugin "daisyui/theme"` values. `themes: false` is the load-bearing line: daisyUI
  treats a custom theme as additive, so without it the built CSS also carries
  `corporate` and `violet` (D31).
- **Dark mode was removed, not repaired.** The brief's `theme-controller` variant
  emitted invalid CSS and silently did nothing. Fixing it was judged more expensive
  than dropping it, and the human approved light-only. The consequence is recorded
  honestly: there is no dark mode and no system-preference path.
- **One panel recipe, and the existing duplicates were left in place.** The dashboard's
  four components already had the values written literally. Consolidating them would
  have churned verified code to remove a string duplication, so new work goes through
  `components/ui/panel.tsx` and consolidation stays a separate decision.
- **Status colour was not re-invented per screen.** `StatusPill` consumes
  `statusBadgeClass` from `lib/format.ts`, so three screens cannot drift apart on what
  `REQUESTED` means.
- **The register page's role `<select>` became two radio cards.** Both roles sat behind
  one dropdown on the decision that sets up everything after it, and "driver" is a
  choice worth making by seeing it.
- **No screen's behaviour changed.** Fares still come from `POST /rides/quote`,
  availability is still set by the server rather than optimistically, and the empty
  states are still reachable. The brief was followed literally on pixels and not at all
  on data — the same rule Phase 4a established, applied to eight more routes.

### What the design brief changed, and what it did not

The uploaded specification was precise about CSS and silent about provenance, so the judgement calls were all about numbers rather than pixels. Each was put to the human rather than resolved silently.

- **The brief's fare formula was not ported.** It would have created a second implementation of `fare.ts` that eventually disagrees by a paisa, with the browser's copy on screen and therefore believed. The dashboard displays what `POST /rides/quote` answered.
- **The brief's driver, ETA, fleet count and charge level were not rendered.** `Ride` has no driver field until Phase 4 assigns one, so the screen says so rather than showing a plausible-looking stranger (D29, PRD A6/A8).
- **The brief's own words about the map were kept.** It captioned the animation "simulated live fleet activity"; the panel now says "illustrative, not live tracking", which is the same admission in plainer words.
- **The brief's visual system was followed literally,** because fidelity is cheap to add now and expensive to retrofit, and every colour, radius and keyframe is an `@theme` token rather than a value restated per component.

## Security review after Phase 2

An AI-driven review of Phases 0–2 was run once Phase 2 had merged, and every finding was read, reproduced, and accepted or rejected by a human before anything was changed.

- **Accepted and fixed:** the API would accept the published placeholder `JWT_SECRET` in production, because the only rule on it was a non-empty check that the default itself satisfied (D24); `RolesGuard` existed but was applied to nothing, leaving passenger-only endpoints open to drivers; and `cancel()` could let two concurrent requests both win, corrupting the status history (D25). All three were reproduced against the running system, not inferred from reading the code — the cancel defect was demonstrated by firing eight simultaneous requests and then re-confirmed by reverting the fix and watching it fail three times out of four.
- **Rejected as not worth doing yet:** a global exception filter and rate limiting. Both are assigned to Phase 7 by `PROJECT_PLAN.md`, both change either the API contract or the dependency list, and doing them here would leave that phase with little to do.
- **Deferred as needing a decision that is not the AI's to make:** a cap on how many open ride requests one passenger may hold (needs a limit value that appears nowhere in the PRD, plus a migration) and pagination on the ride list (an API contract change the frontend does not yet send). Both were raised with the human and parked.
- **Accepted as a known limitation:** Docker Compose remains unverified on the development machine, as `PROJECT_PLAN.md` §"Docker truth" permits.

## What the AI did and did not decide

- **Did:** propose file structures, entity fields, guard and middleware wiring, Dockerfile shapes, and draft prose for the PRD and docs.
- **Did not:** choose the matching rule, the fare model, the capacity mechanism, or the scope boundaries. Those are documented decisions in `docs/decisions.md` and `PRD_Dhaka_Tesla_Pool.md`, derived from the brief and reviewed by the team.
- **Verification rule applied throughout:** nothing is committed unless `npm run build` and `npm run lint` are green and the phase's slice has been clicked through end to end. Phases 1–8 write no test files except the two approved exceptions below; Phase 9 proves the six required behaviours (see `PROJECT_PLAN.md`). Code that failed to build was fixed or removed, never accepted because the AI produced it.
- **Two approved exceptions to that rule, in Phase 3 and Phase 4.**
- **The first was Phase 3.** `backend/src/tesla/matching.spec.ts`. The AI raised the conflict itself rather than quietly adding the file, and put the choice to the human: PRD §5.4 traces user story D3 ("as a driver I see only requests my Tesla can serve") to a *matching unit*, which reads as a requirement for a unit test, while `PROJECT_PLAN.md` forbids test files in Phases 1–8 to leave Phase 9 room to demonstrate testing skill. **The human chose to keep the test**, on the grounds that the matching rule is the one piece of Phase 3 that a reviewer cannot confirm by clicking — the feed is unfiltered until Phase 4, so the browser pass cannot distinguish a correct predicate from a wrong one — and that a wrong predicate would be invisible until pooling is built.
- **The second was Phase 4.** The pooling slice ships a committed e2e suite — `test/helpers.ts`, `test/pooling.e2e-spec.ts`, `test/seat-claim-race.e2e-spec.ts` — behind a `createApp()` factory that boots the production pipeline. The AI flagged that FR-C1/NFR-2 (capacity under concurrency) is the one requirement whose failure mode lives between two threads, unreachable by clicking, and proposed witnessing the pooling journey and the claim race the way D25 was demonstrated: against the live database. **The human chose to keep the suite**, on the same grounds as Phase 3. Three decisions in it are worth recording. The e2e specs run with `maxWorkers=1`, because every suite signs up the same `e2e-*@pool.test` users and rows must not collide. `eslint.config.mjs` turns the `unsafe-*` rules off for `test/` only — supertest responses, `app.getHttpServer()` and raw pg clients are structurally `any` at the HTTP boundary, so the relaxation is scoped and production `src/` keeps every rule. Writing the suite also surfaced two real bugs: supertest's cookie jar is only preserved across an agent (`request.agent(server)`) and not a bare `request(server)` chain, so every authenticated call goes through an agent created by `signIn`; and `import type { DataSource }` is erased at runtime, so `app.get(DataSource)` needs the value import.

## One accepted suggestion

**Pessimistic write lock on the pool row for seat assignment (TypeORM `findOne` with a row-level lock inside a transaction), backed by a database `CHECK` constraint on occupancy.** Accepted because it makes the "capacity can never be exceeded" requirement (FR-C1, NFR-2) a property of the database rather than of application discipline: the lock serialises competing claims, and the constraint catches any future code path that forgets the check. Cost: claims on the same pool serialise, which is acceptable at MVP scale and is quantified in the scaling reasoning.

## One rejected or modified suggestion

**Rejected — keep a Redis seat counter per Tesla for O(1) capacity checks and let the database store only the final occupancy.** Rejected on two grounds. First, it makes correctness depend on a cache that can evict a key under memory pressure, which is precisely the failure that produces an overbooked Tesla. Second, the brief explicitly rules out Redis for this MVP (NFR-7, brief §16: do not add technologies to look advanced). The PostgreSQL row is a few microseconds slower and is the only source of truth.

**Modified — a "matching engine" that auto-assigns any compatible request to an open pool as soon as it is created.** The idea was sound but it removed the driver's accept step the brief asks for (FR-D4). Modified so that matching *identifies and surfaces* candidates (setting the `MATCHED` state) while the driver performs the assignment, and a passenger may join an open pool when the same deterministic rule says they fit.

## Open disclosure

- AI-assisted code is reviewed line by line before commit, and the team can explain, debug, and modify any part of the system live.
- No AI-generated text, data, or asset is presented as human-original work without being checked against the source documents it claims to come from.
- This log is updated as the phases proceed; new accepted and rejected suggestions are appended as they occur.