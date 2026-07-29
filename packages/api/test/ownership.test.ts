import { AFRIP_SCHEMA, type OwnershipEntry } from "@afrip/shared-kernel";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  OWNERSHIP_CONFLICT_TARGET,
  RECORD_OWNERSHIP_TABLE,
  SupabaseOwnershipRegistry,
} from "../src/ownership.js";
import { createFakeSupabase, type FakeSupabase } from "./fake-supabase-client.js";

const OWNER = "11111111-2222-3333-4444-555555555555";
const OTHER_OWNER = "99999999-8888-7777-6666-555555555555";

const ENTRY: OwnershipEntry = { recordType: "village", recordId: "VIL-001", ownerId: OWNER };

function registry(fake: FakeSupabase): SupabaseOwnershipRegistry {
  return new SupabaseOwnershipRegistry(fake.client, AFRIP_SCHEMA);
}

/**
 * The query builders the fake handed out, in call order.
 *
 * `fake.queries` records WHICH table and operation each call used, which is all
 * most adapters need; the two things this adapter must get exactly right —
 * the upsert's conflict options and the three `eq` narrowings — live in the
 * builder's own `vi.fn` arguments. Reaching them means walking the fake's mock
 * results rather than extending the fake, which is shared with every other
 * API test.
 */
interface FakeBuilder {
  readonly upsert: Mock;
  readonly eq: Mock;
}

function builders(fake: FakeSupabase): FakeBuilder[] {
  const schemaMock = fake.client.schema as unknown as Mock;
  return schemaMock.mock.results.flatMap((schemaResult) => {
    if (schemaResult.type !== "return") return [];
    const fromMock = (schemaResult.value as { from: Mock }).from;
    return fromMock.mock.results.flatMap((fromResult) =>
      fromResult.type === "return" ? [fromResult.value as FakeBuilder] : [],
    );
  });
}

function upsertCalls(fake: FakeSupabase): unknown[][] {
  return builders(fake).flatMap((builder) => builder.upsert.mock.calls as unknown[][]);
}

