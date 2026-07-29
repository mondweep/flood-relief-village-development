import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  AFRIP_SCHEMA,
  InMemoryEventBus,
  anonymousActor,
  systemActor,
  userActor,
  type DomainEvent,
} from "@afrip/shared-kernel";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANONYMOUS_ACTOR_ROLE_PREFIX,
  AUDIT_COLUMNS,
  AUDIT_LOG_TABLE,
  AUDIT_SUBJECTS,
  AUDIT_WRITE_FAILED_MARKER,
  AuditLogSubscriber,
  DEFAULT_AUDIT_PAGE_SIZE,
  InMemoryAuditLog,
  MAX_AUDIT_PAGE_SIZE,
  SYSTEM_ACTOR_ROLE_PREFIX,
  SupabaseAuditLog,
  attachAuditLog,
  auditEntryOf,
  flattenActor,
  subjectOf,
  type AuditLog,
} from "../src/audit.js";
import { createFakeSupabase, type FakeSupabase } from "./fake-supabase-client.js";

const USER = userActor({
  id: "11111111-2222-3333-4444-555555555555",
  email: "officer@assam.gov.in",
  role: "district_officer",
});

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    name: "village.registered.v1",
    occurredAt: "2026-07-28T22:09:41.000Z",
    payload: { villageId: "VIL-1", name: "Rampur", district: "Barpeta", severity: "critical" },
    ...overrides,
  };
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

// ---------------------------------------------------------------------------
// Subject mapping
// ---------------------------------------------------------------------------

/**
 * Every `*.v1` literal in every package's `src`, which is the same set the
 * `grep -rhoP '"[a-z-]+\.[a-z-]+\.v1"'` in ADR 0011's implementation notes
 * produces.
 *
 * `packages/api/src/audit.ts` is excluded on purpose: it holds the map under
 * test, so including it would let the map satisfy the assertion with its own
 * contents and the test would pass for any map at all.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AUDIT_SOURCE = resolve(REPO_ROOT, "packages/api/src/audit.ts");

function sourceFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && full !== AUDIT_SOURCE ? [full] : [];
  });
}

function emittedEventNames(): string[] {
  const packages = readdirSync(join(REPO_ROOT, "packages"));
  const names = new Set<string>();
  for (const pkg of packages) {
    for (const file of sourceFiles(join(REPO_ROOT, "packages", pkg, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/"([a-z-]+\.[a-z-]+\.v1)"/g)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names].sort();
}

describe("AUDIT_SUBJECTS", () => {
  /**
   * The build-breaking test ADR 0011 needs. An event added to a use case and not
   * to the map lands with a null subject — correct, and invisible, because you
   * cannot notice a report that quietly omits a row. This is the noticing.
   */
  it("maps every event name emitted anywhere in the platform", () => {
    const unmapped = emittedEventNames().filter((name) => AUDIT_SUBJECTS[name] === undefined);

    expect(unmapped, `add these to AUDIT_SUBJECTS in packages/api/src/audit.ts`).toEqual([]);
  });

  it("has no mapping for an event nothing emits any more", () => {
    const emitted = new Set(emittedEventNames());
    const stale = Object.keys(AUDIT_SUBJECTS).filter((name) => !emitted.has(name));

    expect(stale).toEqual([]);
  });

  it("scans a source tree that actually contains events (guards the scanner itself)", () => {
    // Without this, a scanner that silently found nothing would make the two
    // assertions above pass forever.
    expect(emittedEventNames()).toContain("village.registered.v1");
    // A floor, not an equality: the platform emitted 35 events when this landed
    // and adding a 36th should break exactly one test — the coverage one above,
    // which names the fix — rather than two, one of which is just arithmetic.
    expect(emittedEventNames().length).toBeGreaterThanOrEqual(35);
  });

  it("names a subject type and an id field for every mapping", () => {
    for (const [name, rule] of Object.entries(AUDIT_SUBJECTS)) {
      expect(rule.subjectType, name).toMatch(/^[a-z-]+$/);
      expect(rule.idKey, name).toMatch(/^[a-zA-Z]+Id$/);
    }
  });
});

