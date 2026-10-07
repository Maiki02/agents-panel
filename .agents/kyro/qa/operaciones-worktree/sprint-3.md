Verdict: APPROVED WITH NOTES

# Code Review Result

## Summary

Sprint 3 (web-operaciones-y-uso) meets its objective. The usage indicator (`GET /api/usage`, 60 s cache, one read in flight per account, degraded to the passive datum when the SDK call fails) is in the header of every screen. The pilot resumes `sin_cupo_de_uso` at `resetsAt` + 60 s (ADR-0016), using only the account's own windows. The web has the sidebar filters (ADR-0013), the Git tab with per-repo operations, the agent steps, and the repo list with per-repo pull results in Configuración → Repositorio (ADR-0014, ADR-0017). `npm run typecheck`, `npm run lint` and `npm test` pass: shared 8, api 1197, web 304. `kyro doctor --artifacts` passes. `kyro analyze` reports 0 CRITICAL, 0 HIGH and 1 MEDIUM.

## Scope Reviewed

- `apps/api/src/usage/` (repo, routes, sdk-usage, service), `apps/api/src/pilot/autopilot.ts`, `apps/api/src/projects/pull.ts` and `pull-routes.ts`, `app.ts`, `db/migrations.ts`
- `apps/web`: `usage/`, `chats/chat-sidebar.ts`, `chats/chat-filter-logic`, `chats/git/`, `projects/project-repos.section.ts`, `repos-logic`, `ui/` (confirm-modal, usage-bar)
- `packages/shared/src/usage.ts` and its tests
- `apps/api/test`: usage-repo, usage-routes, usage-service, pilot-autopilot, project-pull, guard, db
- `docs/panel-desarrollo.md`, ADR-0012 to ADR-0017, `sprint.json` state

## Findings

### Critical Issues

No critical issues found.

### Major Issues

No major issues found.

### Minor Issues

- `kyro analyze` A001 (MEDIUM): scenario S27 (R9, documentation) has no task coverage. It is planned for sprint 4 per ADR-0015, so it is not blocking.
- The manual walkthrough in a ventas worktree (root and child repos) is not part of this sprint's evidence (ADR-0015). It is guided in `docs/panel-desarrollo.md` and falls to the user before the scope is closed.

## Architecture Alignment

Aligned. Usage is isolated in its own module with a repository and a service. The routes only read, so no CSRF is needed, and they sit behind the session guard. The pilot receives the usage repository as an optional dependency. The web keeps its logic in pure functions with specs (filters, repos, git, usage).

## Security Review

No issues found. `/api/usage` requires a session and mutates nothing. The reset time is never taken from another account (per-account measurement, as CLAUDE.md requires). No secrets are written to docs or logs.

## Code Quality Review

Clear and small modules. The reset time computation is a pure function, `rejectedResetsAt`. No dead code was seen.

## Functional Review

R6 and R7 are covered. The tone thresholds, the degraded mode and `resetsAt` retake are covered by tests. The pull result per repo is kept even when the root fails (ADR-0017).

## Testing Review

Fixtures for the usage response and the rate-limit event, a degraded-mode test, a guard test, and specs of the web logic are all present. The full suite is green.

## Performance and Scalability Review

The 60 s cache and the single read in flight per account bound the cost of the experimental SDK call. The retry wait is at most the weekly window, well below the `setTimeout` limit.

## Reliability Review

A failing SDK read degrades to the passive datum with its age and never returns a 500. With no future `resetsAt` the pilot keeps the 15 minute retry.

## Developer Experience Review

The ADRs record each decision, and the manual walkthrough is documented.

## Core Plan Review

`sprint.json` reports sprint 3 complete, 0 open debt, 0 pending reviews and `nextAction` qa_or_close. The handoff is consistent with the repo. `kyro doctor --artifacts` passes.

## Required Fixes

No required fixes.

## Recommended Improvements

- Cover S27 (R9) in sprint 4 and update `docs/plan.md` and `CLAUDE.md` there.
- Run the manual walkthrough in a ventas worktree and the real PR in agents-panel before closing the scope.

## Final Decision

Approved with notes. The implementation is aligned with the plan and architecture. The notes do not block the close of the sprint.
