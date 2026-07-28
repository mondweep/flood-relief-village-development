import { err, ok, type Result } from "@afrip/shared-kernel";
import {
  recommendActions,
  validateSituation,
  type Recommendation,
  type VillageSituation,
} from "../domain/recommendation-policy.js";

export interface RecommendActionsInput {
  situations: VillageSituation[];
}

/** Pure, deterministic prioritisation of villages into recommended actions. */
export class RecommendActions {
  async execute(input: RecommendActionsInput): Promise<Result<Recommendation[]>> {
    for (const situation of input.situations) {
      const error = validateSituation(situation);
      if (error) return err(error);
    }
    return ok(recommendActions(input.situations));
  }
}
