import { describe, expect, it } from "vitest";
import { AFRIP_SCHEMA, unwrap, villageId } from "@afrip/shared-kernel";
import {
  HISTORY_TABLE,
  INDICES_TABLE,
  SupabaseRecoveryIndexRepository,
  fromRow,
  toHistoryRows,
  toRow,
  type RecoveryIndexRow,
} from "../src/adapters/supabase-recovery-index-repository.js";
import { zeroScores } from "../src/domain/dimensions.js";
import { RecoveryIndex } from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";
import { DEFAULT_CLIENT_SCHEMA, createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeIndex(id = "village-1"): RecoveryIndex {
  const index = RecoveryIndex.create(unwrap(villageId(id)));
  unwrap(index.upsertScores({ water: 44, health: 22 }, Weights.equal(), "2026-03-01T00:00:00.000Z"));
  unwrap(index.upsertScores({ water: 88 }, Weights.equal(), "2026-04-01T00:00:00.000Z"));
  return index;
}

const validRow: RecoveryIndexRow = {
  village_id: "village-1",
  scores: { ...zeroScores(), water: 88, health: 22 },
  composite: 10,
  calculated_at: "2026-04-01T00:00:00.000Z",
};

describe("SupabaseRecoveryIndexRepository — schema contract", () => {
  it("writes exactly the columns of recovery_intelligence_indices", async () => {
    const index = makeIndex();
    const fake = createFakeSupabase();
    await new SupabaseRecoveryIndexRepository(fake.client).save(index);

    const upsert = fake.callTo(INDICES_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "calculated_at",
      "composite",
      "scores",
      "village_id",
    ]);
    expect(upsert.payload).toEqual({
      village_id: "village-1",
      scores: index.scores,
      composite: index.composite,
      calculated_at: "2026-04-01T00:00:00.000Z",
    });
  });

  it("writes exactly the columns of recovery_intelligence_history, oldest first", async () => {
    const fake = createFakeSupabase();
    await new SupabaseRecoveryIndexRepository(fake.client).save(makeIndex());

    const rows = fake.callTo(HISTORY_TABLE, "insert").payload as FakeRow[];
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "calculated_at",
      "composite",
      "village_id",
    ]);
    expect(rows.map((r) => r["calculated_at"])).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]);
  });

  it("reconciles history by clearing it before re-inserting", async () => {
    const fake = createFakeSupabase();
    await new SupabaseRecoveryIndexRepository(fake.client).save(makeIndex());

    expect(fake.callTo(HISTORY_TABLE, "delete").filters).toEqual([
      { type: "eq", column: "village_id", value: "village-1" },
    ]);
    expect(fake.calls.map((c) => `${c.operation} ${c.table}`)).toEqual([
      `upsert ${INDICES_TABLE}`,
      `delete ${HISTORY_TABLE}`,
      `insert ${HISTORY_TABLE}`,
    ]);
  });

  it("refuses to persist an index that has never been calculated (calculated_at is NOT NULL)", async () => {
    const fresh = RecoveryIndex.create(unwrap(villageId("village-9")));
    const fake = createFakeSupabase();
    await expect(new SupabaseRecoveryIndexRepository(fake.client).save(fresh)).rejects.toThrow(
      /never been calculated.*recovery_intelligence_indices.*village-9/s,
    );
  });
});

