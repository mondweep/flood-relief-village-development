import type { Signal } from "./signal.js";
import type { AlertType } from "./smart-alert.js";

/** Facts supplied by the Village Registry / NGO Coordination contexts about the signal's village. */
export interface RegistryFacts {
  readonly villageKnown: boolean;
  readonly hasActiveNgo: boolean;
  readonly recentAidTypes: string[];
}

export interface AlertSpec {
  readonly type: AlertType;
  readonly details: string;
}

function normalise(values: readonly string[]): string[] {
  return values.map((v) => v.trim().toLowerCase());
}

function isDuplicateAidLikely(signal: Signal, facts: RegistryFacts): boolean {
  const recent = normalise(facts.recentAidTypes);
  if (recent.includes("food") || recent.includes("relief")) return true;
  const needs = normalise(signal.extracted.needs);
  return recent.some((aid) => needs.includes(aid));
}

/** Deterministic smart-alert policy — pure domain logic, no I/O. */
export function evaluateAlertRules(signal: Signal, facts: RegistryFacts): AlertSpec[] {
  const specs: AlertSpec[] = [];
  const activityType = signal.extracted.activityType;

  if (activityType === "relief_distribution") {
    specs.push({ type: "new_relief_activity", details: "New relief activity reported" });
    if (isDuplicateAidLikely(signal, facts)) {
      specs.push({
        type: "duplicate_aid_likely",
        details: "Relief distribution reported for a village that recently received similar aid",
      });
    }
  }

  if (facts.villageKnown && !facts.hasActiveNgo) {
    specs.push({
      type: "no_ngo_assigned",
      details: "Village is known but has no active NGO assigned",
    });
  }

  if (activityType === "orphan_identified") {
    specs.push({
      type: "possible_orphan_identified",
      details: "Signal indicates a possible orphan",
    });
  }

  const needs = normalise(signal.extracted.needs);
  if (activityType === "medical_camp" || needs.includes("medical")) {
    specs.push({
      type: "medical_support_needed",
      details: "Signal indicates medical support is needed",
    });
  }

  return specs;
}
