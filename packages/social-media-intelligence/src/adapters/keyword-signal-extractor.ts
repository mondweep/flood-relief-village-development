import { ok, type Result } from "@afrip/shared-kernel";
import type { ActivityType, Extracted, Source } from "../domain/signal.js";
import type { SignalExtractor } from "../application/ports.js";

interface ActivityRule {
  readonly keywords: readonly string[];
  readonly activityType: ActivityType;
}

/** Ordered by priority — the first matching rule wins. */
const ACTIVITY_RULES: readonly ActivityRule[] = [
  { keywords: ["orphan"], activityType: "orphan_identified" },
  { keywords: ["medical camp"], activityType: "medical_camp" },
  { keywords: ["missing"], activityType: "missing_person" },
  { keywords: ["donat"], activityType: "donation" },
  { keywords: ["distributed", "relief"], activityType: "relief_distribution" },
  { keywords: ["damage", "collapsed", "washed away"], activityType: "infrastructure_damage" },
];

const NEED_KEYWORDS: readonly string[] = ["food", "water", "medical", "shelter", "clothing"];

const VILLAGE_AFTER_PATTERN = /village\s+(?:of\s+)?([A-Z][A-Za-z]+)/;
const VILLAGE_BEFORE_PATTERN = /([A-Z][A-Za-z]+)\s+village/;
const NGO_PATTERN = /\bby\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*)/;

function detectActivityType(lowerText: string): ActivityType | undefined {
  for (const rule of ACTIVITY_RULES) {
    if (rule.keywords.some((keyword) => lowerText.includes(keyword))) {
      return rule.activityType;
    }
  }
  return undefined;
}

function detectNeeds(lowerText: string): string[] {
  return NEED_KEYWORDS.filter((keyword) => lowerText.includes(keyword));
}

function detectVillageName(rawText: string): string | undefined {
  const after = VILLAGE_AFTER_PATTERN.exec(rawText);
  if (after?.[1]) return after[1];
  const before = VILLAGE_BEFORE_PATTERN.exec(rawText);
  if (before?.[1]) return before[1];
  return undefined;
}

function detectNgoName(rawText: string): string | undefined {
  const match = NGO_PATTERN.exec(rawText);
  return match?.[1] ?? undefined;
}

/**
 * Deterministic keyword-rule adapter for the SignalExtractor port, so the
 * context works end-to-end without an LLM behind the anti-corruption layer.
 */
export class KeywordSignalExtractor implements SignalExtractor {
  async extract(rawText: string, _source: Source): Promise<Result<Extracted>> {
    const lowerText = rawText.toLowerCase();
    const extracted: Extracted = {
      villageName: detectVillageName(rawText),
      ngoName: detectNgoName(rawText),
      activityType: detectActivityType(lowerText),
      needs: detectNeeds(lowerText),
    };
    return ok(extracted);
  }
}
