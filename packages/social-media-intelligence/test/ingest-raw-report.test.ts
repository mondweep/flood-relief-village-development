import { describe, expect, it, vi } from "vitest";
import {
  CapturingEventPublisher,
  FixedClock,
  SequentialIdGenerator,
  err,
  ok,
} from "@afrip/shared-kernel";
import { IngestRawReport } from "../src/application/ingest-raw-report.js";
import type { SignalExtractor, SignalRepository } from "../src/application/ports.js";
import type { Extracted } from "../src/domain/signal.js";
import { Signal } from "../src/domain/signal.js";

function buildSignalRepository(overrides: Partial<SignalRepository> = {}): SignalRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function buildExtractor(extracted: Extracted): SignalExtractor {
  return { extract: vi.fn().mockResolvedValue(ok(extracted)) };
}

function buildUseCase(overrides: {
  signalRepository?: SignalRepository;
  extractor?: SignalExtractor;
  clock?: FixedClock;
  eventPublisher?: CapturingEventPublisher;
} = {}) {
  const signalRepository = overrides.signalRepository ?? buildSignalRepository();
  const extractor =
    overrides.extractor ??
    buildExtractor({ villageName: "Rampur", activityType: "relief_distribution", needs: ["food"] });
  const clock = overrides.clock ?? new FixedClock(new Date("2026-07-01T00:00:00.000Z"));
  const eventPublisher = overrides.eventPublisher ?? new CapturingEventPublisher();
  const idGenerator = new SequentialIdGenerator("signal");
  const useCase = new IngestRawReport({
    signalRepository,
    extractor,
    clock,
    idGenerator,
    eventPublisher,
  });
  return { useCase, signalRepository, extractor, clock, eventPublisher };
}

describe("IngestRawReport", () => {
  it("passes the exact rawText and source to the extractor port", async () => {
    const { useCase, extractor } = buildUseCase();

    await useCase.execute({ rawText: "Relief distributed in Rampur village", source: "x" });

    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(extractor.extract).toHaveBeenCalledWith("Relief distributed in Rampur village", "x");
  });

  it("saves the signal built from the extractor output and returns its id", async () => {
    const { useCase, signalRepository } = buildUseCase();

    const result = await useCase.execute({ rawText: "Relief distributed", source: "facebook" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signalId).toBe("signal-1");

    expect(signalRepository.save).toHaveBeenCalledTimes(1);
    const saved = (signalRepository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(saved).toBeInstanceOf(Signal);
    expect(saved.id).toBe("signal-1");
    expect(saved.source).toBe("facebook");
    expect(saved.rawText).toBe("Relief distributed");
    expect(saved.extracted).toEqual({
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: ["food"],
    });
    expect(saved.detectedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("emits signal.detected.v1 with signalId, source and activityType", async () => {
    const { useCase, eventPublisher } = buildUseCase();

    await useCase.execute({ rawText: "Relief distributed", source: "news" });

    expect(eventPublisher.eventNames()).toEqual(["signal.detected.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "signal.detected.v1",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: {
        signalId: "signal-1",
        source: "news",
        activityType: "relief_distribution",
      },
    });
  });

  it("emits a null activityType when the extractor found none", async () => {
    const { useCase, eventPublisher } = buildUseCase({
      extractor: buildExtractor({ needs: [] }),
    });

    await useCase.execute({ rawText: "Water levels rising", source: "other" });

    expect(eventPublisher.published[0]?.payload).toEqual({
      signalId: "signal-1",
      source: "other",
      activityType: null,
    });
  });

  it("propagates an extractor error without saving or publishing", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn().mockResolvedValue(err("model unavailable")),
    };
    const { useCase, signalRepository, eventPublisher } = buildUseCase({ extractor });

    const result = await useCase.execute({ rawText: "Relief distributed", source: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("model unavailable");
    expect(signalRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects an empty rawText without calling the extractor", async () => {
    const { useCase, extractor, signalRepository, eventPublisher } = buildUseCase();

    const result = await useCase.execute({ rawText: "   ", source: "x" });

    expect(result.ok).toBe(false);
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(signalRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects an unknown source without calling the extractor", async () => {
    const { useCase, extractor } = buildUseCase();

    const result = await useCase.execute({
      rawText: "Relief distributed",
      source: "telegram" as never,
    });

    expect(result.ok).toBe(false);
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("assigns a fresh signal id per ingested report", async () => {
    const { useCase } = buildUseCase();

    const first = await useCase.execute({ rawText: "Report one", source: "x" });
    const second = await useCase.execute({ rawText: "Report two", source: "x" });

    expect(first.ok && first.value.signalId).toBe("signal-1");
    expect(second.ok && second.value.signalId).toBe("signal-2");
  });
});
