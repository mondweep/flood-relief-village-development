import { describe, expect, it } from "vitest";
import { AFRIP_SCHEMA, unwrap, villageId } from "@afrip/shared-kernel";
import {
  DAMAGE_ASSESSMENTS_TABLE,
  SupabaseVillageRepository,
  VILLAGES_TABLE,
  fromRow,
  toDamageAssessmentRows,
  toRow,
  type DamageAssessmentRow,
  type VillageRow,
} from "../src/adapters/supabase-village-repository.js";
import { Village } from "../src/domain/village.js";
import { DEFAULT_CLIENT_SCHEMA, createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeVillage(id = "village-1"): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId(id)),
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1, source: "manual_entry" },
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "severe",
    }),
  );
}

function withAssessments(village: Village): Village {
  unwrap(
    village.recordDamageAssessment({
      assessedAt: "2026-03-01T00:00:00.000Z",
      housesDamaged: 40,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 3,
      agricultureHectaresLost: 12.5,
      livestockLost: 7,
      notes: "first sweep",
    }),
  );
  unwrap(
    village.recordDamageAssessment({
      assessedAt: "2026-03-09T00:00:00.000Z",
      housesDamaged: 55,
      schoolsDamaged: 2,
      healthCentresDamaged: 1,
      waterSourcesDamaged: 4,
      agricultureHectaresLost: 20,
      livestockLost: 9,
    }),
  );
  return village;
}

describe("SupabaseVillageRepository — schema contract", () => {
  it("writes exactly the columns of village_registry_villages", async () => {
    const fake = createFakeSupabase();
    await new SupabaseVillageRepository(fake.client).save(makeVillage());

    const upsert = fake.callTo(VILLAGES_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "affected_families",
      "district",
      "geo_accuracy_metres",
      "geo_captured_at",
      "geo_source",
      "households",
      "id",
      "lat",
      "lng",
      "name",
      "population",
      "severity",
      "state",
    ]);
    expect(upsert.payload).toEqual({
      id: "village-1",
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      lat: 25.6,
      lng: 85.1,
      geo_source: "manual_entry",
      geo_accuracy_metres: null,
      geo_captured_at: null,
      population: 1200,
      households: 250,
      affected_families: 80,
      severity: "severe",
    });
  });

  it("writes exactly the columns of village_registry_damage_assessments", async () => {
    const fake = createFakeSupabase();
    await new SupabaseVillageRepository(fake.client).save(withAssessments(makeVillage()));

    const insert = fake.callTo(DAMAGE_ASSESSMENTS_TABLE, "insert");
    const rows = insert.payload as FakeRow[];
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "agriculture_hectares_lost",
      "assessed_at",
      "health_centres_damaged",
      "houses_damaged",
      "livestock_lost",
      "notes",
      "schools_damaged",
      "village_id",
      "water_sources_damaged",
    ]);
    expect(rows[0]).toEqual({
      village_id: "village-1",
      assessed_at: "2026-03-01T00:00:00.000Z",
      houses_damaged: 40,
      schools_damaged: 1,
      health_centres_damaged: 0,
      water_sources_damaged: 3,
      agriculture_hectares_lost: 12.5,
      livestock_lost: 7,
      notes: "first sweep",
    });
    // Optional notes map to SQL NULL, not to `undefined`.
    expect((rows[1] as FakeRow)["notes"]).toBeNull();
  });

  it("reconciles the child table by clearing it before re-inserting", async () => {
    const fake = createFakeSupabase();
    await new SupabaseVillageRepository(fake.client).save(withAssessments(makeVillage()));

    const del = fake.callTo(DAMAGE_ASSESSMENTS_TABLE, "delete");
    expect(del.filters).toEqual([{ type: "eq", column: "village_id", value: "village-1" }]);

    const order = fake.calls.map((c) => `${c.operation} ${c.table}`);
    expect(order).toEqual([
      `upsert ${VILLAGES_TABLE}`,
      `delete ${DAMAGE_ASSESSMENTS_TABLE}`,
      `insert ${DAMAGE_ASSESSMENTS_TABLE}`,
    ]);
  });

  it("skips the child insert entirely when there are no assessments", async () => {
    const fake = createFakeSupabase();
    await new SupabaseVillageRepository(fake.client).save(makeVillage());
    expect(fake.callsTo(DAMAGE_ASSESSMENTS_TABLE, "insert")).toHaveLength(0);
  });
});

