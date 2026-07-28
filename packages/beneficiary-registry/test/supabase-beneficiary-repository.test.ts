import { describe, expect, it } from "vitest";
import { beneficiaryId, unwrap, villageId } from "@afrip/shared-kernel";
import {
  AID_RECORDS_TABLE,
  BENEFICIARIES_TABLE,
  DUPLICATE_FLAGS_TABLE,
  FOLLOW_UPS_TABLE,
  SupabaseBeneficiaryRepository,
  fromRow,
  toAidRecordRows,
  toDuplicateFlagRows,
  toFollowUpRows,
  toRow,
  type BeneficiaryRow,
} from "../src/adapters/supabase-beneficiary-repository.js";
import { Beneficiary } from "../src/domain/beneficiary.js";
import { createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeBeneficiary(id = "beneficiary-1", village = "village-1"): Beneficiary {
  return unwrap(
    Beneficiary.create({
      id: unwrap(beneficiaryId(id)),
      villageId: unwrap(villageId(village)),
      name: "Sunita Devi",
      category: "widow",
    }),
  );
}

/** Two aid deliveries of the same type by different providers => one duplicate flag. */
function withHistory(beneficiary: Beneficiary): Beneficiary {
  unwrap(
    beneficiary.recordAid({
      aidType: "food",
      providerId: "ngo-1",
      providerType: "ngo",
      deliveredAt: "2026-03-01T00:00:00.000Z",
      notes: "dry ration",
    }),
  );
  unwrap(
    beneficiary.recordAid({
      aidType: "food",
      providerId: "gov-bihar",
      providerType: "government",
      deliveredAt: "2026-03-05T00:00:00.000Z",
    }),
  );
  unwrap(beneficiary.scheduleFollowUp("follow-1", "2026-03-20T00:00:00.000Z"));
  unwrap(beneficiary.scheduleFollowUp("follow-2", "2026-04-20T00:00:00.000Z"));
  unwrap(beneficiary.completeFollowUp("follow-1", "2026-03-21T00:00:00.000Z"));
  return beneficiary;
}

const validRow: BeneficiaryRow = {
  id: "beneficiary-1",
  village_id: "village-1",
  name: "Sunita Devi",
  category: "widow",
};

const noChildren = { aidRecords: [], followUps: [], duplicateFlags: [] };

function seedFor(beneficiary: Beneficiary): Record<string, FakeRow[]> {
  return {
    [BENEFICIARIES_TABLE]: [toRow(beneficiary) as unknown as FakeRow],
    [AID_RECORDS_TABLE]: toAidRecordRows(beneficiary).map((row, i) => ({
      ...row,
      id: i + 1,
    })) as unknown as FakeRow[],
    [FOLLOW_UPS_TABLE]: toFollowUpRows(beneficiary) as unknown as FakeRow[],
    [DUPLICATE_FLAGS_TABLE]: toDuplicateFlagRows(beneficiary).map((row, i) => ({
      ...row,
      id: i + 1,
    })) as unknown as FakeRow[],
  };
}

describe("SupabaseBeneficiaryRepository — schema contract", () => {
  it("writes exactly the columns of beneficiary_registry_beneficiaries", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(makeBeneficiary());

    const upsert = fake.callTo(BENEFICIARIES_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "category",
      "id",
      "name",
      "village_id",
    ]);
    expect(upsert.payload).toEqual(validRow);
  });

  it("writes exactly the columns of beneficiary_registry_aid_records", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(withHistory(makeBeneficiary()));

    const rows = fake.callTo(AID_RECORDS_TABLE, "insert").payload as FakeRow[];
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "aid_type",
      "beneficiary_id",
      "delivered_at",
      "notes",
      "provider_id",
      "provider_type",
    ]);
    expect(rows).toEqual([
      {
        beneficiary_id: "beneficiary-1",
        aid_type: "food",
        provider_id: "ngo-1",
        provider_type: "ngo",
        delivered_at: "2026-03-01T00:00:00.000Z",
        notes: "dry ration",
      },
      {
        beneficiary_id: "beneficiary-1",
        aid_type: "food",
        provider_id: "gov-bihar",
        provider_type: "government",
        delivered_at: "2026-03-05T00:00:00.000Z",
        notes: null,
      },
    ]);
  });

  it("writes exactly the columns of beneficiary_registry_follow_ups", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(withHistory(makeBeneficiary()));

    const rows = fake.callTo(FOLLOW_UPS_TABLE, "insert").payload as FakeRow[];
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "beneficiary_id",
      "completed_at",
      "due_at",
      "id",
    ]);
    expect(rows).toEqual([
      {
        id: "follow-1",
        beneficiary_id: "beneficiary-1",
        due_at: "2026-03-20T00:00:00.000Z",
        completed_at: "2026-03-21T00:00:00.000Z",
      },
      {
        id: "follow-2",
        beneficiary_id: "beneficiary-1",
        due_at: "2026-04-20T00:00:00.000Z",
        completed_at: null,
      },
    ]);
  });

  it("writes exactly the columns of beneficiary_registry_duplicate_flags", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(withHistory(makeBeneficiary()));

    const rows = fake.callTo(DUPLICATE_FLAGS_TABLE, "insert").payload as FakeRow[];
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "aid_type",
      "beneficiary_id",
      "flagged_at",
      "provider_ids",
    ]);
    expect(rows).toEqual([
      {
        beneficiary_id: "beneficiary-1",
        aid_type: "food",
        provider_ids: ["ngo-1", "gov-bihar"],
        flagged_at: "2026-03-05T00:00:00.000Z",
      },
    ]);
  });

  it("clears each child table before re-inserting, keyed by beneficiary_id", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(withHistory(makeBeneficiary()));

    for (const table of [AID_RECORDS_TABLE, FOLLOW_UPS_TABLE, DUPLICATE_FLAGS_TABLE]) {
      expect(fake.callTo(table, "delete").filters).toEqual([
        { type: "eq", column: "beneficiary_id", value: "beneficiary-1" },
      ]);
    }
    expect(fake.calls.map((c) => `${c.operation} ${c.table}`)).toEqual([
      `upsert ${BENEFICIARIES_TABLE}`,
      `delete ${AID_RECORDS_TABLE}`,
      `insert ${AID_RECORDS_TABLE}`,
      `delete ${FOLLOW_UPS_TABLE}`,
      `insert ${FOLLOW_UPS_TABLE}`,
      `delete ${DUPLICATE_FLAGS_TABLE}`,
      `insert ${DUPLICATE_FLAGS_TABLE}`,
    ]);
  });

  it("still clears every child table when all collections are empty", async () => {
    const fake = createFakeSupabase();
    await new SupabaseBeneficiaryRepository(fake.client).save(makeBeneficiary());

    expect(fake.callsTo(AID_RECORDS_TABLE, "delete")).toHaveLength(1);
    expect(fake.callsTo(AID_RECORDS_TABLE, "insert")).toHaveLength(0);
    expect(fake.callsTo(DUPLICATE_FLAGS_TABLE, "insert")).toHaveLength(0);
  });
});

