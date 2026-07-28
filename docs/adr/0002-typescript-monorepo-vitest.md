# ADR 0002 — TypeScript monorepo (npm workspaces) with Vitest

**Status:** Accepted

## Context
The platform spans many small, strongly-typed domain packages plus future web dashboards and a
Supabase edge-function surface. The team builds with agent swarms, so fast feedback (typecheck +
tests per package) and a single toolchain matter more than polyglot flexibility.

## Decision
- **Language:** TypeScript (strict mode) on Node 22.
- **Repo shape:** single repo, npm workspaces under `packages/*`; one package per bounded context
  plus `@afrip/shared-kernel`.
- **Tests:** Vitest (fast, TS-native, built-in mocking `vi.fn()` suited to London-school TDD).
- **No build step for MVP packages** beyond `tsc --noEmit` typechecking; Vitest runs TS directly.

## Alternatives considered
- Python/FastAPI: weaker end-to-end type sharing with the planned web dashboards.
- Nx/Turborepo: unnecessary orchestration overhead at this size; npm workspaces suffice.
- Jest: slower TS story; Vitest chosen for speed and ESM support.

## Consequences
- `npm test --workspaces` gives whole-platform verification in one command.
- Shared kernel types (VillageId, Money, events) flow to future frontend without codegen.
- Supabase client SDK is TypeScript-native; generated DB types can be added later.
