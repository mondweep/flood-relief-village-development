import { describe, expect, it } from "vitest";
import { RecommendActions } from "../src/application/recommend-actions.js";
import type { VillageSituation } from "../src/domain/recommendation-policy.js";

function situation(overrides: Partial<VillageSituation> = {}): VillageSituation {
  return {
    villageId: "village-1",
    composite: 70,
    severity: "minor",
    hasActiveNgo: true,
    daysSinceLastAid: 5,
    ...overrides,
  };
}

async function run(inputs: VillageSituation[]) {
  return new RecommendActions().execute({ situations: inputs });
}

describe("RecommendActions", () => {
  it("recommends urgent_help (priority 1) for critical severity with composite below 40", async () => {
    const result = await run([situation({ severity: "critical", composite: 30 })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContainEqual(
        expect.objectContaining({ villageId: "village-1", type: "urgent_help", priority: 1 }),
      );
    }
  });

  it("recommends urgent_help for severe severity with composite 39", async () => {
    const result = await run([situation({ severity: "severe", composite: 39 })]);
    if (result.ok) {
      expect(result.value.map((r) => r.type)).toContain("urgent_help");
    }
    expect(result.ok).toBe(true);
  });

  it("does not recommend urgent_help when composite is exactly 40", async () => {
    const result = await run([situation({ severity: "critical", composite: 40 })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((r) => r.type)).not.toContain("urgent_help");
  });

  it("does not recommend urgent_help for moderate severity even with a low composite", async () => {
    const result = await run([situation({ severity: "moderate", composite: 10 })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((r) => r.type)).not.toContain("urgent_help");
  });

  it("recommends assign_ngo (priority 1) when there is no active NGO", async () => {
    const result = await run([situation({ hasActiveNgo: false, composite: 80 })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        expect.objectContaining({ type: "assign_ngo", priority: 1 }),
      ]);
    }
  });

  it("recommends ignored_village (priority 2) when daysSinceLastAid exceeds 30", async () => {
    const result = await run([situation({ daysSinceLastAid: 31, composite: 80 })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        expect.objectContaining({ type: "ignored_village", priority: 2 }),
      ]);
    }
  });

  it("does not recommend ignored_village at exactly 30 days or when daysSinceLastAid is null", async () => {
    const result = await run([
      situation({ villageId: "village-1", daysSinceLastAid: 30, composite: 80 }),
      situation({ villageId: "village-2", daysSinceLastAid: null, composite: 80 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((r) => r.type)).not.toContain("ignored_village");
  });

  it("recommends monitor (priority 3) when composite < 60 and nothing else matched", async () => {
    const result = await run([situation({ composite: 59 })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        expect.objectContaining({ villageId: "village-1", type: "monitor", priority: 3 }),
      ]);
    }
  });

  it("does not recommend monitor when composite is 60 or above", async () => {
    const result = await run([situation({ composite: 60 })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("suppresses monitor when another rule matched the same village", async () => {
    const result = await run([situation({ composite: 50, hasActiveNgo: false })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((r) => r.type)).toEqual(["assign_ngo"]);
    }
  });

  it("can produce multiple recommendations for the same village", async () => {
    const result = await run([
      situation({ severity: "critical", composite: 20, hasActiveNgo: false, daysSinceLastAid: 45 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const types = result.value.map((r) => r.type).sort();
      expect(types).toEqual(["assign_ngo", "ignored_village", "urgent_help"]);
      expect(result.value.map((r) => r.type)).not.toContain("monitor");
    }
  });

  it("sorts by priority then composite ascending", async () => {
    const result = await run([
      situation({ villageId: "v-monitor", composite: 55 }),
      situation({ villageId: "v-ignored", composite: 45, daysSinceLastAid: 40 }),
      situation({ villageId: "v-urgent-high", severity: "severe", composite: 35 }),
      situation({ villageId: "v-urgent-low", severity: "critical", composite: 10 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((r) => [r.villageId, r.type, r.priority])).toEqual([
        ["v-urgent-low", "urgent_help", 1],
        ["v-urgent-high", "urgent_help", 1],
        ["v-ignored", "ignored_village", 2],
        ["v-monitor", "monitor", 3],
      ]);
    }
  });

  it("includes a human-readable reason on every recommendation", async () => {
    const result = await run([
      situation({ severity: "critical", composite: 20, hasActiveNgo: false, daysSinceLastAid: 45 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const rec of result.value) {
        expect(rec.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic for the same input", async () => {
    const inputs = [
      situation({ villageId: "a", composite: 50 }),
      situation({ villageId: "b", severity: "severe", composite: 20 }),
    ];
    const first = await run(inputs);
    const second = await run(inputs);
    expect(first).toEqual(second);
  });

  it("returns an empty list for no situations", async () => {
    const result = await run([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("rejects an invalid severity", async () => {
    const bad = situation();
    const result = await run([{ ...bad, severity: "catastrophic" as VillageSituation["severity"] }]);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-finite composite", async () => {
    const result = await run([situation({ composite: Number.NaN })]);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty villageId", async () => {
    const result = await run([situation({ villageId: "" })]);
    expect(result.ok).toBe(false);
  });
});
