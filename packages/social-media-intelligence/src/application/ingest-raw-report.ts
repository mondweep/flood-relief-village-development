import {
  err,
  ok,
  signalId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { Signal, isSource, type Source } from "../domain/signal.js";
import type { SignalExtractor, SignalRepository } from "./ports.js";

export interface IngestRawReportInput {
  rawText: string;
  source: Source;
}

export interface IngestRawReportOutput {
  signalId: string;
}

export interface IngestRawReportDeps {
  signalRepository: SignalRepository;
  extractor: SignalExtractor;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class IngestRawReport {
  constructor(private readonly deps: IngestRawReportDeps) {}

  async execute(input: IngestRawReportInput): Promise<Result<IngestRawReportOutput>> {
    if (input.rawText.trim().length === 0) return err("rawText must not be empty");
    if (!isSource(input.source)) return err(`invalid source: ${String(input.source)}`);

    const extractedResult = await this.deps.extractor.extract(input.rawText, input.source);
    if (!extractedResult.ok) return err(extractedResult.error);

    const idResult = signalId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const signalResult = Signal.create({
      id: idResult.value,
      source: input.source,
      rawText: input.rawText,
      extracted: extractedResult.value,
      detectedAt: this.deps.clock.now().toISOString(),
    });
    if (!signalResult.ok) return err(signalResult.error);

    const signal = signalResult.value;
    await this.deps.signalRepository.save(signal);

    const event: DomainEvent = {
      name: "signal.detected.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: {
        signalId: signal.id,
        source: signal.source,
        activityType: signal.extracted.activityType ?? null,
      },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ signalId: signal.id });
  }
}
