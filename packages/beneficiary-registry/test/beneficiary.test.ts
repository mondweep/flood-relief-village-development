import { describe, expect, it } from "vitest";
import { beneficiaryId, unwrap, villageId } from "@afrip/shared-kernel";
import {
  Beneficiary,
  isAidType,
  isBeneficiaryCategory,
  isProviderType,
  type BeneficiaryCreateProps,
} from "../src/domain/beneficiary.js";

function validProps(): BeneficiaryCreateProps {
  return {
    id: unwrap(beneficiaryId("ben-1")),
    villageId: unwrap(villageId("village-1")),
    name: "Sita Devi",
    category: "widow",
  };
}

function build(overrides: Partial<BeneficiaryCreateProps> = {}): Beneficiary {
  return unwrap(Beneficiary.create({ ...validProps(), ...overrides }));
}

describe("Beneficiary.create", () => {
  it("creates a beneficiary with empty aid records, follow-ups and duplicate flags", () => {
    const result = Beneficiary.create(validProps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.value;
    expect(b.id).toBe("ben-1");
    expect(b.villageId).toBe("village-1");
    expect(b.name).toBe("Sita Devi");
    expect(b.category).toBe("widow");
    expect(b.aidRecords).toHaveLength(0);
    expect(b.followUps).toHaveLength(0);
    expect(b.duplicateFlags).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    const result = Beneficiary.create({ ...validProps(), name: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid category", () => {
    const result = Beneficiary.create({
      ...validProps(),
      category: "unknown" as never,
    });
    expect(result.ok).toBe(false);
  });
});

describe("category / aid-type / provider-type guards", () => {
  it("accepts all nine categories", () => {
    for (const c of [
      "widow",
      "orphan",
      "senior_citizen",
      "disabled",
      "pregnant_woman",
      "farmer",
      "small_business",
      "daily_wage_worker",
      "student",
    ]) {
      expect(isBeneficiaryCategory(c)).toBe(true);
    }
    expect(isBeneficiaryCategory("landlord")).toBe(false);
  });

  it("accepts all six aid types", () => {
    for (const t of ["food", "shelter", "medical", "cash", "livelihood", "education"]) {
      expect(isAidType(t)).toBe(true);
    }
    expect(isAidType("jewellery")).toBe(false);
  });

  it("accepts all three provider types", () => {
    for (const t of ["ngo", "government", "donor"]) {
      expect(isProviderType(t)).toBe(true);
    }
    expect(isProviderType("corporation")).toBe(false);
  });
});

describe("Beneficiary.recordAid", () => {
  it("appends an aid record with notes", () => {
    const b = build();

    const result = b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
      notes: "50kg rice",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duplicateFlag).toBeNull();
    expect(b.aidRecords).toHaveLength(1);
    expect(b.aidRecords[0]).toEqual({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
      notes: "50kg rice",
    });
  });

  it("rejects an invalid aid type, provider type, empty provider id, or bad timestamp", () => {
    const b = build();
    expect(
      b.recordAid({
        aidType: "gold" as never,
        providerId: "p",
        providerType: "ngo",
        deliveredAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
    expect(
      b.recordAid({
        aidType: "food",
        providerId: "p",
        providerType: "corp" as never,
        deliveredAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
    expect(
      b.recordAid({
        aidType: "food",
        providerId: "  ",
        providerType: "ngo",
        deliveredAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
    expect(
      b.recordAid({
        aidType: "food",
        providerId: "p",
        providerType: "ngo",
        deliveredAt: "not-a-date",
      }).ok,
    ).toBe(false);
    expect(b.aidRecords).toHaveLength(0);
  });

  it("flags a duplicate when the same aid type comes from a different provider within 14 days", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "food",
      providerId: "gov-1",
      providerType: "government",
      deliveredAt: "2026-01-14T00:00:00.000Z", // 13 days later
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // aid is STILL recorded
    expect(b.aidRecords).toHaveLength(2);
    expect(b.duplicateFlags).toHaveLength(1);
    expect(result.value.duplicateFlag).toEqual({
      aidType: "food",
      providerIds: ["ngo-1", "gov-1"],
      flaggedAt: "2026-01-14T00:00:00.000Z",
    });
  });

  it("does not flag the same aid type from a different provider 15 days later", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "food",
      providerId: "gov-1",
      providerType: "government",
      deliveredAt: "2026-01-16T00:00:00.000Z", // 15 days later
    });

    expect(result.ok && result.value.duplicateFlag).toBeNull();
    expect(b.duplicateFlags).toHaveLength(0);
    expect(b.aidRecords).toHaveLength(2);
  });

  it("flags at exactly the window boundary (14 days, inclusive)", () => {
    const b = build();
    b.recordAid({
      aidType: "medical",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "medical",
      providerId: "donor-1",
      providerType: "donor",
      deliveredAt: "2026-01-15T00:00:00.000Z", // exactly 14 days
    });

    expect(result.ok && result.value.duplicateFlag).not.toBeNull();
    expect(b.duplicateFlags).toHaveLength(1);
  });

  it("does not flag when the SAME provider repeats the same aid type", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-05T00:00:00.000Z",
    });

    expect(result.ok && result.value.duplicateFlag).toBeNull();
    expect(b.duplicateFlags).toHaveLength(0);
    expect(b.aidRecords).toHaveLength(2);
  });

  it("does not flag a different aid type from a different provider within the window", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "shelter",
      providerId: "gov-1",
      providerType: "government",
      deliveredAt: "2026-01-02T00:00:00.000Z",
    });

    expect(result.ok && result.value.duplicateFlag).toBeNull();
    expect(b.duplicateFlags).toHaveLength(0);
  });

  it("collects every distinct other provider within the window into the flag", () => {
    const b = build();
    b.recordAid({
      aidType: "cash",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
    b.recordAid({
      aidType: "cash",
      providerId: "gov-1",
      providerType: "government",
      deliveredAt: "2026-01-03T00:00:00.000Z",
    });

    const result = b.recordAid({
      aidType: "cash",
      providerId: "donor-1",
      providerType: "donor",
      deliveredAt: "2026-01-05T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duplicateFlag?.providerIds).toEqual(["ngo-1", "gov-1", "donor-1"]);
    // second record already produced one flag (ngo-1 vs gov-1)
    expect(b.duplicateFlags).toHaveLength(2);
  });

  it("honours a configurable windowDays", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
      windowDays: 7,
    });

    const outside = b.recordAid({
      aidType: "food",
      providerId: "gov-1",
      providerType: "government",
      deliveredAt: "2026-01-09T00:00:00.000Z", // 8 days later > 7
      windowDays: 7,
    });
    expect(outside.ok && outside.value.duplicateFlag).toBeNull();

    const inside = b.recordAid({
      aidType: "food",
      providerId: "donor-1",
      providerType: "donor",
      deliveredAt: "2026-01-14T00:00:00.000Z", // 5 days after gov-1
      windowDays: 7,
    });
    expect(inside.ok).toBe(true);
    if (!inside.ok) return;
    expect(inside.value.duplicateFlag?.providerIds).toEqual(["gov-1", "donor-1"]);
  });
});

describe("Beneficiary follow-ups", () => {
  it("schedules a follow-up", () => {
    const b = build();

    const result = b.scheduleFollowUp("fu-1", "2026-02-01T00:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(b.followUps).toHaveLength(1);
    expect(b.followUps[0]).toEqual({ id: "fu-1", dueAt: "2026-02-01T00:00:00.000Z" });
  });

  it("rejects an invalid dueAt or empty id", () => {
    const b = build();
    expect(b.scheduleFollowUp("fu-1", "not-a-date").ok).toBe(false);
    expect(b.scheduleFollowUp("  ", "2026-02-01T00:00:00.000Z").ok).toBe(false);
    expect(b.followUps).toHaveLength(0);
  });

  it("completes a follow-up exactly once", () => {
    const b = build();
    b.scheduleFollowUp("fu-1", "2026-02-01T00:00:00.000Z");

    const first = b.completeFollowUp("fu-1", "2026-02-02T00:00:00.000Z");
    expect(first.ok).toBe(true);
    expect(b.followUps[0]?.completedAt).toBe("2026-02-02T00:00:00.000Z");

    const second = b.completeFollowUp("fu-1", "2026-02-03T00:00:00.000Z");
    expect(second.ok).toBe(false);
    expect(b.followUps[0]?.completedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("errs when completing an unknown follow-up", () => {
    const b = build();
    expect(b.completeFollowUp("missing", "2026-02-02T00:00:00.000Z").ok).toBe(false);
  });

  it("lists overdue follow-ups: due in the past and not completed", () => {
    const b = build();
    b.scheduleFollowUp("fu-past-open", "2026-01-01T00:00:00.000Z");
    b.scheduleFollowUp("fu-past-done", "2026-01-02T00:00:00.000Z");
    b.scheduleFollowUp("fu-future", "2026-03-01T00:00:00.000Z");
    b.completeFollowUp("fu-past-done", "2026-01-03T00:00:00.000Z");

    const overdue = b.overdueFollowUps(new Date("2026-02-01T00:00:00.000Z"));

    expect(overdue.map((f) => f.id)).toEqual(["fu-past-open"]);
  });

  it("does not treat a follow-up due exactly now as overdue", () => {
    const b = build();
    b.scheduleFollowUp("fu-1", "2026-02-01T00:00:00.000Z");
    expect(b.overdueFollowUps(new Date("2026-02-01T00:00:00.000Z"))).toHaveLength(0);
  });
});

describe("Beneficiary encapsulation (regression)", () => {
  it("followUps getter returns copies — completion cannot be forged from outside", () => {
    const b = build();
    b.scheduleFollowUp("fu-1", "2026-01-15T00:00:00.000Z");

    (b.followUps[0] as { completedAt?: string }).completedAt = "2026-01-16T00:00:00.000Z";
    (b.followUps as unknown as unknown[]).push({ id: "forged", dueAt: "2026-01-01T00:00:00.000Z" });

    expect(b.followUps).toHaveLength(1);
    expect(b.followUps[0]?.completedAt).toBeUndefined();
    expect(b.overdueFollowUps(new Date("2026-02-01T00:00:00.000Z"))).toHaveLength(1);
  });

  it("completeFollowUp returns a copy detached from internal state", () => {
    const b = build();
    b.scheduleFollowUp("fu-1", "2026-01-15T00:00:00.000Z");

    const completed = b.completeFollowUp("fu-1", "2026-01-21T00:00:00.000Z");
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    (completed.value as { completedAt?: string }).completedAt = undefined;

    expect(b.followUps[0]?.completedAt).toBe("2026-01-21T00:00:00.000Z");
  });

  it("aidRecords and duplicateFlags getters return copies of the internal arrays", () => {
    const b = build();
    b.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
    b.recordAid({
      aidType: "food",
      providerId: "ngo-2",
      providerType: "ngo",
      deliveredAt: "2026-01-02T00:00:00.000Z",
    });

    (b.aidRecords as unknown as unknown[]).push({ forged: true });
    (b.duplicateFlags as unknown as unknown[]).length = 0;
    (b.duplicateFlags[0]?.providerIds as unknown as unknown[])?.push("forged-provider");

    expect(b.aidRecords).toHaveLength(2);
    expect(b.duplicateFlags).toHaveLength(1);
    expect(b.duplicateFlags[0]?.providerIds).toEqual(["ngo-1", "ngo-2"]);
  });
});
