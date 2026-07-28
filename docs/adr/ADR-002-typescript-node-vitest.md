# ADR-002: TypeScript + Node.js with Vitest as the test runner

**Status:** Accepted · **Date:** 2026-07-28

## Context

The concept document's suggested stack is cloud + AI + GIS + mobile. The MVP builds the
domain core, application services and Supabase infrastructure. We need one language across
backend, edge functions and (later) web/mobile, strong typing for DDD value objects, and a
fast test loop for London-School TDD (mock-heavy, thousands of small tests).

## Decision

- **TypeScript (strict)** on **Node.js 22** for all contexts.
- **Vitest** as the test runner: native ESM + TS, `vi.fn()`/`vi.spyOn` for mock-driven
  London-School tests, watch mode for red-green-refactor.
- Domain layer written with **zero runtime dependencies** (pure TS), so it ports unchanged
  to Supabase Edge Functions (Deno) if needed.

## Consequences

- Same types flow from domain to Supabase adapters (`supabase-js`) and future frontends.
- Vitest's mock API is the backbone of behavior-verification tests (see ADR-004).
- Python-based AI pipeline work (post-MVP, BC-8) will live behind ports and can be a
  separate service without changing this decision.