describe("SupabaseRecoveryIndexRepository — round trip", () => {
  it("preserves scores, composite, calculatedAt and the full history", async () => {
    const original = makeIndex();
    const fake = createFakeSupabase({
      tables: {
        [INDICES_TABLE]: [toRow(original) as unknown as FakeRow],
        [HISTORY_TABLE]: toHistoryRows(original).map((row, index) => ({
          ...row,
          id: index + 1,
        })) as unknown as FakeRow[],
      },
    });

    const found = await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(
      original.villageId,
    );

    expect(found?.villageId).toBe(original.villageId);
    expect(found?.scores).toEqual(original.scores);
    expect(found?.composite).toBe(original.composite);
    expect(found?.calculatedAt).toBe(original.calculatedAt);
    expect(found?.history).toEqual(original.history);
  });

  it("does not recompute the history under today's weights", async () => {
    const original = RecoveryIndex.create(unwrap(villageId("village-1")));
    const waterOnly = unwrap(Weights.of({ ...zeroScores(), water: 1 }));
    unwrap(original.upsertScores({ water: 70 }, waterOnly, "2026-03-01T00:00:00.000Z"));
    expect(original.history[0]?.composite).toBe(70);

    const fake = createFakeSupabase({
      tables: {
        [INDICES_TABLE]: [toRow(original) as unknown as FakeRow],
        [HISTORY_TABLE]: toHistoryRows(original) as unknown as FakeRow[],
      },
    });
    const found = await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(
      original.villageId,
    );

    // Equal weights would have produced 6, not 70.
    expect(found?.history.map((h) => h.composite)).toEqual([70]);
    expect(found?.composite).toBe(70);
  });

  it("keeps a rehydrated index usable: the next upsert appends to the restored history", async () => {
    const original = makeIndex();
    const fake = createFakeSupabase({
      tables: {
        [INDICES_TABLE]: [toRow(original) as unknown as FakeRow],
        [HISTORY_TABLE]: toHistoryRows(original) as unknown as FakeRow[],
      },
    });
    const found = await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(
      original.villageId,
    );

    unwrap(found!.upsertScores({ road: 50 }, Weights.equal(), "2026-05-01T00:00:00.000Z"));

    expect(found?.history).toHaveLength(3);
    expect(found?.calculatedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("filters both reads by village_id and orders history oldest first", async () => {
    const original = makeIndex();
    const fake = createFakeSupabase({
      tables: {
        [INDICES_TABLE]: [toRow(original) as unknown as FakeRow],
        [HISTORY_TABLE]: toHistoryRows(original) as unknown as FakeRow[],
      },
    });
    await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(original.villageId);

    expect(fake.callTo(INDICES_TABLE, "select").filters).toEqual([
      { type: "eq", column: "village_id", value: "village-1" },
    ]);
    const history = fake.callTo(HISTORY_TABLE, "select");
    expect(history.filters).toEqual([{ type: "eq", column: "village_id", value: "village-1" }]);
    expect(history.orders).toEqual([{ column: "id", ascending: true }]);
  });

  it("returns null for an unknown village without reading history", async () => {
    const fake = createFakeSupabase({ tables: { [INDICES_TABLE]: [] } });
    expect(
      await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(
        unwrap(villageId("village-9")),
      ),
    ).toBeNull();
    expect(fake.callsTo(HISTORY_TABLE)).toHaveLength(0);
  });
});

describe("SupabaseRecoveryIndexRepository — error surfacing", () => {
  it("throws naming the table when the index select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: INDICES_TABLE, operation: "select", message: "connection refused" },
    });
    await expect(
      new SupabaseRecoveryIndexRepository(fake.client).findByVillage(unwrap(villageId("v1"))),
    ).rejects.toThrow(/select on recovery_intelligence_indices failed: connection refused/);
  });

  it("throws naming the history table when its select fails", async () => {
    const original = makeIndex();
    const fake = createFakeSupabase({
      tables: { [INDICES_TABLE]: [toRow(original) as unknown as FakeRow] },
      failOn: { table: HISTORY_TABLE, operation: "select" },
    });
    await expect(
      new SupabaseRecoveryIndexRepository(fake.client).findByVillage(original.villageId),
    ).rejects.toThrow(/select on recovery_intelligence_history failed/);
  });

  it("throws naming the history table when its insert fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: HISTORY_TABLE, operation: "insert" } });
    await expect(
      new SupabaseRecoveryIndexRepository(fake.client).save(makeIndex()),
    ).rejects.toThrow(/insert on recovery_intelligence_history failed/);
  });

  it("throws naming the table when the upsert fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: INDICES_TABLE, operation: "upsert" } });
    await expect(new SupabaseRecoveryIndexRepository(fake.client).save(makeIndex())).rejects.toThrow(
      /upsert on recovery_intelligence_indices failed/,
    );
  });
});