describe("SupabaseBeneficiaryRepository — round trip", () => {
  it("preserves every field and all three child collections", async () => {
    const original = withHistory(makeBeneficiary());
    const fake = createFakeSupabase({ tables: seedFor(original) });

    const found = await new SupabaseBeneficiaryRepository(fake.client).findById(original.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(original.id);
    expect(found?.villageId).toBe(original.villageId);
    expect(found?.name).toBe(original.name);
    expect(found?.category).toBe(original.category);
    expect(found?.aidRecords).toEqual(original.aidRecords);
    expect(found?.followUps).toEqual(original.followUps);
    expect(found?.duplicateFlags).toEqual(original.duplicateFlags);
  });

  it("does not re-derive duplicate flags on rehydration", async () => {
    const original = withHistory(makeBeneficiary());
    expect(original.duplicateFlags).toHaveLength(1);

    const fake = createFakeSupabase({ tables: seedFor(original) });
    const found = await new SupabaseBeneficiaryRepository(fake.client).findById(original.id);

    // Replaying recordAid() would have produced a second, spurious flag.
    expect(found?.duplicateFlags).toHaveLength(1);
  });

  it("keeps a rehydrated aggregate usable: overdue follow-ups still work", async () => {
    const original = withHistory(makeBeneficiary());
    const fake = createFakeSupabase({ tables: seedFor(original) });
    const found = await new SupabaseBeneficiaryRepository(fake.client).findById(original.id);

    const overdue = found?.overdueFollowUps(new Date("2026-05-01T00:00:00.000Z")) ?? [];
    expect(overdue.map((f) => f.id)).toEqual(["follow-2"]);
    expect(found?.completeFollowUp("follow-1", "2026-05-02T00:00:00.000Z").ok).toBe(false);
  });

  it("returns null for an unknown id without reading any child table", async () => {
    const fake = createFakeSupabase({ tables: { [BENEFICIARIES_TABLE]: [] } });
    expect(
      await new SupabaseBeneficiaryRepository(fake.client).findById(unwrap(beneficiaryId("nope"))),
    ).toBeNull();
    expect(fake.callsTo(AID_RECORDS_TABLE)).toHaveLength(0);
  });
});

describe("SupabaseBeneficiaryRepository — filters", () => {
  it("filters listByVillage on village_id", async () => {
    const first = makeBeneficiary("beneficiary-1", "village-1");
    const other = makeBeneficiary("beneficiary-2", "village-2");
    const fake = createFakeSupabase({
      tables: {
        [BENEFICIARIES_TABLE]: [toRow(first), toRow(other)] as unknown as FakeRow[],
      },
    });

    const found = await new SupabaseBeneficiaryRepository(fake.client).listByVillage(
      unwrap(villageId("village-1")),
    );

    expect(found.map((b) => b.id)).toEqual(["beneficiary-1"]);
    expect(fake.callTo(BENEFICIARIES_TABLE, "select").filters).toEqual([
      { type: "eq", column: "village_id", value: "village-1" },
    ]);
  });

  it("reads child rows for the whole page with a single `in` per table", async () => {
    const first = withHistory(makeBeneficiary("beneficiary-1"));
    const second = makeBeneficiary("beneficiary-2");
    const seed = seedFor(first);
    seed[BENEFICIARIES_TABLE] = [toRow(first), toRow(second)] as unknown as FakeRow[];
    const fake = createFakeSupabase({ tables: seed });

    const all = await new SupabaseBeneficiaryRepository(fake.client).listAll();

    expect(all.map((b) => b.id)).toEqual(["beneficiary-1", "beneficiary-2"]);
    expect(all[0]?.aidRecords).toHaveLength(2);
    expect(all[1]?.aidRecords).toHaveLength(0);
    for (const table of [AID_RECORDS_TABLE, FOLLOW_UPS_TABLE, DUPLICATE_FLAGS_TABLE]) {
      expect(fake.callTo(table, "select").filters).toEqual([
        { type: "in", column: "beneficiary_id", value: ["beneficiary-1", "beneficiary-2"] },
      ]);
    }
  });

  it("orders follow-ups by due date with id as a tiebreak (no identity column)", async () => {
    const original = withHistory(makeBeneficiary());
    const fake = createFakeSupabase({ tables: seedFor(original) });
    await new SupabaseBeneficiaryRepository(fake.client).findById(original.id);

    expect(fake.callTo(FOLLOW_UPS_TABLE, "select").orders).toEqual([
      { column: "due_at", ascending: true },
      { column: "id", ascending: true },
    ]);
    expect(fake.callTo(AID_RECORDS_TABLE, "select").orders).toEqual([
      { column: "id", ascending: true },
    ]);
  });

  it("returns an empty list without touching child tables", async () => {
    const fake = createFakeSupabase({ tables: { [BENEFICIARIES_TABLE]: [] } });
    expect(await new SupabaseBeneficiaryRepository(fake.client).listAll()).toEqual([]);
    expect(fake.callsTo(FOLLOW_UPS_TABLE)).toHaveLength(0);
  });
});

describe("SupabaseBeneficiaryRepository — error surfacing", () => {
  it("throws naming the table when the parent select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: BENEFICIARIES_TABLE, operation: "select", message: "relation missing" },
    });
    await expect(
      new SupabaseBeneficiaryRepository(fake.client).findById(unwrap(beneficiaryId("b1"))),
    ).rejects.toThrow(/select on beneficiary_registry_beneficiaries failed: relation missing/);
  });

  it("throws naming the child table when an aid-record select fails", async () => {
    const original = makeBeneficiary();
    const fake = createFakeSupabase({
      tables: { [BENEFICIARIES_TABLE]: [toRow(original) as unknown as FakeRow] },
      failOn: { table: AID_RECORDS_TABLE, operation: "select" },
    });
    await expect(
      new SupabaseBeneficiaryRepository(fake.client).findById(original.id),
    ).rejects.toThrow(/select on beneficiary_registry_aid_records failed/);
  });

  it("throws naming the child table when a follow-up delete fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: FOLLOW_UPS_TABLE, operation: "delete" } });
    await expect(
      new SupabaseBeneficiaryRepository(fake.client).save(withHistory(makeBeneficiary())),
    ).rejects.toThrow(/delete on beneficiary_registry_follow_ups failed/);
  });

  it("throws naming the table when the upsert fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: BENEFICIARIES_TABLE, operation: "upsert" },
    });
    await expect(
      new SupabaseBeneficiaryRepository(fake.client).save(makeBeneficiary()),
    ).rejects.toThrow(/upsert on beneficiary_registry_beneficiaries failed/);
  });
});

