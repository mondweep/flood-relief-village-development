import { describe, expect, it } from "vitest";
import { ngoId, unwrap } from "@afrip/shared-kernel";
import {
  NGOS_TABLE,
  SupabaseNgoRepository,
  fromRow,
  toRow,
  type NgoRow,
} from "../src/adapters/supabase-ngo-repository.js";
import { Ngo } from "../src/domain/ngo.js";
import { createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeNgo(id = "ngo-1"): Ngo {
  return unwrap(
    Ngo.create({
      id: unwrap(ngoId(id)),
      name: "Sewa Relief",
      focusAreas: ["water", "shelter"],
      capacity: 3,
    }),
  );
}

const validRow: NgoRow = {
  id: "ngo-1",
  name: "Sewa Relief",
  focus_areas: ["water", "shelter"],
  capacity: 3,
};

describe("SupabaseNgoRepository — schema contract", () => {
  it("writes exactly the columns of ngo_coordination_ngos", async () => {
    const fake = createFakeSupabase();
    await new SupabaseNgoRepository(fake.client).save(makeNgo());

    const upsert = fake.callTo(NGOS_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "capacity",
      "focus_areas",
      "id",
      "name",
    ]);
    expect(upsert.payload).toEqual(validRow);
  });

  it("copies focus areas rather than aliasing the aggregate's array", () => {
    const ngo = makeNgo();
    const row = toRow(ngo);
    row.focus_areas.push("mutated");
    expect(ngo.focusAreas).toEqual(["water", "shelter"]);
  });
});

describe("SupabaseNgoRepository — round trip", () => {
  it("preserves every field", async () => {
    const original = makeNgo();
    const fake = createFakeSupabase({
      tables: { [NGOS_TABLE]: [toRow(original) as unknown as FakeRow] },
    });

    const found = await new SupabaseNgoRepository(fake.client).findById(original.id);

    expect(found?.id).toBe(original.id);
    expect(found?.name).toBe(original.name);
    expect(found?.focusAreas).toEqual(original.focusAreas);
    expect(found?.capacity).toBe(original.capacity);
  });

  it("filters findById by id", async () => {
    const fake = createFakeSupabase({ tables: { [NGOS_TABLE]: [validRow as unknown as FakeRow] } });
    await new SupabaseNgoRepository(fake.client).findById(unwrap(ngoId("ngo-1")));
    expect(fake.callTo(NGOS_TABLE, "select").filters).toEqual([
      { type: "eq", column: "id", value: "ngo-1" },
    ]);
  });

  it("returns undefined (not null) for an unknown id, per the port", async () => {
    const fake = createFakeSupabase({ tables: { [NGOS_TABLE]: [] } });
    expect(await new SupabaseNgoRepository(fake.client).findById(unwrap(ngoId("nope")))).toBeUndefined();
  });
});

describe("SupabaseNgoRepository — error surfacing", () => {
  it("throws naming the table when the select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: NGOS_TABLE, operation: "select", message: "permission denied" },
    });
    await expect(
      new SupabaseNgoRepository(fake.client).findById(unwrap(ngoId("ngo-1"))),
    ).rejects.toThrow(/select on ngo_coordination_ngos failed: permission denied/);
  });

  it("throws naming the table when the upsert fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: NGOS_TABLE, operation: "upsert" } });
    await expect(new SupabaseNgoRepository(fake.client).save(makeNgo())).rejects.toThrow(
      /upsert on ngo_coordination_ngos failed/,
    );
  });
});

describe("SupabaseNgoRepository — corrupt rows", () => {
  it("throws on a capacity below the domain minimum", () => {
    expect(() => fromRow({ ...validRow, capacity: 0 })).toThrow(
      /corrupt row in ngo_coordination_ngos \(id=ngo-1\).*capacity/s,
    );
  });

  it("throws on an empty name", () => {
    expect(() => fromRow({ ...validRow, name: "   " })).toThrow(
      /corrupt row in ngo_coordination_ngos \(id=ngo-1\)/,
    );
  });

  it("throws on a blank id", () => {
    expect(() => fromRow({ ...validRow, id: "" })).toThrow(/corrupt row in ngo_coordination_ngos/);
  });

  it("surfaces a corrupt row through findById", async () => {
    const fake = createFakeSupabase({
      tables: { [NGOS_TABLE]: [{ ...validRow, capacity: -1 } as FakeRow] },
    });
    await expect(
      new SupabaseNgoRepository(fake.client).findById(unwrap(ngoId("ngo-1"))),
    ).rejects.toThrow(/corrupt row in ngo_coordination_ngos/);
  });
});