describe("subjectOf", () => {
  it("reads the subject id out of the payload field the emitting use case writes", () => {
    expect(subjectOf(event())).toEqual({ subjectType: "village", subjectId: "VIL-1" });
  });

  it("uses the aggregate that changed, not the most searchable id in the payload", () => {
    const assigned = event({
      name: "ngo.assigned-to-village.v1",
      payload: { assignmentId: "ASG-1", villageId: "VIL-1", ngoId: "NGO-1" },
    });

    expect(subjectOf(assigned)).toEqual({ subjectType: "assignment", subjectId: "ASG-1" });
  });

  it("maps a recovery score to its village, because the index is keyed by village", () => {
    const scored = event({
      name: "recovery.score-calculated.v1",
      payload: { villageId: "VIL-9", composite: 31 },
    });

    expect(subjectOf(scored)).toEqual({ subjectType: "village", subjectId: "VIL-9" });
  });

  it("returns a null subject for an event name it does not recognise", () => {
    const unknown = event({ name: "chicken.rustled.v1", payload: { chickenId: "CHK-1" } });

    expect(subjectOf(unknown)).toEqual({ subjectType: null, subjectId: null });
  });

  it("keeps the subject type but nulls the id when the payload field is missing", () => {
    const malformed = event({ name: "village.registered.v1", payload: { name: "Rampur" } });

    expect(subjectOf(malformed)).toEqual({ subjectType: "village", subjectId: null });
  });
});

// ---------------------------------------------------------------------------
// Actor flattening
// ---------------------------------------------------------------------------

describe("flattenActor", () => {
  it("keeps a user's id, email and role verbatim", () => {
    expect(flattenActor(USER)).toEqual({
      actorId: "11111111-2222-3333-4444-555555555555",
      actorEmail: "officer@assam.gov.in",
      actorRole: "district_officer",
    });
  });

  it("records WHICH system process acted, rather than discarding the name", () => {
    expect(flattenActor(systemActor("anomaly-sweep"))).toEqual({
      actorId: null,
      actorEmail: null,
      actorRole: `${SYSTEM_ACTOR_ROLE_PREFIX}anomaly-sweep`,
    });
  });

  it("records HOW an anonymous request got in, rather than discarding the via", () => {
    expect(flattenActor(anonymousActor("legacy-token"))).toEqual({
      actorId: null,
      actorEmail: null,
      actorRole: `${ANONYMOUS_ACTOR_ROLE_PREFIX}legacy-token`,
    });
  });

  it("keeps system and anonymous distinguishable — they are different facts", () => {
    const system = flattenActor(systemActor("anomaly-sweep")).actorRole;
    const anonymous = flattenActor(anonymousActor("unauthenticated")).actorRole;

    expect(system).not.toEqual(anonymous);
    expect(system).not.toBeNull();
    expect(anonymous).not.toBeNull();
  });

  it("leaves all three columns null for an unstamped event, inventing no actor", () => {
    expect(flattenActor(undefined)).toEqual({
      actorId: null,
      actorEmail: null,
      actorRole: null,
    });
  });

  it("does not let a system actor be mistaken for a real application role", () => {
    // Roles are bare identifiers; the prefix is what keeps them apart.
    expect(flattenActor(systemActor("anomaly-sweep")).actorRole).toContain(":");
    expect(flattenActor(USER).actorRole).not.toContain(":");
  });
});