function eqCalls(fake: FakeSupabase): unknown[][] {
  return builders(fake).flatMap((builder) => builder.eq.mock.calls as unknown[][]);
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("SupabaseOwnershipRegistry.record", () => {
  it("writes to record_ownership in the AFRIP schema, not public", async () => {
    const fake = createFakeSupabase();

    await registry(fake).record(ENTRY);

    expect(fake.tablesTouched()).toEqual([RECORD_OWNERSHIP_TABLE]);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.schemasUsed()).not.toContain("public");
    expect(fake.queriesTo(RECORD_OWNERSHIP_TABLE)[0]?.operation).toBe("upsert");
  });

  it("maps the entry onto the table's columns", async () => {
    const fake = createFakeSupabase();

    await registry(fake).record({ recordType: "issue", recordId: "ISS-7", ownerId: OWNER });

    expect(upsertCalls(fake)[0]?.[0]).toEqual({
      record_type: "issue",
      record_id: "ISS-7",
      owner_id: OWNER,
    });
  });

  /**
   * The flag that makes ownership a historical fact rather than a mutable
   * field. `ignoreDuplicates: true` is `on conflict do nothing`; without it the
   * upsert becomes `do update` and a replayed creation event reassigns the
   * record to whoever replayed it.
   */
  it("upserts on the primary key with ignoreDuplicates, so the first writer wins", async () => {
    const fake = createFakeSupabase();

    await registry(fake).record(ENTRY);

    expect(upsertCalls(fake)[0]?.[1]).toEqual({
      onConflict: OWNERSHIP_CONFLICT_TARGET,
      ignoreDuplicates: true,
    });
    // The conflict target must name the primary key of `record_ownership`
    // (00005). PostgREST resolves it against a real unique constraint.
    expect(OWNERSHIP_CONFLICT_TARGET).toBe("record_type,record_id");
  });

  /**
   * A replay, i.e. the same record arriving a second time under a different
   * actor. The fake has no conflict semantics of its own, so what is asserted
   * is the thing that decides the outcome in Postgres: BOTH writes are
   * do-nothing-on-conflict against the primary key, so the second cannot
   * displace the first no matter who sends it.
   */
  it("cannot reassign an owner when the same record is recorded twice", async () => {
    const fake = createFakeSupabase();
    const ownership = registry(fake);

    await ownership.record(ENTRY);
    await ownership.record({ ...ENTRY, ownerId: OTHER_OWNER });

    const calls = upsertCalls(fake);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toEqual({
        onConflict: OWNERSHIP_CONFLICT_TARGET,
        ignoreDuplicates: true,
      });
    }
    // Never an update or a delete: nothing in this adapter may rewrite history,
    // and 00005 revokes both privileges anyway.
    expect(fake.queriesTo(RECORD_OWNERSHIP_TABLE).map((q) => q.operation)).toEqual([
      "upsert",
      "upsert",
    ]);
  });

  /**
   * The user's village WAS registered. Telling them it was not — or letting a
   * 500 escape from a bookkeeping write that runs after their use case already
   * succeeded — would report a failure that did not happen.
   */
  it("does not throw when the write fails, and logs the symptom", async () => {
    const fake = createFakeSupabase({
      failOn: { table: RECORD_OWNERSHIP_TABLE, message: 'relation "record_ownership" does not exist' },
    });
    const logged = silenceErrors();

    try {
      await expect(registry(fake).record(ENTRY)).resolves.toBeUndefined();

      const message = logged.mock.calls.flat().join(" ");
      // Enough to diagnose it from the log alone: which record, whose, where,
      // why, and what the user will report.
      expect(message).toContain("village:VIL-001");
      expect(message).toContain(OWNER);
      expect(message).toContain(`${AFRIP_SCHEMA}.${RECORD_OWNERSHIP_TABLE}`);
      expect(message).toContain('relation "record_ownership" does not exist');
      expect(message).toContain("403");
      expect(message).toContain("00005_record_ownership.sql");
    } finally {
      logged.mockRestore();
    }
  });

  it("does not throw when the client rejects outright", async () => {
    const fake = createFakeSupabase({
      throwOn: { table: RECORD_OWNERSHIP_TABLE, message: "fetch failed" },
    });
    const logged = silenceErrors();

    try {
      await expect(registry(fake).record(ENTRY)).resolves.toBeUndefined();
      expect(logged.mock.calls.flat().join(" ")).toContain("fetch failed");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("SupabaseOwnershipRegistry.isOwner", () => {
  const QUERY = { recordType: "village", recordId: "VIL-001", ownerId: OWNER } as const;

  it("is true when the store holds a matching row", async () => {
    const fake = createFakeSupabase({
      tables: {
        [RECORD_OWNERSHIP_TABLE]: [
          { record_type: "village", record_id: "VIL-001", owner_id: OWNER },
        ],
      },
    });

    expect(await registry(fake).isOwner(QUERY)).toBe(true);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.queriesTo(RECORD_OWNERSHIP_TABLE)[0]?.operation).toBe("select");
  });

  /**
   * What makes the assertion above mean anything: the row that comes back is
   * the row that was asked for, because all three keys are narrowed
   * server-side. Drop the `owner_id` filter and `isOwner` starts answering true
   * for anybody who asks about a record somebody else created.
   */
  it("narrows the select on all three keys", async () => {
    const fake = createFakeSupabase();

    await registry(fake).isOwner(QUERY);

    expect(eqCalls(fake)).toEqual([
      ["record_type", "village"],
      ["record_id", "VIL-001"],
      ["owner_id", OWNER],
    ]);
  });

  it("is false when nothing owns the record", async () => {
    const fake = createFakeSupabase({ tables: { [RECORD_OWNERSHIP_TABLE]: [] } });

    expect(await registry(fake).isOwner(QUERY)).toBe(false);
  });

  it("is false when someone else owns the record", async () => {
    const fake = createFakeSupabase({ tables: { [RECORD_OWNERSHIP_TABLE]: [] } });

    expect(await registry(fake).isOwner({ ...QUERY, ownerId: OTHER_OWNER })).toBe(false);
  });

  /**
   * Fail closed. Ownership only ever WIDENS rights (ADR 0009), so a store we
   * cannot read must answer false — the direction that refuses — rather than
   * handing out edit rights on records it knows nothing about.
   */
  it("is false — never true — when the lookup fails, and logs why", async () => {
    const fake = createFakeSupabase({
      failOn: { table: RECORD_OWNERSHIP_TABLE, message: "connection reset" },
    });
    const logged = silenceErrors();

    try {
      expect(await registry(fake).isOwner(QUERY)).toBe(false);
      const message = logged.mock.calls.flat().join(" ");
      expect(message).toContain("village:VIL-001");
      expect(message).toContain("connection reset");
    } finally {
      logged.mockRestore();
    }
  });

  it("is false when the client rejects outright", async () => {
    const fake = createFakeSupabase({
      throwOn: { table: RECORD_OWNERSHIP_TABLE, message: "fetch failed" },
    });
    const logged = silenceErrors();

    try {
      expect(await registry(fake).isOwner(QUERY)).toBe(false);
      expect(logged.mock.calls.flat().join(" ")).toContain("fetch failed");
    } finally {
      logged.mockRestore();
    }
  });
});
