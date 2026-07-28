# ADR-005: Ruflo agent swarm with model tiers matched to task complexity

**Status:** Accepted · **Date:** 2026-07-28

## Context

The build uses a swarm of AI agents initialized with `npx ruflo@latest init` (17 agent
definitions under `.claude/agents/`, hooks, skills, V3 runtime). Model capacity should match
task complexity: frontier models for architecture and complex invariants, mid-tier for
well-specified implementation, small models for mechanical work — controlling cost and
latency without sacrificing correctness where it matters.

## Decision

1. Every Ruflo agent definition carries a `model:` frontmatter key.

   | Tier | Model | Agents | Rationale |
   |---|---|---|---|
   | High | `opus` | core/planner, sparc/architecture, swarm/hierarchical-coordinator, swarm/adaptive-coordinator | Open-ended design, decomposition, orchestration |
   | Mid | `sonnet` | sparc/specification, sparc/refinement, testing/tdd-london-swarm, testing/production-validator, swarm/mesh-coordinator, consensus/{byzantine,raft,security,crdt} | Well-scoped engineering with clear specs |
   | Low | `haiku` | sparc/pseudocode, consensus/{gossip,quorum,performance-benchmarker} | Mechanical/structured transforms |

2. The same rule governs the build swarm per bounded context (complexity from PRD §5):

   | Context | Complexity driver | Model |
   |---|---|---|
   | NGO Coordination | Multi-aggregate invariants (one-NGO, capacity, team roles) | opus |
   | Fund Monitoring | Ledger ordering + anomaly heuristics + Money VO | opus |
   | Village Registry | Aggregate + audit trail, moderate | sonnet |
   | Beneficiary Registry | Duplicate detection window + follow-up rules | sonnet |
   | Recovery Scoring | Pure weighted computation, well-specified | sonnet |
   | Issue Tracking | Status machine + routing policy | sonnet |
   | Volunteer Management | Formulaic CRUD-plus-rules | haiku |

3. Orchestration (decomposition, prompts, verification, merges) runs on the session's
   frontier model; every agent receives the PRD section, FR-IDs and ADR-004 discipline in
   its brief.

## Consequences

- Cost/latency scale with task difficulty rather than being uniform.
- A lower-tier agent's output is protected by the phase-4 verification gate (full suite +
  typecheck) — misassignments surface as red tests, then the work is re-tiered.
