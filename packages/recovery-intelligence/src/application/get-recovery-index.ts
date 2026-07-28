import { err, ok, villageId, type Result } from "@afrip/shared-kernel";
import type { DimensionScores } from "../domain/dimensions.js";
import type { RecoveryIndexRepository } from "./ports.js";

export interface GetRecoveryIndexInput {
  villageId: string;
}

export interface RecoveryIndexSnapshot {
  villageId: string;
  scores: DimensionScores;
  composite: number;
  calculatedAt: string | null;
}

export interface GetRecoveryIndexDeps {
  repository: RecoveryIndexRepository;
}

export class GetRecoveryIndex {
  constructor(private readonly deps: GetRecoveryIndexDeps) {}

  async execute(input: GetRecoveryIndexInput): Promise<Result<RecoveryIndexSnapshot>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const index = await this.deps.repository.findByVillage(idResult.value);
    if (!index) return err(`No recovery index found for village: ${input.villageId}`);

    return ok({
      villageId: index.villageId,
      scores: index.scores,
      composite: index.composite,
      calculatedAt: index.calculatedAt,
    });
  }
}