describe("auditEntryOf", () => {
  it("carries the payload verbatim, the request id, and no invented id or recordedAt", () => {
    const entry = auditEntryOf(event({ actor: USER, requestId: "req-7" }));

    expect(entry).toEqual({
      id: null,
      eventName: "village.registered.v1",
      occurredAt: "2026-07-28T22:09:41.000Z",
      recordedAt: null,
      actorId: "11111111-2222-3333-4444-555555555555",
      actorEmail: "officer@assam.gov.in",
      actorRole: "district_officer",
      requestId: "req-7",
      subjectType: "village",
      subjectId: "VIL-1",
      payload: { villageId: "VIL-1", name: "Rampur", district: "Barpeta", severity: "critical" },
    });
  });

  it("nulls the request id for work that belongs to no request", () => {
    expect(auditEntryOf(event()).requestId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SupabaseAuditLog.record — driven through the shared fake client
// ---------------------------------------------------------------------------

function builders(fake: FakeSupabase): { insert: Mock }[] {
  const schemaMock = fake.client.schema as unknown as Mock;
  return schemaMock.mock.results.flatMap((schemaResult) => {
    if (schemaResult.type !== "return") return [];
    const fromMock = (schemaResult.value as { from: Mock }).from;
    return fromMock.mock.results.flatMap((fromResult) =>
      fromResult.type === "return" ? [fromResult.value as { insert: Mock }] : [],
    );
  });
}

function insertedRows(fake: FakeSupabase): unknown[] {
  return builders(fake).flatMap((builder) => builder.insert.mock.calls.map((call) => call[0]));
}

describe("SupabaseAuditLog.record", () => {
  it("writes to audit_log in the AFRIP schema, not public", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client, AFRIP_SCHEMA).record(event());

    expect(fake.tablesTouched()).toEqual([AUDIT_LOG_TABLE]);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.schemasUsed()).not.toContain("public");
  });

  it("defaults to the AFRIP schema when the caller does not name one", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client).record(event());

    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
  });

  it("inserts rather than upserts — two identical events happened twice", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client).record(event());
    await new SupabaseAuditLog(fake.client).record(event());

    expect(fake.queriesTo(AUDIT_LOG_TABLE).map((q) => q.operation)).toEqual(["insert", "insert"]);
    expect(insertedRows(fake)).toHaveLength(2);
  });

  it("maps the event onto the table's columns", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client).record(event({ actor: USER, requestId: "req-7" }));

    expect(insertedRows(fake)[0]).toEqual({
      event_name: "village.registered.v1",
      occurred_at: "2026-07-28T22:09:41.000Z",
      actor_id: "11111111-2222-3333-4444-555555555555",
      actor_email: "officer@assam.gov.in",
      actor_role: "district_officer",
      request_id: "req-7",
      subject_type: "village",
      subject_id: "VIL-1",
      payload: { villageId: "VIL-1", name: "Rampur", district: "Barpeta", severity: "critical" },
    });
  });

  it("leaves id and recorded_at to the database", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client).record(event());

    expect(Object.keys(insertedRows(fake)[0] as object)).not.toContain("id");
    expect(Object.keys(insertedRows(fake)[0] as object)).not.toContain("recorded_at");
  });

  it("still writes an unrecognised event, with a null subject", async () => {
    const fake = createFakeSupabase();

    await new SupabaseAuditLog(fake.client).record(
      event({ name: "chicken.rustled.v1", payload: { chickenId: "CHK-1" } }),
    );

    expect(insertedRows(fake)[0]).toMatchObject({
      event_name: "chicken.rustled.v1",
      subject_type: null,
      subject_id: null,
      payload: { chickenId: "CHK-1" },
    });
  });

  it("throws when the insert is refused, so the subscriber can count it", async () => {
    const fake = createFakeSupabase({ failOn: { table: AUDIT_LOG_TABLE, message: "no such table" } });

    await expect(new SupabaseAuditLog(fake.client).record(event())).rejects.toThrow("no such table");
  });

  it("propagates a transport rejection rather than swallowing it", async () => {
    const fake = createFakeSupabase({ throwOn: { table: AUDIT_LOG_TABLE, message: "fetch failed" } });

    await expect(new SupabaseAuditLog(fake.client).record(event())).rejects.toThrow("fetch failed");
  });
});

// ---------------------------------------------------------------------------
// SupabaseAuditLog.query
// ---------------------------------------------------------------------------

/**
 * A recording Supabase double for the READ path.
 *
 * `fake-supabase-client.ts` deliberately does not do this — its own header says
 * it exists to record WHICH table an adapter touched, "not how any single row
 * round-trips" — and it offers no range operators. Extending it would change a
 * double shared by every other API test for one adapter's benefit, which
 * `ownership.test.ts` already declined to do for the same reason. So the read
 * path gets a local `vi.fn()` double and the write path above keeps using the
 * shared fake.
 */
interface QueryDouble {
  client: SupabaseClient;
  /** Every builder method called, in order: ["eq", "subject_type", "village"], … */
  chain: unknown[][];
  select: Mock;
  order: Mock;
  limit: Mock;
}

