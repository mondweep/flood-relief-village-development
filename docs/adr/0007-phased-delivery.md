# ADR 0007 — Phase-wise delivery: Foundations → Accountability → Intelligence

**Status:** Accepted

## Context
The concept document spans 12 modules; building all at once maximises risk and delays feedback.
The PRD orders requirements into three phases with distinct value propositions.

## Decision
Deliver in three phases, each ending with a green test suite and a commit:

1. **Phase 1 — Foundations** (F1.x): shared kernel, village-registry, ngo-coordination,
   beneficiary-registry. Value: every village visible, every village owned, duplicate aid flagged.
2. **Phase 2 — Accountability** (F2.x): fund-monitoring, issue-tracking, recovery-intelligence
   (index). Value: every rupee and complaint traceable; recovery measurable.
3. **Phase 3 — Intelligence & scale** (F3.x): volunteer-management, social-media-intelligence
   (signals + smart alerts over a mocked extractor port), development-planning; Supabase
   migrations covering all contexts. Value: the platform that never leaves.

Deferred beyond this build: dashboards/UI, mobile apps, real social-media integrations, GIS
rendering (PRD §7).

## Consequences
- Each phase is independently demonstrable and revertible.
- Core invariants harden before AI features depend on them.
- The swarm (ADR 0006) maps naturally onto phases 1–3 fan-outs.
