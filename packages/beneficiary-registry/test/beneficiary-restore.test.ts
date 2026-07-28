import { describe, expect, it } from "vitest";
import { beneficiaryId, unwrap, villageId } from "@afrip/shared-kernel";
import {
  Beneficiary,
  type BeneficiaryRestoreProps,
} from "../src/domain/beneficiary.js";

function restoreProps(
  overrides: Partial<BeneficiaryRestoreProps> = {},
): BeneficiaryRestoreProps {
  return {
    id: unwrap(beneficiaryId("ben-1")),
    villageId: unwrap(villageId("village-1")),
    name: "Sita Devi",
    category: "widow",
    aidRecords: [
      {
        aidType: "food",
        providerId: "ngo-1",
        providerType: "ngo",
        deliveredAt: "2026-03-01T00:00:00.000Z",
        notes: "dry ration",
      },
    ],
    followUps: [{ id: "follow-1", dueAt: "2026-03-20T00:00:00.000Z" }],
    duplicateFlags: [
      {
        aidType: "food",
        providerIds: ["ngo-1", "gov-bihar"],
        flaggedAt: "2026-03-05T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("Beneficiary.restore", () => {
  it("rebuilds the aggregate with all three collections", () => {
    const result = Beneficiary.restore(restoreProps());
    expect(result.ok).toBe(true);
    const beneficiary = unwrap(result);

    expect(beneficiary.id).toBe("ben-1");
    expect(beneficiary.villageId).toBe("village-1");
    expect(beneficiary.name).toBe("Sita Devi");
    expect(beneficiary.category).toBe("widow");
    expect(beneficiary.aidRecords).toHaveLength(1);
    expect(beneficiary.followUps).toEqual([
      { id: "follow-1", dueAt: "2026-03-20T00:00:00.000Z" },
    ]);
    expect(beneficiary.duplicateFlags).toEqual([
      {
        aidType: "food",
        providerIds: ["ngo-1", "gov-bihar"],
        flaggedAt: "2026-03-05T00:00:00.000Z",
      },
    ]);
  });

  it("takes the stored duplicate flags verbatim instead of re-deriving them", () => {
    const beneficiary = unwrap(
      Beneficiary.restore(
        restoreProps({
          aidRecords: [
            {
              aidType: "food",
              providerId: "ngo-1",
              providerType: "ngo",
              deliveredAt: "2026-03-01T00:00:00.000Z",
            },
            {
              aidType: "food",
              providerId: "gov-bihar",
              providerType: "government",
              deliveredAt: "2026-03-05T00:00:00.000Z",
            },
          ],
        }),
      ),
    );
    // Replaying recordAid() would have appended a second flag for the same pair.
    expect(beneficiary.duplicateFlags).toHaveLength(1);
  });

  it("copies the inputs so later mutation of the caller's arrays cannot leak in", () => {
    const props = restoreProps();
    const beneficiary = unwrap(Beneficiary.restore(props));
    (props.aidRecords as unknown[]).push({});
    expect(beneficiary.aidRecords).toHaveLength(1);
  });

  it("still enforces the create() invariants", () => {
    expect(Beneficiary.restore(restoreProps({ name: "  " })).ok).toBe(false);
    const badCategory = Beneficiary.restore(
      restoreProps({ category: "influencer" as never }),
    );
    expect(badCategory.ok).toBe(false);
  });

  it("rejects an aid record with an invalid aid type, provider type or provider id", () => {
    const base = {
      aidType: "food" as const,
      providerId: "ngo-1",
      providerType: "ngo" as const,
      deliveredAt: "2026-03-01T00:00:00.000Z",
    };
    expect(
      Beneficiary.restore(restoreProps({ aidRecords: [{ ...base, aidType: "crypto" as never }] })).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(
        restoreProps({ aidRecords: [{ ...base, providerType: "alien" as never }] }),
      ).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(restoreProps({ aidRecords: [{ ...base, providerId: " " }] })).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(restoreProps({ aidRecords: [{ ...base, deliveredAt: "nope" }] })).ok,
    ).toBe(false);
  });

  it("rejects follow-ups that are unusable", () => {
    expect(
      Beneficiary.restore(restoreProps({ followUps: [{ id: "", dueAt: "2026-03-20T00:00:00.000Z" }] }))
        .ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(restoreProps({ followUps: [{ id: "f", dueAt: "not-a-date" }] })).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(
        restoreProps({
          followUps: [{ id: "f", dueAt: "2026-03-20T00:00:00.000Z", completedAt: "nope" }],
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects duplicate follow-up ids, which completeFollowUp could not disambiguate", () => {
    const followUp = { id: "follow-1", dueAt: "2026-03-20T00:00:00.000Z" };
    const result = Beneficiary.restore(restoreProps({ followUps: [followUp, followUp] }));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/duplicate follow-up id: follow-1/);
  });

  it("rejects duplicate flags with no providers, an empty provider or a bad timestamp", () => {
    const base = { aidType: "food" as const, flaggedAt: "2026-03-05T00:00:00.000Z" };
    expect(
      Beneficiary.restore(restoreProps({ duplicateFlags: [{ ...base, providerIds: [] }] })).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(restoreProps({ duplicateFlags: [{ ...base, providerIds: [" "] }] })).ok,
    ).toBe(false);
    expect(
      Beneficiary.restore(
        restoreProps({
          duplicateFlags: [{ aidType: "food", providerIds: ["a"], flaggedAt: "nope" }],
        }),
      ).ok,
    ).toBe(false);
  });

  it("returns a fully live aggregate that keeps enforcing its rules", () => {
    const beneficiary = unwrap(Beneficiary.restore(restoreProps()));

    expect(beneficiary.completeFollowUp("follow-1", "2026-03-21T00:00:00.000Z").ok).toBe(true);
    expect(beneficiary.completeFollowUp("follow-1", "2026-03-22T00:00:00.000Z").ok).toBe(false);
    expect(beneficiary.overdueFollowUps(new Date("2026-04-01T00:00:00.000Z"))).toEqual([]);

    // A later delivery of the same aid type by a new provider is still flagged,
    // measured against the restored history.
    const outcome = unwrap(
      beneficiary.recordAid({
        aidType: "food",
        providerId: "donor-x",
        providerType: "donor",
        deliveredAt: "2026-03-08T00:00:00.000Z",
      }),
    );
    expect(outcome.duplicateFlag?.providerIds).toEqual(["ngo-1", "donor-x"]);
  });

  it("accepts an aggregate with no history at all", () => {
    const empty = unwrap(
      Beneficiary.restore(restoreProps({ aidRecords: [], followUps: [], duplicateFlags: [] })),
    );
    expect(empty.aidRecords).toEqual([]);
    expect(empty.followUps).toEqual([]);
    expect(empty.duplicateFlags).toEqual([]);
  });
});