function createQueryDouble(
  rows: Record<string, unknown>[],
  options: { error?: string; reject?: string } = {},
): QueryDouble {
  const chain: unknown[][] = [];
  const record = (method: string) =>
    vi.fn((...args: unknown[]) => {
      chain.push([method, ...args]);
      return builder;
    });

  const settle = () => {
    if (options.reject !== undefined) return Promise.reject(new Error(options.reject));
    if (options.error !== undefined) {
      return Promise.resolve({ data: null, error: { message: options.error } });
    }
    return Promise.resolve({ data: rows, error: null });
  };

  const builder = {
    select: record("select"),
    eq: record("eq"),
    gte: record("gte"),
    lte: record("lte"),
    lt: record("lt"),
    order: record("order"),
    limit: record("limit"),
    then: (
      onFulfilled: (value: { data: unknown; error: { message: string } | null }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => settle().then(onFulfilled, onRejected),
  };

  const from = vi.fn(() => builder);
  const client = { schema: vi.fn(() => ({ from })), from } as unknown as SupabaseClient;
  return { client, chain, select: builder.select, order: builder.order, limit: builder.limit };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    event_name: "village.registered.v1",
    occurred_at: "2026-07-28T22:09:41.000Z",
    recorded_at: "2026-07-28T22:09:42.000Z",
    actor_id: null,
    actor_email: null,
    actor_role: null,
    request_id: null,
    subject_type: "village",
    subject_id: "VIL-1",
    payload: { villageId: "VIL-1" },
    ...overrides,
  };
}

describe("SupabaseAuditLog.query", () => {
  it("selects every column of the table, newest first", async () => {
    const double = createQueryDouble([]);

    await new SupabaseAuditLog(double.client).query({});

    expect(double.select).toHaveBeenCalledWith(AUDIT_COLUMNS);
    expect(double.order).toHaveBeenCalledWith("id", { ascending: false });
  });

  it("composes every filter server-side, in one query", async () => {
    const double = createQueryDouble([]);

    await new SupabaseAuditLog(double.client).query({
      subjectType: "village",
      subjectId: "VIL-1",
      actorId: "11111111-2222-3333-4444-555555555555",
      eventName: "village.severity-updated.v1",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
      cursor: "42",
      limit: 10,
    });

    expect(double.chain).toEqual([
      ["select", AUDIT_COLUMNS],
      ["eq", "subject_type", "village"],
      ["eq", "subject_id", "VIL-1"],
      ["eq", "actor_id", "11111111-2222-3333-4444-555555555555"],
      ["eq", "event_name", "village.severity-updated.v1"],
      ["gte", "occurred_at", "2026-07-01T00:00:00.000Z"],
      ["lte", "occurred_at", "2026-07-31T00:00:00.000Z"],
      ["lt", "id", "42"],
      ["order", "id", { ascending: false }],
      // limit + 1: the extra row is how the page knows there is another one.
      ["limit", 11],
    ]);
  });

  it("applies no predicate for a filter field the caller omitted", async () => {
    const double = createQueryDouble([]);

    await new SupabaseAuditLog(double.client).query({ actorId: "abc" });

    expect(double.chain.filter(([method]) => method === "eq")).toEqual([["eq", "actor_id", "abc"]]);
    expect(double.chain.some(([method]) => method === "gte")).toBe(false);
    expect(double.chain.some(([method]) => method === "lt")).toBe(false);
  });

  it("defaults and clamps the page size", async () => {
    const withDefault = createQueryDouble([]);
    await new SupabaseAuditLog(withDefault.client).query({});
    expect(withDefault.limit).toHaveBeenCalledWith(DEFAULT_AUDIT_PAGE_SIZE + 1);

    const withHuge = createQueryDouble([]);
    await new SupabaseAuditLog(withHuge.client).query({ limit: 1_000_000 });
    expect(withHuge.limit).toHaveBeenCalledWith(MAX_AUDIT_PAGE_SIZE + 1);
  });

  it("maps rows back onto entries and renders the bigint id as text", async () => {
    const double = createQueryDouble([row({ id: 7 })]);

    const result = await new SupabaseAuditLog(double.client).query({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0]?.id).toBe("7");
    expect(result.value.entries[0]?.eventName).toBe("village.registered.v1");
    expect(result.value.entries[0]?.recordedAt).toBe("2026-07-28T22:09:42.000Z");
  });

  it("does not put a bigint id through a double when PostgREST sends it as text", async () => {
    // The cursor derived from this id goes back into an `id < ?` predicate; if
    // it round-tripped through a JS number it would round and skip rows.
    const double = createQueryDouble([row({ id: "9007199254740993" }), row({ id: "1" })]);

    const result = await new SupabaseAuditLog(double.client).query({ limit: 1 });

    expect(result.ok && result.value.entries[0]?.id).toBe("9007199254740993");
    expect(result.ok && result.value.nextCursor).toBe("9007199254740993");
  });

  it("returns no cursor when the page is the last one", async () => {
    const double = createQueryDouble([row({ id: 3 }), row({ id: 2 })]);

    const result = await new SupabaseAuditLog(double.client).query({ limit: 2 });

    expect(result.ok && result.value.entries).toHaveLength(2);
    expect(result.ok && result.value.nextCursor).toBeNull();
  });

  it("drops the probe row and hands back a cursor when there is more", async () => {
    const double = createQueryDouble([row({ id: 3 }), row({ id: 2 }), row({ id: 1 })]);

    const result = await new SupabaseAuditLog(double.client).query({ limit: 2 });

    expect(result.ok && result.value.entries.map((e) => e.id)).toEqual(["3", "2"]);
    expect(result.ok && result.value.nextCursor).toBe("2");
  });

  it("reports a failure instead of an empty page — 'nothing happened' is the worst answer", async () => {
    const double = createQueryDouble([], { error: "permission denied" });

    const result = await new SupabaseAuditLog(double.client).query({});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("permission denied");
  });

  it("reports a transport rejection as a failure too", async () => {
    const double = createQueryDouble([], { reject: "fetch failed" });

    const result = await new SupabaseAuditLog(double.client).query({});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fetch failed");
  });

  it("refuses a subject id with no subject type, rather than mixing two subjects", async () => {
    const double = createQueryDouble([]);

    const result = await new SupabaseAuditLog(double.client).query({ subjectId: "VIL-1" });

    expect(result.ok).toBe(false);
    expect(double.chain).toEqual([]);
  });

  it("refuses a malformed cursor and a malformed instant before querying", async () => {
    const log = new SupabaseAuditLog(createQueryDouble([]).client);

    expect((await log.query({ cursor: "'; drop table audit_log; --" })).ok).toBe(false);
    expect((await log.query({ from: "last tuesday" })).ok).toBe(false);
    expect((await log.query({ to: "soon" })).ok).toBe(false);
    expect((await log.query({ limit: 0 })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InMemoryAuditLog
// ---------------------------------------------------------------------------

const CLOCK = () => new Date("2026-07-29T00:00:00.000Z");

async function seeded(): Promise<InMemoryAuditLog> {
  const log = new InMemoryAuditLog(CLOCK);
  await log.record(event({ occurredAt: "2026-07-01T00:00:00.000Z", actor: USER }));
  await log.record(
    event({
      name: "village.severity-updated.v1",
      occurredAt: "2026-07-10T00:00:00.000Z",
      payload: { villageId: "VIL-1", severity: "critical", previous: "severe" },
      actor: systemActor("anomaly-sweep"),
    }),
  );
  await log.record(
    event({
      name: "issue.reported.v1",
      occurredAt: "2026-07-20T00:00:00.000Z",
      payload: { issueId: "ISS-1", villageId: "VIL-1", category: "water" },
      actor: USER,
    }),
  );
  return log;
}

describe("InMemoryAuditLog", () => {
  it("assigns an id and a recordedAt the event did not carry", async () => {
    const log = new InMemoryAuditLog(CLOCK);

    await log.record(event());

    expect(log.recorded[0]?.id).toBe("1");
    expect(log.recorded[0]?.recordedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(log.recorded[0]?.occurredAt).toBe("2026-07-28T22:09:41.000Z");
  });

  it("returns everything newest first", async () => {
    const result = await (await seeded()).query({});

    expect(result.ok && result.value.entries.map((e) => e.eventName)).toEqual([
      "issue.reported.v1",
      "village.severity-updated.v1",
      "village.registered.v1",
    ]);
  });

  it("filters by subject", async () => {
    const result = await (await seeded()).query({ subjectType: "village", subjectId: "VIL-1" });

    expect(result.ok && result.value.entries.map((e) => e.eventName)).toEqual([
      "village.severity-updated.v1",
      "village.registered.v1",
    ]);
  });

  it("filters by actor, and a system actor is not a user", async () => {
    const byUser = await (await seeded()).query({ actorId: USER.kind === "user" ? USER.id : "" });

    expect(byUser.ok && byUser.value.entries.map((e) => e.eventName)).toEqual([
      "issue.reported.v1",
      "village.registered.v1",
    ]);
  });

  it("filters by event name", async () => {
    const result = await (await seeded()).query({ eventName: "issue.reported.v1" });

    expect(result.ok && result.value.entries).toHaveLength(1);
  });

  it("filters by an inclusive time range", async () => {
    const result = await (await seeded()).query({
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    });

    expect(result.ok && result.value.entries.map((e) => e.eventName)).toEqual([
      "issue.reported.v1",
      "village.severity-updated.v1",
    ]);
  });

  it("composes filters conjunctively", async () => {
    const result = await (await seeded()).query({
      subjectType: "village",
      subjectId: "VIL-1",
      from: "2026-07-05T00:00:00.000Z",
    });

    expect(result.ok && result.value.entries.map((e) => e.eventName)).toEqual([
      "village.severity-updated.v1",
    ]);
  });

  it("pages by keyset, and the pages neither repeat nor skip a row", async () => {
    const log = await seeded();

    const first = await log.query({ limit: 2 });
    expect(first.ok && first.value.entries.map((e) => e.id)).toEqual(["3", "2"]);
    expect(first.ok && first.value.nextCursor).toBe("2");

    // A row written between the two pages must not shift the window.
    await log.record(event({ occurredAt: "2026-07-25T00:00:00.000Z" }));

    const second = await log.query({ limit: 2, cursor: first.ok ? first.value.nextCursor! : "" });
    expect(second.ok && second.value.entries.map((e) => e.id)).toEqual(["1"]);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });

  it("applies the same validation as the durable adapter", async () => {
    const log = new InMemoryAuditLog(CLOCK);

    expect((await log.query({ subjectId: "VIL-1" })).ok).toBe(false);
    expect((await log.query({ cursor: "nope" })).ok).toBe(false);
    expect((await log.query({ limit: -1 })).ok).toBe(false);
  });

  it("records an unrecognised event with a null subject rather than dropping it", async () => {
    const log = new InMemoryAuditLog(CLOCK);

    await log.record(event({ name: "chicken.rustled.v1", payload: { chickenId: "CHK-1" } }));

    expect(log.recorded).toHaveLength(1);
    expect(log.recorded[0]).toMatchObject({
      eventName: "chicken.rustled.v1",
      subjectType: null,
      subjectId: null,
      payload: { chickenId: "CHK-1" },
    });
  });
});

// ---------------------------------------------------------------------------
// AuditLogSubscriber
// ---------------------------------------------------------------------------

function stubLog(record: Mock = vi.fn(async () => undefined)): { log: AuditLog; record: Mock } {
  return { log: { record, query: vi.fn() } as unknown as AuditLog, record };
}

describe("AuditLogSubscriber", () => {
  it("writes every event the bus publishes, whatever its name", async () => {
    const bus = new InMemoryEventBus();
    const { log, record } = stubLog();
    attachAuditLog(bus, log);

    await bus.publish([
      event(),
      event({ name: "issue.reported.v1", payload: { issueId: "ISS-1" } }),
      event({ name: "chicken.rustled.v1", payload: {} }),
    ]);

    expect(record.mock.calls.map((call) => (call[0] as DomainEvent).name)).toEqual([
      "village.registered.v1",
      "issue.reported.v1",
      "chicken.rustled.v1",
    ]);
  });

  it("subscribes through subscribeAll, not through named subscriptions", () => {
    const bus = { subscribeAll: vi.fn(), subscribe: vi.fn() };

    new AuditLogSubscriber(stubLog().log).subscribeTo(bus as never);

    expect(bus.subscribeAll).toHaveBeenCalledTimes(1);
    expect(bus.subscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe merely by being constructed", () => {
    const bus = { subscribeAll: vi.fn() };

    new AuditLogSubscriber(stubLog().log);

    expect(bus.subscribeAll).not.toHaveBeenCalled();
  });

  it("awaits the write, so a slow audit store back-pressures the request", async () => {
    const bus = new InMemoryEventBus();
    let settled = false;
    const { log } = stubLog(
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
      }),
    );
    attachAuditLog(bus, log);

    await bus.publish([event()]);

    expect(settled).toBe(true);
  });

  it("reaches the real in-memory log end to end", async () => {
    const bus = new InMemoryEventBus();
    const log = new InMemoryAuditLog(CLOCK);
    attachAuditLog(bus, log);

    await bus.publish([event({ actor: USER, requestId: "req-7" })]);

    expect(log.recorded).toHaveLength(1);
    expect(log.recorded[0]).toMatchObject({
      eventName: "village.registered.v1",
      actorEmail: "officer@assam.gov.in",
      requestId: "req-7",
      subjectId: "VIL-1",
    });
  });

  describe("when the write fails", () => {
    const boom = () => stubLog(vi.fn(async () => Promise.reject(new Error("no such table"))));

    it("does not fail the request, whose data change has already happened", async () => {
      const errors = silenceErrors();
      const bus = new InMemoryEventBus();
      attachAuditLog(bus, boom().log);

      await expect(bus.publish([event()])).resolves.toBeUndefined();
      errors.mockRestore();
    });

    it("counts the failure so /health can surface it", async () => {
      const errors = silenceErrors();
      const subscriber = new AuditLogSubscriber(boom().log);

      await subscriber.handle(event());
      await subscriber.handle(event());

      expect(subscriber.failedWrites).toBe(2);
      expect(subscriber.stats().failedWrites).toBe(2);
      errors.mockRestore();
    });

    it("counts nothing when writes succeed", async () => {
      const subscriber = new AuditLogSubscriber(stubLog().log);

      await subscriber.handle(event());

      expect(subscriber.failedWrites).toBe(0);
      expect(subscriber.stats().lastFailure).toBeNull();
    });

    it("names the most recent failure", async () => {
      const errors = silenceErrors();
      const subscriber = new AuditLogSubscriber(boom().log);

      await subscriber.handle(event({ name: "issue.reported.v1" }));

      expect(subscriber.stats().lastFailure).toEqual({
        eventName: "issue.reported.v1",
        occurredAt: "2026-07-28T22:09:41.000Z",
        reason: "no such table",
      });
      errors.mockRestore();
    });

    it("logs the whole lost row, so an operator can reinsert it by hand", async () => {
      const errors = silenceErrors();
      const subscriber = new AuditLogSubscriber(boom().log);

      await subscriber.handle(event({ actor: USER, requestId: "req-7" }));

      const line = String(errors.mock.calls[0]?.[0]);
      expect(line).toContain(AUDIT_WRITE_FAILED_MARKER);
      expect(line).toContain("no such table");
      expect(line).toContain("00006_audit_log.sql");
      // Everything needed to reconstruct the row, not a summary of it.
      const json = JSON.parse(line.slice(line.indexOf("row=") + 4)) as Record<string, unknown>;
      expect(json).toEqual({
        event_name: "village.registered.v1",
        occurred_at: "2026-07-28T22:09:41.000Z",
        actor_id: "11111111-2222-3333-4444-555555555555",
        actor_email: "officer@assam.gov.in",
        actor_role: "district_officer",
        request_id: "req-7",
        subject_type: "village",
        subject_id: "VIL-1",
        payload: { villageId: "VIL-1", name: "Rampur", district: "Barpeta", severity: "critical" },
      });
      errors.mockRestore();
    });

    it("logs one line per lost row rather than summarising", async () => {
      const errors = silenceErrors();
      const bus = new InMemoryEventBus();
      attachAuditLog(bus, boom().log);

      await bus.publish([event(), event({ name: "issue.reported.v1" })]);

      expect(errors).toHaveBeenCalledTimes(2);
      errors.mockRestore();
    });

    it("keeps logging even when the payload will not serialise", async () => {
      const errors = silenceErrors();
      const subscriber = new AuditLogSubscriber(boom().log);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      await subscriber.handle(event({ payload: cyclic }));

      expect(subscriber.failedWrites).toBe(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain(AUDIT_WRITE_FAILED_MARKER);
      errors.mockRestore();
    });

    it("keeps writing the events that follow a failure", async () => {
      const errors = silenceErrors();
      const bus = new InMemoryEventBus();
      const record = vi
        .fn<(event: DomainEvent) => Promise<void>>()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(undefined);
      attachAuditLog(bus, stubLog(record as unknown as Mock).log);

      await bus.publish([event(), event({ name: "issue.reported.v1" })]);

      expect(record).toHaveBeenCalledTimes(2);
      errors.mockRestore();
    });
  });
});
