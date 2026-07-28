# AFRIP — Flood Relief & Village Development Platform

AI-Powered Flood Recovery & Village Development Intelligence Platform: from emergency
relief to long-term village development, one continuous platform.

Built with **Domain-Driven Design**, **hexagonal architecture** and **TDD (London
School)** by a Ruflo agent swarm with model tiers matched to task complexity.

## Layout

| Path | What |
|---|---|
| `docs/prd/PRD.md` | DDD PRD: bounded contexts, ubiquitous language, aggregates, invariants, FR/NFR, phased plan |
| `docs/adr/` | ADR-001…007: architecture, stack, Supabase + public Google Drive, TDD, swarm model mapping, events, privacy |
| `src/shared/` | Shared kernel: `Result`, branded IDs, `Money`, `GeoPoint`, `Clock`/`EventPublisher` ports |
| `src/contexts/<context>/` | One directory per bounded context: `domain/` (pure), `application/` (use cases + ports), `infrastructure/` (Supabase adapters) |
| `supabase/migrations/` | One schema per context; DB-level invariants, RLS default-deny, public aggregate views |
| `.claude/agents/` | Ruflo swarm agent definitions with `model:` tiers (ADR-005) |

## Bounded contexts

`village-registry` · `ngo-coordination` (One Village, One NGO) · `beneficiary-registry` ·
`fund-monitoring` · `recovery-scoring` · `issue-tracking` · `volunteer-management`
(+ `social-intelligence` and `development-planning` modeled in the PRD, post-MVP).

## Develop

```bash
npm install
npm test          # vitest — no database needed; all ports are mocked (ADR-004)
npm run typecheck # strict TypeScript
```

Migrations apply to any Supabase project with `supabase db push` (ADR-003).