describe("SupabaseVillageRepository — round trip", () => {
  it("preserves every field and the ordered damage assessments", async () => {
    const original = withAssessments(makeVillage());
    const fake = createFakeSupabase({
      tables: {
        [VILLAGES_TABLE]: [toRow(original) as unknown as FakeRow],
        [DAMAGE_ASSESSMENTS_TABLE]: toDamageAssessmentRows(original).map((row, index) => ({
          ...row,
          id: index + 1,
        })) as unknown as FakeRow[],
      },
    });

    const found = await new SupabaseVillageRepository(fake.client).findById(original.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(original.id);
    expect(found?.name).toBe(original.name);
    expect(found?.district).toBe(original.district);
    expect(found?.state).toBe(original.state);
    expect(found?.geo).toEqual(original.geo);
    expect(found?.population).toBe(original.population);
    expect(found?.households).toBe(original.households);
    expect(found?.affectedFamilies).toBe(original.affectedFamilies);
    expect(found?.severity).toBe(original.severity);
    expect(found?.damageAssessments).toEqual(original.damageAssessments);
    expect(found?.latestDamageAssessment).toEqual(original.latestDamageAssessment);
  });

  it("returns null for an unknown id without reading the child table", async () => {
    const fake = createFakeSupabase({ tables: { [VILLAGES_TABLE]: [] } });
    const found = await new SupabaseVillageRepository(fake.client).findById(
      unwrap(villageId("missing")),
    );
    expect(found).toBeNull();
    expect(fake.callsTo(DAMAGE_ASSESSMENTS_TABLE)).toHaveLength(0);
  });

  it("filters findById by id and the child read by village_id", async () => {
    const original = withAssessments(makeVillage());
    const fake = createFakeSupabase({
      tables: {
        [VILLAGES_TABLE]: [toRow(original) as unknown as FakeRow],
        [DAMAGE_ASSESSMENTS_TABLE]: toDamageAssessmentRows(original) as unknown as FakeRow[],
      },
    });
    await new SupabaseVillageRepository(fake.client).findById(original.id);

    expect(fake.callTo(VILLAGES_TABLE, "select").filters).toEqual([
      { type: "eq", column: "id", value: "village-1" },
    ]);
    const childSelect = fake.callTo(DAMAGE_ASSESSMENTS_TABLE, "select");
    expect(childSelect.filters).toEqual([
      { type: "eq", column: "village_id", value: "village-1" },
    ]);
    expect(childSelect.orders).toEqual([{ column: "id", ascending: true }]);
  });

  it("groups child rows per village in listAll", async () => {
    const first = withAssessments(makeVillage("village-1"));
    const second = makeVillage("village-2");
    const fake = createFakeSupabase({
      tables: {
        [VILLAGES_TABLE]: [toRow(first), toRow(second)] as unknown as FakeRow[],
        [DAMAGE_ASSESSMENTS_TABLE]: toDamageAssessmentRows(first).map((row, index) => ({
          ...row,
          id: index + 1,
        })) as unknown as FakeRow[],
      },
    });

    const all = await new SupabaseVillageRepository(fake.client).listAll();

    expect(all.map((v) => v.id)).toEqual(["village-1", "village-2"]);
    expect(all[0]?.damageAssessments).toHaveLength(2);
    expect(all[1]?.damageAssessments).toHaveLength(0);
    expect(fake.callTo(DAMAGE_ASSESSMENTS_TABLE, "select").filters).toEqual([
      { type: "in", column: "village_id", value: ["village-1", "village-2"] },
    ]);
  });

  it("returns an empty list without touching the child table when there are no villages", async () => {
    const fake = createFakeSupabase({ tables: { [VILLAGES_TABLE]: [] } });
    expect(await new SupabaseVillageRepository(fake.client).listAll()).toEqual([]);
    expect(fake.callsTo(DAMAGE_ASSESSMENTS_TABLE)).toHaveLength(0);
  });
});

describe("SupabaseVillageRepository — error surfacing", () => {
  it("throws naming the table when the village select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: VILLAGES_TABLE, operation: "select", message: "connection reset" },
    });
    await expect(
      new SupabaseVillageRepository(fake.client).findById(unwrap(villageId("village-1"))),
    ).rejects.toThrow(/village_registry_villages.*connection reset/s);
  });

  it("throws naming the child table when the child insert fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: DAMAGE_ASSESSMENTS_TABLE, operation: "insert" },
    });
    await expect(
      new SupabaseVillageRepository(fake.client).save(withAssessments(makeVillage())),
    ).rejects.toThrow(/insert on village_registry_damage_assessments failed/);
  });

  it("throws naming the operation when the upsert fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: VILLAGES_TABLE, operation: "upsert" } });
    await expect(new SupabaseVillageRepository(fake.client).save(makeVillage())).rejects.toThrow(
      /upsert on village_registry_villages failed/,
    );
  });
});

