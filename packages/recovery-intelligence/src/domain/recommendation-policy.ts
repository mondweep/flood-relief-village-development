export type Severity = "minor" | "moderate" | "severe" | "critical";

const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "critical"];

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

export type RecommendationType = "urgent_help" | "assign_ngo" | "ignored_village" | "monitor";

export interface VillageSituation {
  readonly villageId: string;
  readonly composite: number;
  readonly severity: Severity;
  readonly hasActiveNgo: boolean;
  readonly daysSinceLastAid: number | null;
}

export interface Recommendation {
  readonly villageId: string;
  readonly type: RecommendationType;
  /** 1 = highest urgency, 3 = lowest. */
  readonly priority: 1 | 2 | 3;
  readonly reason: string;
}

export function validateSituation(situation: VillageSituation): string | null {
  if (situation.villageId.trim().length === 0) return "villageId must not be empty";
  if (!Number.isFinite(situation.composite)) return "composite must be a finite number";
  if (!isSeverity(situation.severity)) return `invalid severity: ${String(situation.severity)}`;
  if (situation.daysSinceLastAid !== null && !Number.isFinite(situation.daysSinceLastAid)) {
    return "daysSinceLastAid must be null or a finite number";
  }
  return null;
}

/**
 * Pure, deterministic recommendation rules. Assumes validated situations.
 * Output is sorted by priority (1 first), then composite ascending.
 */
export function recommendActions(situations: readonly VillageSituation[]): Recommendation[] {
  const scored: Array<{ recommendation: Recommendation; composite: number }> = [];

  for (const s of situations) {
    let matched = false;

    if ((s.severity === "critical" || s.severity === "severe") && s.composite < 40) {
      matched = true;
      scored.push({
        composite: s.composite,
        recommendation: {
          villageId: s.villageId,
          type: "urgent_help",
          priority: 1,
          reason: `${s.severity} severity with composite ${s.composite} (below 40) needs urgent help`,
        },
      });
    }

    if (s.hasActiveNgo === false) {
      matched = true;
      scored.push({
        composite: s.composite,
        recommendation: {
          villageId: s.villageId,
          type: "assign_ngo",
          priority: 1,
          reason: "no active NGO is assigned to this village",
        },
      });
    }

    if (s.daysSinceLastAid !== null && s.daysSinceLastAid > 30) {
      matched = true;
      scored.push({
        composite: s.composite,
        recommendation: {
          villageId: s.villageId,
          type: "ignored_village",
          priority: 2,
          reason: `no aid received for ${s.daysSinceLastAid} days (more than 30)`,
        },
      });
    }

    if (!matched && s.composite < 60) {
      scored.push({
        composite: s.composite,
        recommendation: {
          villageId: s.villageId,
          type: "monitor",
          priority: 3,
          reason: `composite ${s.composite} is below 60 — keep the village under observation`,
        },
      });
    }
  }

  scored.sort((a, b) => {
    if (a.recommendation.priority !== b.recommendation.priority) {
      return a.recommendation.priority - b.recommendation.priority;
    }
    return a.composite - b.composite;
  });

  return scored.map((entry) => entry.recommendation);
}
