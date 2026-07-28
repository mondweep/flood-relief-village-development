import type { DomainEvent } from "@afrip/shared-kernel";
import type { Dimension } from "../domain/dimensions.js";

export const DAMAGE_ASSESSED_EVENT = "village.damage-assessed.v1";

/** The slice of UpsertDimensionScores the handler needs (London-style seam). */
export interface ScoreRecalculator {
  execute(input: {
    villageId: string;
    scores: Partial<Record<Dimension, number>>;
  }): Promise<unknown>;
}

/**
 * Handler factory for event-driven recalculation. The composition root wires it
 * up as: bus.subscribe(DAMAGE_ASSESSED_EVENT, makeDamageAssessedHandler(useCase)).
 * On each village.damage-assessed.v1 event it triggers a recalculation of that
 * village's recovery index (no score changes — composite recomputed and history
 * appended with current weights).
 */
export function makeDamageAssessedHandler(
  useCase: ScoreRecalculator,
): (event: DomainEvent) => Promise<void> {
  return async (event: DomainEvent) => {
    if (event.name !== DAMAGE_ASSESSED_EVENT) return;
    const raw = (event.payload as Record<string, unknown>)["villageId"];
    if (typeof raw !== "string" || raw.trim().length === 0) return;
    await useCase.execute({ villageId: raw, scores: {} });
  };
}
