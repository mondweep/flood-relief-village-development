import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { Village, type VillageCreateProps } from "../src/domain/village.js";

function baseProps(): VillageCreateProps {
  return {
    id: unwrap(villageId("village-1")),
    name: "Rampur",
    district: "Patna",
    state: "Bihar",
    geo: { lat: 25.6, lng: 85.1 },
    population: 1200,
    households: 250,
    affectedFamilies: 80,
    severity: "severe",
  };
}

describe("Village.create", () => {
  it("creates a village with valid props and no damage assessments", () => {
    const result = Village.create(baseProps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("Rampur");
    expect(result.value.district).toBe("Patna");
    expect(result.value.state).toBe("Bihar");
    expect(result.value.geo).toEqual({ lat: 25.6, lng: 85.1 });
    expect(result.value.severity).toBe("severe");
    expect(result.value.damageAssessments).toEqual([]);
    expect(result.value.latestDamageAssessment).toBeNull();
  });

  it("rejects when affectedFamilies exceeds households", () => {
    const result = Village.create({ ...baseProps(), households: 100, affectedFamilies: 101 });
    expect(result.ok).toBe(false);
  });

  it("accepts affectedFamilies equal to households", () => {
    const result = Village.create({ ...baseProps(), households: 100, affectedFamilies: 100 });
    expect(result.ok).toBe(true);
  });

  it("rejects negative population", () => {
    const result = Village.create({ ...baseProps(), population: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects negative households", () => {
    const result = Village.create({ ...baseProps(), households: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects negative affectedFamilies", () => {
    const result = Village.create({ ...baseProps(), affectedFamilies: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer population", () => {
    const result = Village.create({ ...baseProps(), population: 12.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects latitude below -90", () => {
    const result = Village.create({ ...baseProps(), geo: { lat: -91, lng: 0 } });
    expect(result.ok).toBe(false);
  });

  it("rejects latitude above 90", () => {
    const result = Village.create({ ...baseProps(), geo: { lat: 91, lng: 0 } });
    expect(result.ok).toBe(false);
  });

  it("rejects longitude below -180", () => {
    const result = Village.create({ ...baseProps(), geo: { lat: 0, lng: -181 } });
    expect(result.ok).toBe(false);
  });

  it("rejects longitude above 180", () => {
    const result = Village.create({ ...baseProps(), geo: { lat: 0, lng: 181 } });
    expect(result.ok).toBe(false);
  });

  it("accepts boundary geo values", () => {
    const result = Village.create({ ...baseProps(), geo: { lat: -90, lng: 180 } });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = Village.create({ ...baseProps(), name: "  " });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid severity value", () => {
    const result = Village.create({ ...baseProps(), severity: "catastrophic" as never });
    expect(result.ok).toBe(false);
  });
});

describe("Village.recordDamageAssessment", () => {
  function validAssessment() {
    return {
      assessedAt: "2026-02-01T00:00:00.000Z",
      housesDamaged: 10,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 2,
      agricultureHectaresLost: 5.5,
      livestockLost: 3,
    };
  }

  it("appends the assessment and exposes it as the latest", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment(validAssessment());
    expect(result.ok).toBe(true);
    expect(village.damageAssessments).toHaveLength(1);
    expect(village.latestDamageAssessment).toEqual(validAssessment());
  });

  it("is append-only and keeps prior assessments in order", () => {
    const village = unwrap(Village.create(baseProps()));
    unwrap(village.recordDamageAssessment(validAssessment()));
    const second = { ...validAssessment(), assessedAt: "2026-03-01T00:00:00.000Z", housesDamaged: 20 };
    unwrap(village.recordDamageAssessment(second));

    expect(village.damageAssessments).toHaveLength(2);
    expect(village.damageAssessments[0]).toEqual(validAssessment());
    expect(village.latestDamageAssessment).toEqual(second);
  });

  it("rejects a negative housesDamaged count and does not append", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), housesDamaged: -1 });
    expect(result.ok).toBe(false);
    expect(village.damageAssessments).toHaveLength(0);
  });

  it("rejects a negative schoolsDamaged count", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), schoolsDamaged: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative healthCentresDamaged count", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), healthCentresDamaged: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative waterSourcesDamaged count", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), waterSourcesDamaged: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative agricultureHectaresLost value", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), agricultureHectaresLost: -0.1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative livestockLost count", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), livestockLost: -1 });
    expect(result.ok).toBe(false);
  });

  it("accepts an optional notes field", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.recordDamageAssessment({ ...validAssessment(), notes: "Bridge washed out" });
    expect(result.ok).toBe(true);
    expect(village.latestDamageAssessment?.notes).toBe("Bridge washed out");
  });
});

describe("Village.updateSeverity", () => {
  it("updates the severity and returns the previous value", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.updateSeverity("critical");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.previous).toBe("severe");
    expect(village.severity).toBe("critical");
  });

  it("rejects an invalid severity value and leaves severity unchanged", () => {
    const village = unwrap(Village.create(baseProps()));
    const result = village.updateSeverity("apocalyptic" as never);
    expect(result.ok).toBe(false);
    expect(village.severity).toBe("severe");
  });
});

describe("Village encapsulation (regression)", () => {
  function validAssessment() {
    return {
      assessedAt: "2026-02-01T00:00:00.000Z",
      housesDamaged: 10,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 2,
      agricultureHectaresLost: 5.5,
      livestockLost: 3,
    };
  }

  it("demographic fields cannot be assigned directly, so create-time invariants hold for life", () => {
    const village = unwrap(Village.create(baseProps()));

    // households is 250; forging affectedFamilies above it must be impossible
    expect(() => {
      (village as any).affectedFamilies = 9999;
    }).toThrow(TypeError);
    expect(() => {
      (village as any).households = 0;
    }).toThrow(TypeError);

    expect(village.affectedFamilies).toBe(80);
    expect(village.households).toBe(250);
  });

  it("updateDemographics re-runs validation including affectedFamilies <= households", () => {
    const village = unwrap(Village.create(baseProps()));

    const rejected = village.updateDemographics({ affectedFamilies: 251 });
    expect(rejected.ok).toBe(false);
    expect(village.affectedFamilies).toBe(80);

    const alsoRejected = village.updateDemographics({ households: 79 });
    expect(alsoRejected.ok).toBe(false);
    expect(village.households).toBe(250);

    const accepted = village.updateDemographics({ households: 300, affectedFamilies: 300, name: "New Rampur" });
    expect(accepted.ok).toBe(true);
    expect(village.households).toBe(300);
    expect(village.affectedFamilies).toBe(300);
    expect(village.name).toBe("New Rampur");
  });

  it("damageAssessments getter returns a copy — mutating it does not affect the aggregate", () => {
    const village = unwrap(Village.create(baseProps()));
    village.recordDamageAssessment(validAssessment());

    const leaked = village.damageAssessments as unknown as unknown[];
    leaked.push({ forged: true });
    leaked.splice(0, 1);

    expect(village.damageAssessments).toHaveLength(1);
    expect(village.latestDamageAssessment?.housesDamaged).toBe(10);
  });
});
