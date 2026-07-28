import { err, ok, villageId, type Result } from "@afrip/shared-kernel";
import type { ScoreHistoryEntry } from "../domain/recovery-index.js";
import type { RecoveryIndexRepository } from "./ports.js";

export interface GetScoreHistoryInput {
  villageId: string;
}

export interface GetScoreHistoryOutput {
  villageId: string;
  /** Append-only, oldest first. */
  history: ScoreHistoryEntry[];
}

export interface GetScoreHistoryDeps {
  repository: RecoveryIndexRepository;
}

export class GetScoreHistory {
  constructor(private readonly deps: GetScoreHistoryDeps) {}

  async execute(input: GetScoreHistoryInput): Promise<Result<GetScoreHistoryOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const index = await this.deps.repository.findByVillage(idResult.value);
    if (!index) return err(`No recovery index found for village: ${input.villageId}`);

    return ok({ villageId: index.villageId, history: [...index.history] });
  }
}
