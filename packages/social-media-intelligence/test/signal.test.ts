import { describe, expect, it } from "vitest";
import { unwrap, signalId } from "@afrip/shared-kernel";
import { Signal, isSource, isActivityType, type SignalCreateProps } from "../src/domain/signal.js";

function validProps(): SignalCreateProps {
  return {
    id: unwrap(signalId("signal-1")),
    source: "x",
    rawText: "Relief distributed in Rampur village",
    extracted: {
      villageName: "Rampur",
      activityType: "relief_distribution",
      needs: ["food"],
    },
    detectedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("Signal", () => {
  it("creates a signal from valid props", () => {
    const result = Signal.create(validProps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signal = result.value;
    expect(signal.id).toBe("signal-1");
    expect(signal.source).toBe("x");
    expect(signal.rawText).toBe("Relief distributed in Rampur village");
    expect(signal.extracted.villageName).toBe("Rampur");
    expect(signal.extracted.activityType).toBe("relief_distribution");
    expect(signal.extracted.needs).toEqual(["food"]);
    expect(signal.detectedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("rejects an empty rawText", () => {
    const result = Signal.create({ ...validProps(), rawText: "   " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("rawText");
  });

  it("rejects an invalid source", () => {
    const result = Signal.create({
      ...validProps(),
      source: "telegram" as SignalCreateProps["source"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("source");
  });

  it("rejects an invalid activityType", () => {
    const result = Signal.create({
      ...validProps(),
      extracted: {
        needs: [],
        activityType: "party" as NonNullable<SignalCreateProps["extracted"]["activityType"]>,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("activityType");
  });

  it("rejects an empty need entry", () => {
    const result = Signal.create({
      ...validProps(),
      extracted: { needs: ["food", "  "] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("needs");
  });

  it("rejects a detectedAt that is not a valid ISO timestamp", () => {
    const result = Signal.create({ ...validProps(), detectedAt: "not-a-date" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("detectedAt");
  });

  it("allows extracted with no villageName, ngoName or activityType", () => {
    const result = Signal.create({ ...validProps(), extracted: { needs: [] } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extracted.villageName).toBeUndefined();
    expect(result.value.extracted.ngoName).toBeUndefined();
    expect(result.value.extracted.activityType).toBeUndefined();
  });
});

describe("isSource", () => {
  it("accepts every declared source", () => {
    for (const source of [
      "facebook",
      "x",
      "instagram",
      "youtube",
      "news",
      "whatsapp_field_report",
      "other",
    ]) {
      expect(isSource(source)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isSource("telegram")).toBe(false);
    expect(isSource("")).toBe(false);
  });
});

describe("isActivityType", () => {
  it("accepts every declared activity type", () => {
    for (const type of [
      "relief_distribution",
      "medical_camp",
      "infrastructure_damage",
      "orphan_identified",
      "missing_person",
      "donation",
      "other",
    ]) {
      expect(isActivityType(type)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isActivityType("party")).toBe(false);
  });
});
