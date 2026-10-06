# Project Plan — Dhaka Tesla Pool MVP

**Version:** 2.0.0-draft
**Status:** Approved. Derived from `PRD_Dhaka_Tesla_Pool.md` and `SRS_Dhaka_Tesla_Pool (1).md`.
**Change from v1:** testing was moved out of every phase into a single phase near the end, to keep the build moving. Each coding phase therefore ends with a green build, a green lint, and a manual click-through of its slice — not with tests. Phase 9 writes exactly the six behaviours the brief requires.

## Delivery strategy

Every phase ships something you can click through in a browser. No feature work lands on `master` directly; work happens on `feature/*` branches and is merged when the phase gate is met.

| # | Phase | Branch(es) | Slice delivered | Gate |
|---|---|---|---|---|
| 0 ✅ | Foundation | `feature/scaffold` | Both apps boot, `/api/v1/health` returns 200, container stack, docs | build, lint, unit, e2e, live probe |
| 1 | Identity & the cast | `feature/auth-registration`, `feature/zones-reference` | Sign up/in as passenger or driver → role-aware home screen; zone list served | build, lint, click-through |
| 2 | Request & fare | `feature/ride-request`, `feature/fare-engine` | Passenger requests a ride and sees an exact fare before confirming; history and cancel | build, lint, click-through |
| 3 | Tesla & matchable feed | `feature/tesla-registration`, `feature/matching-engine` | Driver registers Bullet (3 seats), goes online, sees only matching requests | build, lint, click-through |
| 4 | **Pooling & capacity** ⚠️ | `feature/pool-assignment`, `feature/capacity-locking` | Accept → pool opens → second rider joins → last seat claimed | build, lint, click-through, e2e |
| 5 | Lifecycle, audit & final fare | `feature/ride-lifecycle`, `feature/fare-finalisation`, `feature/history-audit` | Arrive → Start → Complete; final fares with sharing discount; timeline reconstructs everything | build, lint, click-through |
| 6 | Money & trust | `feature/payment-teslapay`, `feature/rating` | Cash or TeslaPay settlement with top-up; driver rating | build, lint, click-through |
| 7 | Hardening & isolation | `feature/access-control-audit`, `feature/logging-security` | Cross-account attempts refused everywhere; error envelope; request-id logging | build, lint, click-through |
| 8 | Reproducibility & delivery | `feature/docker-compose`, `feature/seed-demo` | One command from an empty machine to a migrated, seeded demo | build, lint, click-through |
| 9 | **Testing** | `feature/test-capacity`, `feature/test-lifecycle`, `feature/test-isolation`, `feature/test-concurrency` | The six required behaviours, including a genuinely overlapping concurrent claim race | all suites green |
| 10 | Docs, deploy & release | `feature/docs-architecture`, `feature/readme-ai-usage`, `feature/scaling-bonus` → `pre-release` → `release/v1.0.0` | Architecture, ERD, decisions, scaling reasoning, README with justification, deployment, release cut | submission checklist walked item by item |

**Unplanned work delivered between phases — `feat/kinetic-passenger-dashboard`.** The
passenger home screen was rebuilt from an uploaded design specification after Phase 3
merged. It is a presentation slice, not a phase: it adds no endpoint, no migration and
no product rule, and every figure it shows already existed in the API. It was done
before Phase 4 because the screen is where a pooling demo is first seen, and it needed
to be honest about what the API can and cannot answer — `docs/decisions.md` D29/D30,
PRD §9.3 A6–A8, and the brief itself committed as the design source. Consequences a
reviewer should know: the last-ride strip stays invisible until a ride reaches
`COMPLETED` (Phase 5), the progress track only advances once Phase 4 assigns a driver,
and the map stays illustrative until a geo provider is introduced (PRD §9.2).

```mermaid
flowchart LR
    P0[0 Foundation done] --> P1[1 Identity]
    P1 --> P2[2 Request and fare]
    P2 --> P3[3 Matchable feed]
    P3 --> P4[4 Pooling and capacity]
    P4 --> P5[5 Lifecycle and audit]
    P5 --> P6[6 Money and trust]
    P6 --> P7[7 Hardening and isolation]
    P7 --> P8[8 Docker and seed]
    P8 --> P9[9 Testing]
    P9 --> P10[10 Docs deploy release]
    P10 --> R[release/v1.0.0]
```

## Requirement → phase coverage

| Phase | SRS / brief requirements closed |
|---|---|
| 0 | NFR-5 groundwork; brief §9 architecture-first; §10 git hygiene begins |
| 1 | FR-P1, FR-D1, FR-M1, NFR-1, NFR-3 |
| 2 | FR-P2, P3, P5, P6, FR-F1, F2, NFR-3, NFR-6 |
| 3 | FR-D2, D3, FR-M2, M3 |
| 4 | FR-D4, FR-R1, R2, R4, **FR-C1**, **NFR-2** |
| 5 | FR-P4, D5, D6, FR-R3, R5, NFR-4, NFR-3 |
| 6 | FR-F3, optional Payment + Rating (SRS §4.3) |
| 7 | NFR-1 (exhaustive), NFR-3, NFR-4; brief §6 logging / security / error handling |
| 8 | NFR-5, NFR-8 groundwork, brief §6 Docker + §12 seed |
| 9 | SRS §7.3 and brief §12 — the six required behaviours, proven |
| 10 | NFR-8, SRS §7.1 / §7.5 / §7.6 / §7.8, brief §7.5 / §13 / §14 |

