import { describe, expect, it, vi, type Mock } from "vitest";
import { AFRIP_SCHEMA, SequentialIdGenerator } from "@afrip/shared-kernel";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_FEEDBACK_PAGE_SIZE,
  FEEDBACK_COLUMNS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  FEEDBACK_TABLE,
  InMemoryFeedbackStore,
  MAX_CONTEXT_LENGTH,
  MAX_DETAIL_LENGTH,
  MAX_FEEDBACK_PAGE_SIZE,
  MAX_SUMMARY_LENGTH,
  MAX_USER_AGENT_LENGTH,
  SupabaseFeedbackStore,
  encodeFeedbackCursor,
  isFeedbackKind,
  isFeedbackStatus,
  normaliseDraft,
  type FeedbackDraft,
  type FeedbackReport,
  type FeedbackStore,
} from "../src/feedback.js";

/**
 * The feedback store (ADR 0016).
 *
 * Two properties are tested harder than the rest, and both are about the table
 * holding free text that will contain beneficiary names despite the form asking
 * users not to type them:
 *
 *   * The length caps. `POST /feedback` is reachable by every signed-in user and
 *     writes into two unbounded `text` columns, so an uncapped boundary is a way
 *     to fill the database rather than a lenient one.
 *   * The reporter columns are whatever the caller of `submit` put there. The
 *     store cannot defend that — only the route can, by taking them from
 *     `ctx.actor` — so the test that matters lives in `feedback-routes.test.ts`
 *     and is named there. This file only proves the columns round-trip.
 */

const REPORTER = {
  id: "11111111-2222-3333-4444-555555555555",
  email: "officer@assam.gov.in",
  role: "district_officer",
};

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    kind: "bug",
    summary: "the aid record for the beneficiary in Nazira shows twice",
    detail: "open the follow-ups tab and the same record is listed under both dates",
    context: {
      buildCommit: "6c10af3",
      buildBranch: "main",
      viewPath: "/villages/village-1",
      userAgent: "Mozilla/5.0 (Linux; Android 13)",
    },
    reporter: REPORTER,
    ...overrides,
  };
}

function memoryStore(at = "2026-07-30T09:00:00.000Z"): InMemoryFeedbackStore {
  let tick = 0;
  return new InMemoryFeedbackStore(
    // Each submission a second later than the last, so ordering assertions are
    // about the sort and not about how fast the test ran.
    () => new Date(Date.parse(at) + tick++ * 1000),
    new SequentialIdGenerator("feedback"),
  );
}

