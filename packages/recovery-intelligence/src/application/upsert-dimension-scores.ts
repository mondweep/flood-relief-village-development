import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { Dimension, DimensionScores } from "../domain/dimensions.js";
import { RecoveryIndex } from "../domain/recovery-index.js";
import { Weights } from "../domain/weights.js";
import type { RecoveryIndexRepository, WeightsProvider } from "./ports.js";

export interface UpsertDimensionScoresInput {
  villageId: string;
  /** Partial scores 0-100; dimensions not provided keep their current value (default 0). */
  scores: Partial<Record<Dimension, number>>;
  /** Optional weight override; when omitted the stored weights are used. */
  weights?: Record<Dimension, number>;
}

export interface UpsertDimensionScoresOutput {
  villageId: string;
  scores: DimensionScores;
  composite: number;
  calculatedAt: string;
}

export interface UpsertDimensionScoresDeps {
  repository: RecoveryIndexRepository;
  weightsProvider: WeightsProvider;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class UpsertDimensionScores {
  constructor(private readonly deps: UpsertDimensionScoresDeps) {}

  async execute(input: UpsertDimensionScoresInput): Promise<Result<UpsertDimensionScoresOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    let weights: Weights;
    if (input.weights !== undefined) {
      const weightsResult = Weights.of(input.weights);
      if (!weightsResult.ok) return err(weightsResult.error);
      weights = weightsResult.value;
    } else {
      weights = await this.deps.weightsProvider.get();
    }

    const existing = await this.deps.repository.findByVillage(idResult.value);
    const index = existing ?? RecoveryIndex.create(idResult.value);

    const calculatedAt = this.deps.clock.now().toISOString();
    const upsertResult = index.upsertScores(input.scores, weights, calculatedAt);
    if (!upsertResult.ok) return err(upsertResult.error);

    await this.deps.repository.save(index);

    const event: DomainEvent = {
      name: "recovery.score-calculated.v1",
      occurredAt: calculatedAt,
      payload: { villageId: index.villageId, composite: upsertResult.value.composite },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({
      villageId: index.villageId,
      scores: index.scores,
      composite: upsertResult.value.composite,
      calculatedAt,
    });
  }
}