describe("SupabaseRecoveryIndexRepository — corrupt rows", () => {
  it("throws on a composite outside 0-100", () => {
    expect(() => fromRow({ ...validRow, composite: 140 }, [])).toThrow(
      /corrupt row in recovery_intelligence_indices \(village_id=village-1\).*composite/s,
    );
  });

  it("throws on a score outside 0-100", () => {
    expect(() => fromRow({ ...validRow, scores: { ...validRow.scores, water: 250 } }, [])).toThrow(
      /corrupt row in recovery_intelligence_indices.*water/s,
    );
  });

  it("throws when the scores JSON is missing a dimension", () => {
    const { water: _water, ...partial } = validRow.scores;
    expect(() =>
      fromRow({ ...validRow, scores: partial as typeof validRow.scores }, []),
    ).toThrow(/missing score for dimension: water/);
  });

  it("throws when the scores JSON has an unknown dimension", () => {
    expect(() =>
      fromRow({ ...validRow, scores: { ...validRow.scores, vibes: 10 } as never }, []),
    ).toThrow(/unknown dimension: vibes/);
  });

  it("throws when scores is not an object at all", () => {
    expect(() => fromRow({ ...validRow, scores: null as never }, [])).toThrow(
      /corrupt row in recovery_intelligence_indices.*scores must be a JSON object/s,
    );
  });

  it("throws on a history row with an out-of-range composite", () => {
    expect(() =>
      fromRow(validRow, [
        { village_id: "village-1", composite: -5, calculated_at: "2026-03-01T00:00:00.000Z" },
      ]),
    ).toThrow(/corrupt row in recovery_intelligence_indices.*history composite/s);
  });

  it("throws on a blank village id", () => {
    expect(() => fromRow({ ...validRow, village_id: "  " }, [])).toThrow(
      /corrupt row in recovery_intelligence_indices/,
    );
  });

  it("surfaces a corrupt row through findByVillage", async () => {
    const fake = createFakeSupabase({
      tables: { [INDICES_TABLE]: [{ ...validRow, composite: 999 } as unknown as FakeRow] },
    });
    await expect(
      new SupabaseRecoveryIndexRepository(fake.client).findByVillage(unwrap(villageId("village-1"))),
    ).rejects.toThrow(/corrupt row in recovery_intelligence_indices \(village_id=village-1\)/);
  });
});

/**
 * In a shared Supabase project `public` belongs to other applications, and
 * supabase-js sends an unqualified `.from()` there without complaint. Every
 * query must name the AFRIP schema.
 */
describe("SupabaseRecoveryIndexRepository — schema targeting", () => {
  it("resolves every query against assam_floods, never public", async () => {
    const fake = createFakeSupabase();
    const repository = new SupabaseRecoveryIndexRepository(fake.client);

    await repository.save(makeIndex());
    await repository.findByVillage(unwrap(villageId("village-1")));

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.schemasUsed()).not.toContain(DEFAULT_CLIENT_SCHEMA);
  });

  it("selects the schema explicitly instead of leaning on the client default", async () => {
    const fake = createFakeSupabase();
    await new SupabaseRecoveryIndexRepository(fake.client).findByVillage(
      unwrap(villageId("village-1")),
    );

    expect(fake.schema).toHaveBeenCalledWith(AFRIP_SCHEMA);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("honours an injected schema so a review environment can be redirected", async () => {
    const fake = createFakeSupabase();
    await new SupabaseRecoveryIndexRepository(fake.client, "assam_floods_review").save(makeIndex());

    expect(fake.schemasUsed()).toEqual(["assam_floods_review"]);
  });
});