describe("SupabaseBeneficiaryRepository — corrupt rows", () => {
  it("throws on an unknown category", () => {
    expect(() => fromRow({ ...validRow, category: "influencer" }, noChildren)).toThrow(
      /corrupt row in beneficiary_registry_beneficiaries \(id=beneficiary-1\).*category/s,
    );
  });

  it("throws on a blank village id", () => {
    expect(() => fromRow({ ...validRow, village_id: "" }, noChildren)).toThrow(
      /corrupt row in beneficiary_registry_beneficiaries/,
    );
  });

  it("throws on an aid record with an unknown aid type", () => {
    expect(() =>
      fromRow(validRow, {
        ...noChildren,
        aidRecords: [
          {
            beneficiary_id: "beneficiary-1",
            aid_type: "crypto",
            provider_id: "ngo-1",
            provider_type: "ngo",
            delivered_at: "2026-03-01T00:00:00.000Z",
            notes: null,
          },
        ],
      }),
    ).toThrow(/corrupt row in beneficiary_registry_beneficiaries.*aidType/s);
  });

  it("throws on a follow-up with an unparseable due date", () => {
    expect(() =>
      fromRow(validRow, {
        ...noChildren,
        followUps: [
          {
            id: "follow-1",
            beneficiary_id: "beneficiary-1",
            due_at: "not-a-date",
            completed_at: null,
          },
        ],
      }),
    ).toThrow(/corrupt row in beneficiary_registry_beneficiaries.*dueAt/s);
  });

  it("throws on duplicate follow-up ids", () => {
    const followUp = {
      id: "follow-1",
      beneficiary_id: "beneficiary-1",
      due_at: "2026-03-20T00:00:00.000Z",
      completed_at: null,
    };
    expect(() => fromRow(validRow, { ...noChildren, followUps: [followUp, followUp] })).toThrow(
      /duplicate follow-up id: follow-1/,
    );
  });

  it("throws on a duplicate flag with no provider ids", () => {
    expect(() =>
      fromRow(validRow, {
        ...noChildren,
        duplicateFlags: [
          {
            beneficiary_id: "beneficiary-1",
            aid_type: "food",
            provider_ids: [],
            flagged_at: "2026-03-05T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/corrupt row in beneficiary_registry_beneficiaries.*providerId/s);
  });

  it("surfaces a corrupt row through findById", async () => {
    const fake = createFakeSupabase({
      tables: { [BENEFICIARIES_TABLE]: [{ ...validRow, name: "   " } as FakeRow] },
    });
    await expect(
      new SupabaseBeneficiaryRepository(fake.client).findById(unwrap(beneficiaryId("beneficiary-1"))),
    ).rejects.toThrow(/corrupt row in beneficiary_registry_beneficiaries \(id=beneficiary-1\)/);
  });
});
