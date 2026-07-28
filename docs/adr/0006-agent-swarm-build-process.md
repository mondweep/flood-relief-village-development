# ADR 0006 — Ruflo agent swarm build with model-to-complexity matching

**Status:** Accepted

## Context
The build is executed by a swarm of AI agents (Ruflo runtime initialised via `npx ruflo@latest
init`; orchestration via the Claude Code Workflow/Agent tools). Bounded contexts are independent
packages (ADR 0001), so they can be built in parallel. Agent model tiers differ in cost and
capability; the instruction is to match model to task complexity.

## Decision
- **Topology:** one build agent per bounded context, fanned out in parallel after the shared
  kernel and package scaffolds exist (avoids write conflicts: each agent owns one package
  directory). A verification wave (test-run + adversarial review agents) follows, then targeted
  fix agents.
- **Model-to-complexity mapping:**

| Complexity | Contexts / tasks | Model |
|---|---|---|
| Low (CRUD-ish workflow, few invariants) | volunteer-management, development-planning, mechanical scaffolds | Haiku |
| Medium (state machines, routing rules) | village-registry, issue-tracking, ngo-coordination | Sonnet |
| High (arithmetic invariants, anomaly rules, weighted scoring, ACL design) | beneficiary-registry, fund-monitoring, recovery-intelligence, social-media-intelligence; review/verify agents | Session default (highest tier) |

- Every build agent follows ADR 0003 (tests first, mocked ports) and must leave its package's
  tests green before finishing.
- Orchestrator (main session) owns: docs, scaffolds, integration, migrations, final verification,
  commits and pushes. Agents never commit.

## Consequences
- Parallel wall-clock build; cost proportional to task difficulty.
- Uniform package layout makes swarm output reviewable and mergeable without conflicts.
- A follow-up verify wave is mandatory because independently-built packages can drift in style or
  miss cross-cutting conventions.