## The visual layer, delivered ahead of the phase list

The Kinetic Glass Rails design was applied to every route before the numbered phases
finished, and it is recorded here rather than folded into a phase so it is not
mistaken for phase scope that has not happened yet.

- **Delivered under Phase 4a** (`/dashboard`) and **4b** (the remaining eight routes
  and the three loading boundaries), tracked in `AI_USAGE.md` and `docs/decisions.md`
  D29–D31.
- **It closes no requirement**, and deliberately so. It changes how the existing
  requirements are presented, not which of them are satisfied. The one hard rule
  carried from 4a is unchanged: every figure on screen comes from the API, so no
  phase inherits fabricated numbers from a restyled screen.
- **What it commits later phases to.** Phases 5–8 must keep routing every new surface
  through `frontend/components/ui/` and the `kinetic` daisyUI theme, and must not
  introduce a second panel recipe. A new route that hard-codes a colour or a radius
  is a defect against this plan, not a style preference.
- **What it defers.** There is no dark mode (D31), and visual-regression testing is
  not part of this plan. The nine routes are covered by 227 browser checks that assert
  the theme, palette, radius, chrome and overflow on every one of them, but those are
  throwaway harnesses, not a committed suite — Phase 9 is still where testing is
  meant to be demonstrated.

## Working rules (every phase)

1. **Merge gate** — a branch merges into `master` when build and lint are green and the slice has been clicked through end to end. Commits are conventional (`feat(scope): …`, `fix(…)`, `docs(…)`, `chore(…)`, `test(…)`, `refactor(…)`, `build(…)`). No "update"/"fix"/"final" commits, no filler commits.
2. **Tests are a phase, not a per-phase tax** — Phases 1–8 write no test files; Phase 9 covers the six required behaviours. Known consequence: a regression introduced in Phase 4 surfaces in Phase 9, when fixing it costs more. Mitigated by the build + lint gate and by Phase 7 staying a real phase, since ownership isolation has no test behind it in this plan and must therefore be written carefully rather than retrofitted. **One exception was approved in Phase 3:** `backend/src/tesla/matching.spec.ts`, kept because PRD §5.4 traces user story D3 to a matching unit and because the Phase 3 feed is unfiltered, so a wrong matching predicate is invisible to the browser pass until Phase 4. **A second exception was approved in Phase 4:** the pooling slice ships a committed e2e suite (`test/helpers.ts`, `test/pooling.e2e-spec.ts`, `test/seat-claim-race.e2e-spec.ts`, run via `npm run test:e2e`), because FR-C1/NFR-2 — capacity under concurrency — is the one requirement a browser pass cannot vote on, and a claim race is a defect that only exists between two threads. Both exceptions have the same shape: they witness a rule that cannot be *clicked*, and they run alongside `matching.spec.ts` without replacing Phase 9, which still owns the six formal behaviours. See `AI_USAGE.md`.
3. **Demo checkpoint** at the end of every phase; those recordings feed the six-minute video (brief §13).
4. **Long-lived branches** — `master` → `pre-release` → `release/v1.0.0`. Feature work never lands on `master` directly (brief §10, §16).
5. **Docker truth** — develop against a local PostgreSQL; compose is authored in Phase 0 and verified in Phase 8. Docker is not installed on the development machine, so `docker compose up` verification is a documented limitation per brief §12 until Docker is available.
6. **Assumptions are logged** the moment they are made, into `PRD_Dhaka_Tesla_Pool.md` §9.3 and `docs/decisions.md` (brief §17).
7. **AI usage is disclosed as it happens** in `AI_USAGE.md`, including one accepted and one rejected suggestion (SRS §7.6).
8. **Cast consistency** — Jashim/Bullet, Nusrat, Rafiq, Shirin in seed data, docs, and later tests. Never `user1`/`driver1` (brief §12, §16).

## Gate interpretation

Phase 0's gate reads "migrations apply to an empty DB". Phase 0 ships the migration *runner* and no migration files, so the gate is satisfied by the runner connecting and reporting cleanly against an empty database. The first real migrations (`users`, `zones`) are Phase 1 work, and every later phase's click-through includes applying them.

## Critical path: Phase 4

Phase 4 carries the only genuinely hard requirement — seat capacity under concurrency (FR-C1, NFR-2) — plus the largest number of assumptions, and it is the climax of the demo. Its two schema decisions (one active pool per Tesla, fixed lock order — `docs/decisions.md` D12/D13) are written down before the code, because they change the schema. It gets the most careful review and the most explicit trade-off documentation.

Its gate reads "build, lint, click-through, e2e": the pooling journey suite and the
claim-race witness shipped with the phase (commit `test(api): the pooling journey
and its race, as committed e2e specs`), so the hardest requirement is re-proven every
time the build runs, not only at Phase 9. This is the second approved exception to
the no-test-files rule — same shape as Phase 3's `matching.spec.ts`: a rule the
browser pass cannot confirm by clicking — here, one seat at a time under concurrency.

## Acceptance

Each phase's gate plus the MVP acceptance criteria in `PRD_Dhaka_Tesla_Pool.md` §7.2, walked item by item against the brief's §14 submission checklist before `release/v1.0.0` is cut.