async function submitted(store: FeedbackStore, d: FeedbackDraft): Promise<FeedbackReport> {
  const result = await store.submit(d);
  if (!result.ok) throw new Error(`expected a submitted report, got: ${result.error}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// The closed sets
// ---------------------------------------------------------------------------

describe("the closed sets", () => {
  it("names the three kinds ADR 0016 admits, and no others", () => {
    expect([...FEEDBACK_KINDS]).toEqual(["bug", "feature", "other"]);
  });

  it("names the four statuses ADR 0016 admits, and no others", () => {
    expect([...FEEDBACK_STATUSES]).toEqual(["open", "acknowledged", "resolved", "declined"]);
  });

  it("rejects anything outside them, including near-misses", () => {
    expect(isFeedbackKind("bug")).toBe(true);
    expect(isFeedbackKind("Bug")).toBe(false);
    expect(isFeedbackKind("question")).toBe(false);
    expect(isFeedbackStatus("open")).toBe(true);
    expect(isFeedbackStatus("opne")).toBe(false);
    expect(isFeedbackStatus(null)).toBe(false);
  });

  it("lists every column of the table, in the migration's declared order", () => {
    expect(FEEDBACK_COLUMNS.split(",")).toEqual([
      "id",
      "kind",
      "summary",
      "detail",
      "build_commit",
      "build_branch",
      "view_path",
      "user_agent",
      "reporter_id",
      "reporter_email",
      "reporter_role",
      "status",
      "created_at",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

describe("normaliseDraft — the length caps", () => {
  it("accepts a summary exactly at the cap and refuses one character more", () => {
    expect(normaliseDraft(draft({ summary: "x".repeat(MAX_SUMMARY_LENGTH) })).ok).toBe(true);

    const over = normaliseDraft(draft({ summary: "x".repeat(MAX_SUMMARY_LENGTH + 1) }));
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toContain(String(MAX_SUMMARY_LENGTH));
  });

  it("accepts a detail exactly at the cap and refuses one character more", () => {
    expect(normaliseDraft(draft({ detail: "x".repeat(MAX_DETAIL_LENGTH) })).ok).toBe(true);
    expect(normaliseDraft(draft({ detail: "x".repeat(MAX_DETAIL_LENGTH + 1) })).ok).toBe(false);
  });

  it("caps the automatically-captured context too, not just what the user typed", () => {
    // A client is as able to send a megabyte of `viewPath` as of `summary`, and
    // the column is just as unbounded.
    const long = "x".repeat(MAX_CONTEXT_LENGTH + 1);
    for (const field of ["buildCommit", "buildBranch", "viewPath"] as const) {
      const result = normaliseDraft(draft({ context: { ...draft().context, [field]: long } }));
      expect(result.ok, `${field} was not capped`).toBe(false);
      expect(!result.ok && result.error).toContain(field);
    }

    const ua = normaliseDraft(
      draft({ context: { ...draft().context, userAgent: "x".repeat(MAX_USER_AGENT_LENGTH + 1) } }),
    );
    expect(ua.ok).toBe(false);
  });

  it("leaves a real user agent well inside its cap", () => {
    // The cap is meant to be generous for a genuine string and useless for
    // filling a disk; a real Android WebView UA is the worst realistic case.
    const real =
      "Mozilla/5.0 (Linux; Android 13; SM-A125F Build/TP1A.220624.014; wv) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.101 Mobile Safari/537.36";
    expect(real.length).toBeLessThan(MAX_USER_AGENT_LENGTH);
    expect(normaliseDraft(draft({ context: { ...draft().context, userAgent: real } })).ok).toBe(true);
  });
});

describe("normaliseDraft — the rest", () => {
  it("refuses a kind outside the closed set, naming the set", () => {
    const result = normaliseDraft(draft({ kind: "question" as FeedbackDraft["kind"] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("bug, feature, other");
  });

  it("refuses a summary that is only whitespace — a blank line is not a report", () => {
    const result = normaliseDraft(draft({ summary: "   \n\t " }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("summary is required");
  });

  it("trims the summary rather than storing the user's stray spaces", () => {
    const result = normaliseDraft(draft({ summary: "  it shows twice  " }));
    expect(result.ok && result.value.summary).toBe("it shows twice");
  });

  it("collapses an empty detail to null — 'wrote nothing' has one representation", () => {
    expect(normaliseDraft(draft({ detail: "   " })).ok).toBe(true);
    const result = normaliseDraft(draft({ detail: "   " }));
    expect(result.ok && result.value.detail).toBeNull();
  });

  it("keeps an absent detail absent", () => {
    const result = normaliseDraft(draft({ detail: null }));
    expect(result.ok && result.value.detail).toBeNull();
  });

  it("collapses an empty context field to null rather than storing ''", () => {
    const result = normaliseDraft(draft({ context: { ...draft().context, buildCommit: "" } }));
    expect(result.ok && result.value.context.buildCommit).toBeNull();
  });

  it("does not touch the reporter — that is the route's business, not the store's", () => {
    const result = normaliseDraft(draft({ reporter: { id: null, email: "  x  ", role: null } }));
    expect(result.ok && result.value.reporter.email).toBe("  x  ");
  });
});

// ---------------------------------------------------------------------------
// InMemoryFeedbackStore
// ---------------------------------------------------------------------------

describe("InMemoryFeedbackStore.submit", () => {
  it("assigns an id, opens the report, and stamps the instant", async () => {
    const report = await submitted(memoryStore(), draft());

    expect(report.id).toBe("feedback-1");
    expect(report.status).toBe("open");
    expect(report.createdAt).toBe("2026-07-30T09:00:00.000Z");
  });

  it("round-trips every column, including the context and the reporter", async () => {
    const report = await submitted(memoryStore(), draft());

    expect(report).toMatchObject({
      kind: "bug",
      summary: "the aid record for the beneficiary in Nazira shows twice",
      buildCommit: "6c10af3",
      buildBranch: "main",
      viewPath: "/villages/village-1",
      userAgent: "Mozilla/5.0 (Linux; Android 13)",
      reporterId: REPORTER.id,
      reporterEmail: REPORTER.email,
      reporterRole: REPORTER.role,
    });
  });

  it("refuses an over-long report rather than truncating it", async () => {
    // Truncation would store a report whose last sentence is missing, which
    // reads as a complete report and is not one.
    const result = await memoryStore().submit(draft({ summary: "x".repeat(MAX_SUMMARY_LENGTH + 1) }));
    expect(result.ok).toBe(false);
  });

  it("stores nothing when it refuses", async () => {
    const store = memoryStore();
    await store.submit(draft({ kind: "question" as FeedbackDraft["kind"] }));
    expect(store.submitted).toHaveLength(0);
  });
});

describe("InMemoryFeedbackStore.query", () => {
  async function seeded(): Promise<InMemoryFeedbackStore> {
    const store = memoryStore();
    await store.submit(draft({ kind: "bug", summary: "first" }));
    await store.submit(draft({ kind: "feature", summary: "second" }));
    await store.submit(draft({ kind: "bug", summary: "third" }));
    return store;
  }

  it("answers newest first", async () => {
    const result = await (await seeded()).query({});
    expect(result.ok && result.value.reports.map((r) => r.summary)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("filters by kind", async () => {
    const result = await (await seeded()).query({ kind: "bug" });
    expect(result.ok && result.value.reports.map((r) => r.summary)).toEqual(["third", "first"]);
  });

  it("filters by status", async () => {
    const store = await seeded();
    const all = await store.query({});
    const second = all.ok ? all.value.reports[1] : undefined;
    await store.setStatus(second?.id ?? "", "resolved");

    const open = await store.query({ status: "open" });
    expect(open.ok && open.value.reports.map((r) => r.summary)).toEqual(["third", "first"]);
    const resolved = await store.query({ status: "resolved" });
    expect(resolved.ok && resolved.value.reports.map((r) => r.summary)).toEqual(["second"]);
  });

  it("refuses an unrecognised status rather than ignoring the filter", async () => {
    // Ignoring it would answer `?status=opne` with EVERY report while the reader
    // believes they are looking at the open ones.
    const result = await (await seeded()).query({ status: "opne" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("open, acknowledged, resolved, declined");
  });

  it("refuses an unrecognised kind for the same reason", async () => {
    expect((await (await seeded()).query({ kind: "question" })).ok).toBe(false);
  });

  it("refuses a nonsense limit", async () => {
    expect((await memoryStore().query({ limit: 0 })).ok).toBe(false);
    expect((await memoryStore().query({ limit: -5 })).ok).toBe(false);
    expect((await memoryStore().query({ limit: 1.5 })).ok).toBe(false);
  });

  it("pages by keyset, returning each report exactly once", async () => {
    const store = await seeded();

    const first = await store.query({ limit: 2 });
    expect(first.ok && first.value.reports.map((r) => r.summary)).toEqual(["third", "second"]);
    expect(first.ok && first.value.nextCursor).not.toBeNull();

    const second = await store.query({
      limit: 2,
      cursor: (first.ok && first.value.nextCursor) || "",
    });
    expect(second.ok && second.value.reports.map((r) => r.summary)).toEqual(["first"]);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });

  /**
   * The reason the cursor is `(created_at, id)` and not `created_at` alone.
   * Reports filed in the same instant are not hypothetical — a double-submit or a
   * seeded batch produces them — and a cursor that could not tell them apart
   * would either repeat one or skip one. A repeated report is untidy; a skipped
   * one is a report nobody ever sees, which is the failure ADR 0016 exists to
   * prevent.
   */
  it("does not skip or repeat reports that share an instant", async () => {
    const frozen = new InMemoryFeedbackStore(
      () => new Date("2026-07-30T09:00:00.000Z"),
      new SequentialIdGenerator("feedback"),
    );
    await frozen.submit(draft({ summary: "a" }));
    await frozen.submit(draft({ summary: "b" }));
    await frozen.submit(draft({ summary: "c" }));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await frozen.query({ limit: 1, ...(cursor === null ? {} : { cursor }) });
      if (!result.ok) throw new Error(result.error);
      seen.push(...result.value.reports.map((r) => r.summary));
      cursor = result.value.nextCursor;
      if (cursor === null) break;
    }

    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("refuses a cursor it did not issue", async () => {
    const store = await seeded();
    expect((await store.query({ cursor: "not-a-cursor" })).ok).toBe(false);
    expect((await store.query({ cursor: "last tuesday|feedback-1" })).ok).toBe(false);
    // The half that goes into a PostgREST `or` expression in the other adapter.
    expect(
      (await store.query({ cursor: "2026-07-30T09:00:00.000Z|feedback-1,kind.eq.bug" })).ok,
    ).toBe(false);
  });

  it("issues a cursor that names the last report of the page", async () => {
    const store = await seeded();
    const page = await store.query({ limit: 2 });
    const last = page.ok ? page.value.reports[1] : undefined;

    expect(page.ok && page.value.nextCursor).toBe(encodeFeedbackCursor(last as FeedbackReport));
  });
});

describe("InMemoryFeedbackStore.setStatus", () => {
  it("moves the status and leaves everything else alone", async () => {
    const store = memoryStore();
    const report = await submitted(store, draft());

    const result = await store.setStatus(report.id, "acknowledged");

    expect(result.ok && result.value?.status).toBe("acknowledged");
    expect(result.ok && result.value?.summary).toBe(report.summary);
    expect(result.ok && result.value?.createdAt).toBe(report.createdAt);
  });

  it("answers null — not an error — for an id that matches no report", async () => {
    // The route turns this into a 404. An error would be a 502, which blames the
    // database for the caller's typo.
    const result = await memoryStore().setStatus("feedback-nope", "resolved");
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeNull();
  });

  it("refuses a status outside the closed set", async () => {
    const store = memoryStore();
    const report = await submitted(store, draft());
    expect((await store.setStatus(report.id, "wontfix" as never)).ok).toBe(false);
  });

  it("does not mutate a report a caller is already holding", async () => {
    const store = memoryStore();
    const report = await submitted(store, draft());
    await store.setStatus(report.id, "declined");
    expect(report.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// SupabaseFeedbackStore
// ---------------------------------------------------------------------------

/**
 * A recording Supabase double.
 *
 * `fake-supabase-client.ts` is deliberately not used or extended here: its own
 * header says it exists to record WHICH table an adapter touched, "not how any
 * single row round-trips", and it has no `update`, no `or` and no chained
 * `select` after an insert. `audit.test.ts` made the same call for the audit read
 * path and this follows it.
 */
interface StoreDouble {
  client: SupabaseClient;
  /** Every builder method called, in order: ["eq", "status", "open"], … */
  chain: unknown[][];
  schema: Mock;
  from: Mock;
}

function createStoreDouble(
  options: { rows?: Record<string, unknown>[]; single?: Record<string, unknown> | null; error?: string; reject?: string } = {},
): StoreDouble {
  const chain: unknown[][] = [];
  const record = (method: string) =>
    vi.fn((...args: unknown[]) => {
      chain.push([method, ...args]);
      return builder;
    });

  const settle = (data: unknown) => {
    if (options.reject !== undefined) return Promise.reject(new Error(options.reject));
    if (options.error !== undefined) return Promise.resolve({ data: null, error: { message: options.error } });
    return Promise.resolve({ data, error: null });
  };

  const builder = {
    select: record("select"),
    insert: record("insert"),
    update: record("update"),
    eq: record("eq"),
    or: record("or"),
    order: record("order"),
    limit: record("limit"),
    maybeSingle: vi.fn(() => {
      chain.push(["maybeSingle"]);
      return settle(options.single === undefined ? null : options.single);
    }),
    then: (
      onFulfilled: (value: { data: unknown; error: { message: string } | null }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => settle(options.rows ?? []).then(onFulfilled, onRejected),
  };

  const from = vi.fn(() => builder);
  const schema = vi.fn(() => ({ from }));
  return { client: { schema, from } as unknown as SupabaseClient, chain, schema, from };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "feedback-1",
    kind: "bug",
    summary: "it shows twice",
    detail: null,
    build_commit: "6c10af3",
    build_branch: "main",
    view_path: "/villages/village-1",
    user_agent: "Mozilla/5.0",
    reporter_id: REPORTER.id,
    reporter_email: REPORTER.email,
    reporter_role: REPORTER.role,
    status: "open",
    created_at: "2026-07-30T09:00:00.000Z",
    ...overrides,
  };
}

function store(double: StoreDouble): SupabaseFeedbackStore {
  return new SupabaseFeedbackStore(double.client, AFRIP_SCHEMA, new SequentialIdGenerator("feedback"));
}

describe("SupabaseFeedbackStore.submit", () => {
  it("writes to feedback in the AFRIP schema, not public", async () => {
    const double = createStoreDouble({ single: row() });

    await store(double).submit(draft());

    expect(double.schema).toHaveBeenCalledWith(AFRIP_SCHEMA);
    expect(double.from).toHaveBeenCalledWith(FEEDBACK_TABLE);
  });

  it("defaults to the AFRIP schema when the caller does not name one", async () => {
    const double = createStoreDouble({ single: row() });

    await new SupabaseFeedbackStore(double.client).submit(draft());

    expect(double.schema).toHaveBeenCalledWith(AFRIP_SCHEMA);
  });

  it("maps the draft onto the table's columns, with an id it generated", async () => {
    const double = createStoreDouble({ single: row() });

    await store(double).submit(draft());

    const insert = double.chain.find(([method]) => method === "insert");
    expect(insert?.[1]).toEqual({
      id: "feedback-1",
      kind: "bug",
      summary: "the aid record for the beneficiary in Nazira shows twice",
      detail: "open the follow-ups tab and the same record is listed under both dates",
      build_commit: "6c10af3",
      build_branch: "main",
      view_path: "/villages/village-1",
      user_agent: "Mozilla/5.0 (Linux; Android 13)",
      reporter_id: REPORTER.id,
      reporter_email: REPORTER.email,
      reporter_role: REPORTER.role,
    });
  });

  it("leaves status and created_at to the database", async () => {
    const double = createStoreDouble({ single: row() });

    await store(double).submit(draft());

    const insert = double.chain.find(([method]) => method === "insert");
    expect(Object.keys(insert?.[1] as object)).not.toContain("status");
    expect(Object.keys(insert?.[1] as object)).not.toContain("created_at");
  });

  it("reads the stored row back rather than echoing what it sent", async () => {
    // `status` and `created_at` are column defaults, so the API does not know
    // them; inventing them from the API's clock would show the reporter a
    // timestamp the table does not hold.
    const double = createStoreDouble({ single: row({ created_at: "2026-07-30T09:00:01.000Z" }) });

    const result = await store(double).submit(draft());

    expect(double.chain.some(([m, c]) => m === "select" && c === FEEDBACK_COLUMNS)).toBe(true);
    expect(result.ok && result.value.createdAt).toBe("2026-07-30T09:00:01.000Z");
    expect(result.ok && result.value.status).toBe("open");
  });

  it("never upserts — an id collision must not overwrite somebody's report", async () => {
    const double = createStoreDouble({ single: row() });

    await store(double).submit(draft());

    expect(double.chain.some(([method]) => method === "upsert")).toBe(false);
    expect(double.chain.filter(([method]) => method === "insert")).toHaveLength(1);
  });

  it("reports a refused insert instead of claiming the report landed", async () => {
    const double = createStoreDouble({ error: "permission denied for table feedback" });

    const result = await store(double).submit(draft());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("permission denied");
  });

  it("refuses to report success when the insert returns no row", async () => {
    const double = createStoreDouble({ single: null });

    const result = await store(double).submit(draft());

    expect(result.ok).toBe(false);
  });

  it("reports a transport rejection rather than swallowing it", async () => {
    const double = createStoreDouble({ reject: "fetch failed" });

    const result = await store(double).submit(draft());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fetch failed");
  });

  it("applies the caps before it touches the database", async () => {
    const double = createStoreDouble({ single: row() });

    const result = await store(double).submit(draft({ summary: "x".repeat(MAX_SUMMARY_LENGTH + 1) }));

    expect(result.ok).toBe(false);
    expect(double.chain).toEqual([]);
  });
});

describe("SupabaseFeedbackStore.query", () => {
  it("selects every column, newest first with the id breaking ties", async () => {
    const double = createStoreDouble({ rows: [] });

    await store(double).query({});

    expect(double.chain).toEqual([
      ["select", FEEDBACK_COLUMNS],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      // limit + 1: the extra row is how the page knows there is another one.
      ["limit", DEFAULT_FEEDBACK_PAGE_SIZE + 1],
    ]);
  });

  it("composes every filter server-side, in one query", async () => {
    const double = createStoreDouble({ rows: [] });

    await store(double).query({
      kind: "bug",
      status: "open",
      cursor: "2026-07-30T09:00:00.000Z|feedback-4",
      limit: 10,
    });

    expect(double.chain).toEqual([
      ["select", FEEDBACK_COLUMNS],
      ["eq", "kind", "bug"],
      ["eq", "status", "open"],
      [
        "or",
        "created_at.lt.2026-07-30T09:00:00.000Z," +
          "and(created_at.eq.2026-07-30T09:00:00.000Z,id.lt.feedback-4)",
      ],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 11],
    ]);
  });

  it("applies no predicate for a filter the caller omitted", async () => {
    const double = createStoreDouble({ rows: [] });

    await store(double).query({ kind: "bug" });

    expect(double.chain.filter(([method]) => method === "eq")).toEqual([["eq", "kind", "bug"]]);
    expect(double.chain.some(([method]) => method === "or")).toBe(false);
  });

  it("defaults and clamps the page size", async () => {
    const withDefault = createStoreDouble({ rows: [] });
    await store(withDefault).query({});
    expect(withDefault.chain).toContainEqual(["limit", DEFAULT_FEEDBACK_PAGE_SIZE + 1]);

    const withHuge = createStoreDouble({ rows: [] });
    await store(withHuge).query({ limit: 1_000_000 });
    expect(withHuge.chain).toContainEqual(["limit", MAX_FEEDBACK_PAGE_SIZE + 1]);
  });

  it("never lets a cursor become an extra filter", async () => {
    // The cursor goes into PostgREST's `or=(…)` grammar, where a comma is
    // syntax. A cursor carrying one would not be a broken filter, it would be an
    // additional one.
    const double = createStoreDouble({ rows: [] });

    const result = await store(double).query({ cursor: "2026-07-30T09:00:00.000Z|x,status.eq.open" });

    expect(result.ok).toBe(false);
    expect(double.chain).toEqual([]);
  });

  it("drops the probe row and hands back a cursor when there is more", async () => {
    const double = createStoreDouble({
      rows: [
        row({ id: "feedback-3", created_at: "2026-07-30T09:00:03.000Z" }),
        row({ id: "feedback-2", created_at: "2026-07-30T09:00:02.000Z" }),
        row({ id: "feedback-1", created_at: "2026-07-30T09:00:01.000Z" }),
      ],
    });

    const result = await store(double).query({ limit: 2 });

    expect(result.ok && result.value.reports.map((r) => r.id)).toEqual(["feedback-3", "feedback-2"]);
    expect(result.ok && result.value.nextCursor).toBe("2026-07-30T09:00:02.000Z|feedback-2");
  });

  it("returns no cursor when the page is the last one", async () => {
    const double = createStoreDouble({ rows: [row({ id: "feedback-2" }), row({ id: "feedback-1" })] });

    const result = await store(double).query({ limit: 2 });

    expect(result.ok && result.value.nextCursor).toBeNull();
  });

  it("maps rows back onto reports", async () => {
    const double = createStoreDouble({ rows: [row()] });

    const result = await store(double).query({});

    expect(result.ok && result.value.reports[0]).toEqual({
      id: "feedback-1",
      kind: "bug",
      summary: "it shows twice",
      detail: null,
      buildCommit: "6c10af3",
      buildBranch: "main",
      viewPath: "/villages/village-1",
      userAgent: "Mozilla/5.0",
      reporterId: REPORTER.id,
      reporterEmail: REPORTER.email,
      reporterRole: REPORTER.role,
      status: "open",
      createdAt: "2026-07-30T09:00:00.000Z",
    });
  });

  it("treats a status the check constraint would not admit as open, not as gospel", async () => {
    // A hand-edited row must not produce a `FeedbackReport` whose type is a lie,
    // and `open` is the reading that keeps the report in front of somebody.
    const double = createStoreDouble({ rows: [row({ status: "wontfix", kind: "question" })] });

    const result = await store(double).query({});

    expect(result.ok && result.value.reports[0]?.status).toBe("open");
    expect(result.ok && result.value.reports[0]?.kind).toBe("other");
  });

  it("reports a failure instead of an empty page", async () => {
    // `reports: []` would read as "nobody has ever reported anything", and since
    // nothing notifies an administrator, that list is the only place a report is
    // ever seen.
    const double = createStoreDouble({ error: "permission denied" });

    const result = await store(double).query({});

    expect(result.ok).toBe(false);
  });

  it("reports a transport rejection rather than swallowing it", async () => {
    const double = createStoreDouble({ reject: "fetch failed" });
    expect((await store(double).query({})).ok).toBe(false);
  });
});

describe("SupabaseFeedbackStore.setStatus", () => {
  it("updates only the status column, matched on the id", async () => {
    const double = createStoreDouble({ single: row({ status: "acknowledged" }) });

    await store(double).setStatus("feedback-1", "acknowledged");

    expect(double.chain).toEqual([
      ["update", { status: "acknowledged" }],
      ["eq", "id", "feedback-1"],
      ["select", FEEDBACK_COLUMNS],
      ["maybeSingle"],
    ]);
  });

  it("cannot be made to write anything but the status", async () => {
    // 00009 has to grant `update` on the table for the status to move at all, so
    // SQL cannot tell "change the status" from "rewrite the summary". The narrow
    // method is where that distinction lives, and this is the test of it.
    const double = createStoreDouble({ single: row() });

    await store(double).setStatus("feedback-1", "resolved");

    const update = double.chain.find(([method]) => method === "update");
    expect(Object.keys(update?.[1] as object)).toEqual(["status"]);
  });

  it("answers null for an id that matches no row", async () => {
    const double = createStoreDouble({ single: null });

    const result = await store(double).setStatus("feedback-nope", "resolved");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeNull();
  });

  it("refuses a status outside the closed set before touching the database", async () => {
    const double = createStoreDouble({ single: row() });

    const result = await store(double).setStatus("feedback-1", "wontfix" as never);

    expect(result.ok).toBe(false);
    expect(double.chain).toEqual([]);
  });

  it("reports a refused update", async () => {
    const double = createStoreDouble({ error: "permission denied for table feedback" });
    expect((await store(double).setStatus("feedback-1", "resolved")).ok).toBe(false);
  });

  it("issues no delete — the adapter has no way to remove a report", async () => {
    // 00009 revokes `delete` from service_role, so a delete here would fail at
    // the database; this asserts the adapter has no path that would try.
    const double = createStoreDouble({ single: row() });

    const feedback: FeedbackStore = store(double);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(feedback)).sort()).toEqual([
      "constructor",
      "query",
      "setStatus",
      "submit",
      "table",
    ]);
  });
});