describe("SupabaseVillageRepository — corrupt rows", () => {
  const validRow: VillageRow = {
    id: "village-1",
    name: "Rampur",
    district: "Patna",
    state: "Bihar",
    lat: 25.6,
    lng: 85.1,
    geo_source: "manual_entry",
    geo_accuracy_metres: null,
    geo_captured_at: null,
    population: 1200,
    households: 250,
    affected_families: 80,
    severity: "severe",
  };

  it("throws rather than returning a village with an unknown severity", () => {
    expect(() => fromRow({ ...validRow, severity: "apocalyptic" }, [])).toThrow(
      /corrupt row in village_registry_villages \(id=village-1\).*severity/s,
    );
  });

  it("throws when affected_families exceeds households", () => {
    expect(() => fromRow({ ...validRow, affected_families: 900 }, [])).toThrow(
      /corrupt row in village_registry_villages \(id=village-1\)/,
    );
  });

  it("throws on a blank id", () => {
    expect(() => fromRow({ ...validRow, id: "  " }, [])).toThrow(
      /corrupt row in village_registry_villages/,
    );
  });

  it("throws when a child damage-assessment row is invalid", () => {
    const badChild: DamageAssessmentRow = {
      village_id: "village-1",
      assessed_at: "2026-03-01T00:00:00.000Z",
      houses_damaged: -4,
      schools_damaged: 0,
      health_centres_damaged: 0,
      water_sources_damaged: 0,
      agriculture_hectares_lost: 0,
      livestock_lost: 0,
      notes: null,
    };
    expect(() => fromRow(validRow, [badChild])).toThrow(
      /corrupt row in village_registry_damage_assessments \(id=village-1\).*housesDamaged/s,
    );
  });

  it("surfaces a corrupt row through findById instead of yielding a half-built aggregate", async () => {
    const fake = createFakeSupabase({
      tables: { [VILLAGES_TABLE]: [{ ...validRow, severity: "apocalyptic" }] },
    });
    await expect(
      new SupabaseVillageRepository(fake.client).findById(unwrap(villageId("village-1"))),
    ).rejects.toThrow(/corrupt row in village_registry_villages/);
  });
});

/**
 * The regression that matters most in a SHARED Supabase project: `public` is
 * another application's namespace. An adapter that forgets to select a schema
 * does not error — supabase-js quietly resolves `.from(t)` against `public` —
 * so it would read and write over a neighbouring app's tables. These tests fail
 * the moment any query stops naming the AFRIP schema.
 */
describe("SupabaseVillageRepository — schema targeting", () => {
  it("resolves every query against assam_floods, never public", async () => {
    const fake = createFakeSupabase();
    const repository = new SupabaseVillageRepository(fake.client);

    await repository.save(withAssessments(makeVillage()));
    await repository.findById(unwrap(villageId("village-1")));
    await repository.listAll();

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.schemasUsed()).not.toContain(DEFAULT_CLIENT_SCHEMA);
  });

  it("selects the schema explicitly instead of leaning on the client default", async () => {
    const fake = createFakeSupabase();
    await new SupabaseVillageRepository(fake.client).listAll();

    expect(fake.schema).toHaveBeenCalledWith(AFRIP_SCHEMA);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("honours an injected schema so a review environment can be redirected", async () => {
    const fake = createFakeSupabase();
    const repository = new SupabaseVillageRepository(fake.client, "assam_floods_review");

    await repository.save(makeVillage());
    await repository.listAll();

    expect(fake.schemasUsed()).toEqual(["assam_floods_review"]);
  });
});
