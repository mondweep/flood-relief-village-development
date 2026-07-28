import { describe, expect, it, vi } from "vitest";
import {
  CapturingEventPublisher,
  FixedClock,
  SequentialIdGenerator,
  signalId,
  unwrap,
} from "@afrip/shared-kernel";
import { EvaluateAlerts, type RegistryFacts } from "../src/application/evaluate-alerts.js";
import type { AlertRepository, SignalRepository } from "../src/application/ports.js";
import { Signal, type Extracted, type Source } from "../src/domain/signal.js";
import { SmartAlert } from "../src/domain/smart-alert.js";

function makeSignal(extracted: Extracted, source: Source = "x", raw = "some field report"): Signal {
  return unwrap(
    Signal.create({
      id: unwrap(signalId("signal-1")),
      source,
      rawText: raw,
      extracted,
      detectedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
}

function buildSignalRepository(signal: Signal | null): SignalRepository {
  return {
    findById: vi.fn().mockResolvedValue(signal),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(signal ? [signal] : []),
  };
}

function buildAlertRepository(): AlertRepository {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
  };
}

function facts(overrides: Partial<RegistryFacts> = {}): RegistryFacts {
  return { villageKnown: true, hasActiveNgo: true, recentAidTypes: [], ...overrides };
}

function buildUseCase(signal: Signal | null) {
  const signalRepository = buildSignalRepository(signal);
  const alertRepository = buildAlertRepository();
  const clock = new FixedClock(new Date("2026-07-02T00:00:00.000Z"));
  const idGenerator = new SequentialIdGenerator("alert");
  const eventPublisher = new CapturingEventPublisher();
  const useCase = new EvaluateAlerts({
    signalRepository,
    alertRepository,
    clock,
    idGenerator,
    eventPublisher,
  });
  return { useCase, signalRepository, alertRepository, eventPublisher };
}

function savedAlerts(alertRepository: AlertRepository): SmartAlert[] {
  return (alertRepository.save as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as SmartAlert,
  );
}

describe("EvaluateAlerts", () => {
  it("looks the signal up by its id", async () => {
    const signal = makeSignal({ needs: [] });
    const { useCase, signalRepository } = buildUseCase(signal);

    await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(signalRepository.findById).toHaveBeenCalledTimes(1);
    expect(signalRepository.findById).toHaveBeenCalledWith("signal-1");
  });

  it("raises new_relief_activity for a relief_distribution signal", async () => {
    const signal = makeSignal({
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: [],
    });
    const { useCase, alertRepository, eventPublisher } = buildUseCase(signal);

    const result = await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts).toEqual([{ alertId: "alert-1", type: "new_relief_activity" }]);

    const alerts = savedAlerts(alertRepository);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBeInstanceOf(SmartAlert);
    expect(alerts[0]?.type).toBe("new_relief_activity");
    expect(alerts[0]?.signalId).toBe("signal-1");
    expect(alerts[0]?.villageName).toBe("Rampur");
    expect(alerts[0]?.raisedAt).toBe("2026-07-02T00:00:00.000Z");

    expect(eventPublisher.eventNames()).toEqual(["alert.raised.v1"]);
  });

  it("additionally raises duplicate_aid_likely when recent aid overlaps the signal needs", async () => {
    const signal = makeSignal({
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: ["food", "shelter"],
    });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ recentAidTypes: ["food"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual([
      "new_relief_activity",
      "duplicate_aid_likely",
    ]);
  });

  it("raises duplicate_aid_likely when the village recently received relief aid", async () => {
    const signal = makeSignal({ activityType: "relief_distribution", needs: [] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ recentAidTypes: ["relief"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual([
      "new_relief_activity",
      "duplicate_aid_likely",
    ]);
  });

  it("does not raise duplicate_aid_likely when recent aid has no overlap", async () => {
    const signal = makeSignal({ activityType: "relief_distribution", needs: ["shelter"] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ recentAidTypes: ["medicine"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual(["new_relief_activity"]);
  });

  it("does not raise duplicate_aid_likely for a non-relief signal even with overlapping aid", async () => {
    const signal = makeSignal({ activityType: "donation", needs: ["food"] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ recentAidTypes: ["food"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts).toEqual([]);
  });

  it("raises no_ngo_assigned when the village is known but has no active NGO", async () => {
    const signal = makeSignal({ villageName: "Rampur", needs: [] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ villageKnown: true, hasActiveNgo: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual(["no_ngo_assigned"]);
  });

  it("does not raise no_ngo_assigned for an unknown village", async () => {
    const signal = makeSignal({ needs: [] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ villageKnown: false, hasActiveNgo: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts).toEqual([]);
  });

  it("raises possible_orphan_identified for an orphan_identified signal", async () => {
    const signal = makeSignal({ activityType: "orphan_identified", needs: [] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual(["possible_orphan_identified"]);
  });

  it("raises medical_support_needed for a medical_camp signal", async () => {
    const signal = makeSignal({ activityType: "medical_camp", needs: [] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual(["medical_support_needed"]);
  });

  it("raises medical_support_needed when needs include medical", async () => {
    const signal = makeSignal({ activityType: "other", needs: ["medical"] });
    const { useCase } = buildUseCase(signal);

    const result = await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual(["medical_support_needed"]);
  });

  it("raises multiple alerts, saving and publishing one event per alert", async () => {
    const signal = makeSignal({
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: ["food", "medical"],
    });
    const { useCase, alertRepository, eventPublisher } = buildUseCase(signal);

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ villageKnown: true, hasActiveNgo: false, recentAidTypes: ["food"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts.map((a) => a.type)).toEqual([
      "new_relief_activity",
      "duplicate_aid_likely",
      "no_ngo_assigned",
      "medical_support_needed",
    ]);
    expect(result.value.alerts.map((a) => a.alertId)).toEqual([
      "alert-1",
      "alert-2",
      "alert-3",
      "alert-4",
    ]);

    expect(alertRepository.save).toHaveBeenCalledTimes(4);
    expect(eventPublisher.eventNames()).toEqual([
      "alert.raised.v1",
      "alert.raised.v1",
      "alert.raised.v1",
      "alert.raised.v1",
    ]);
  });

  it("publishes alert.raised.v1 with a primitive-only payload", async () => {
    const signal = makeSignal({
      villageName: "Rampur",
      activityType: "orphan_identified",
      needs: [],
    });
    const { useCase, eventPublisher } = buildUseCase(signal);

    await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(eventPublisher.published[0]).toEqual({
      name: "alert.raised.v1",
      occurredAt: "2026-07-02T00:00:00.000Z",
      payload: {
        alertId: "alert-1",
        alertType: "possible_orphan_identified",
        signalId: "signal-1",
        villageName: "Rampur",
        details: "Signal indicates a possible orphan",
      },
    });
  });

  it("publishes a null villageName when the signal has none", async () => {
    const signal = makeSignal({ activityType: "medical_camp", needs: [] });
    const { useCase, eventPublisher } = buildUseCase(signal);

    await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(eventPublisher.published[0]?.payload).toMatchObject({ villageName: null });
  });

  it("returns an empty alert list without saving or publishing when no rule matches", async () => {
    const signal = makeSignal({ needs: [] });
    const { useCase, alertRepository, eventPublisher } = buildUseCase(signal);

    const result = await useCase.execute({ signalId: "signal-1", registryFacts: facts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts).toEqual([]);
    expect(alertRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("saves nothing and publishes nothing when an alert id fails mid-batch", async () => {
    // relief_distribution + overlapping recent aid -> 2 alerts; the 2nd id is invalid.
    const signal = makeSignal({
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: ["food"],
    });
    const signalRepository = buildSignalRepository(signal);
    const alertRepository = buildAlertRepository();
    const eventPublisher = new CapturingEventPublisher();
    const ids = ["alert-1", ""];
    let call = 0;
    const idGenerator = { next: vi.fn(() => ids[call++] ?? "") };
    const useCase = new EvaluateAlerts({
      signalRepository,
      alertRepository,
      clock: new FixedClock(new Date("2026-07-02T00:00:00.000Z")),
      idGenerator,
      eventPublisher,
    });

    const result = await useCase.execute({
      signalId: "signal-1",
      registryFacts: facts({ recentAidTypes: ["food"] }),
    });

    expect(result.ok).toBe(false);
    expect(idGenerator.next.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(alertRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error when the signal does not exist", async () => {
    const { useCase, alertRepository, eventPublisher } = buildUseCase(null);

    const result = await useCase.execute({ signalId: "signal-404", registryFacts: facts() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("signal-404");
    expect(alertRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error for an empty signal id", async () => {
    const { useCase, signalRepository } = buildUseCase(null);

    const result = await useCase.execute({ signalId: "", registryFacts: facts() });

    expect(result.ok).toBe(false);
    expect(signalRepository.findById).not.toHaveBeenCalled();
  });
});
