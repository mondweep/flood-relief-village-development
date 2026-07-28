import { describe, expect, it } from "vitest";
import { unwrap, alertId, signalId } from "@afrip/shared-kernel";
import { SmartAlert, isAlertType, type SmartAlertCreateProps } from "../src/domain/smart-alert.js";

function validProps(): SmartAlertCreateProps {
  return {
    id: unwrap(alertId("alert-1")),
    type: "new_relief_activity",
    signalId: unwrap(signalId("signal-1")),
    villageName: "Rampur",
    details: "New relief activity detected",
    raisedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("SmartAlert", () => {
  it("creates an alert from valid props", () => {
    const result = SmartAlert.create(validProps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alert = result.value;
    expect(alert.id).toBe("alert-1");
    expect(alert.type).toBe("new_relief_activity");
    expect(alert.signalId).toBe("signal-1");
    expect(alert.villageName).toBe("Rampur");
    expect(alert.details).toBe("New relief activity detected");
    expect(alert.raisedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("allows omitting villageName", () => {
    const { villageName: _omitted, ...rest } = validProps();
    const result = SmartAlert.create(rest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.villageName).toBeUndefined();
  });

  it("rejects an invalid alert type", () => {
    const result = SmartAlert.create({
      ...validProps(),
      type: "meteor_strike" as SmartAlertCreateProps["type"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("type");
  });

  it("rejects empty details", () => {
    const result = SmartAlert.create({ ...validProps(), details: "  " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("details");
  });

  it("rejects a raisedAt that is not a valid ISO timestamp", () => {
    const result = SmartAlert.create({ ...validProps(), raisedAt: "yesterday" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("raisedAt");
  });
});

describe("isAlertType", () => {
  it("accepts every declared alert type", () => {
    for (const type of [
      "new_relief_activity",
      "duplicate_aid_likely",
      "no_ngo_assigned",
      "possible_orphan_identified",
      "medical_support_needed",
    ]) {
      expect(isAlertType(type)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isAlertType("meteor_strike")).toBe(false);
  });
});
