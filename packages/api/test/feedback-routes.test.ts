import { SequentialIdGenerator } from "@afrip/shared-kernel";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthGate,
  createJwtVerifier,
  localKeySet,
  type ActorContext,
  type ProfileDirectory,
  type UserRole,
  type VerifiedClaims,
} from "../src/auth.js";
import { MAX_DETAIL_LENGTH, MAX_SUMMARY_LENGTH } from "../src/feedback.js";
import { FORBIDDEN_CODE } from "../src/http-result.js";
import { createMemoryRuntime } from "../src/persistence.js";
import { buildRouter } from "../src/routes/index.js";
import {
  FEEDBACK_ADMIN_ROLES,
  FEEDBACK_ROUTES_OPEN_TO_ANY_SIGNED_IN_USER,
} from "../src/routes/feedback.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * In-app feedback over HTTP (ADR 0016).
 *
 * The access tests here are not ceremony. A feedback row is free text written by
 * somebody who has not been told what not to include, so it will name
 * beneficiaries — which makes this table as sensitive as the registry itself
 * (ADR 0009), and makes the read side narrower than the audit log's: `admin`
 * alone, not `admin` and `district_officer`.
 *
 * The write side is the mirror image and equally load-bearing: EVERY signed-in
 * user may file a report, because the people who will find version 1's faults are
 * field workers and district officers rather than whoever built it — and NO
 * anonymous caller may, because an unauthenticated write endpoint with no
 * captcha and no moderation queue is a spam sink (ADR 0016 §"Signed-in only").
 */

const SUPABASE_URL = "https://proj.supabase.co";
const KID = "afrip-feedback-key";

const PEOPLE: Record<UserRole, ActorContext> = {
  admin: { id: "user-admin", email: "mondweep@dxsure.uk", role: "admin" },
  district_officer: { id: "user-officer", email: "officer@assam.gov.in", role: "district_officer" },
  ngo_coordinator: { id: "user-ngo", email: "coord@goonj.org", role: "ngo_coordinator" },
  village_committee: { id: "user-committee", email: "member@village.in", role: "village_committee" },
  citizen: { id: "user-citizen", email: "resident@example.org", role: "citizen" },
};

/** Everyone ADR 0016 does NOT admit to the queue. Derived, so widening the gate breaks this. */
const NON_ADMIN_ROLES = (Object.keys(PEOPLE) as UserRole[]).filter(
  (role) => !FEEDBACK_ADMIN_ROLES.includes(role),
);

const keys = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const KEY_SET = localKeySet({ keys: [jwk] });

async function tokenFor(role: UserRole): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: PEOPLE[role].email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setSubject(PEOPLE[role].id)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(keys.privateKey);
}

const profiles: ProfileDirectory = {
  resolve: async (claims: VerifiedClaims) =>
    Object.values(PEOPLE).find((person) => person.id === claims.sub) ?? null,
};

async function boot(): Promise<TestServer> {
  const config = testConfig({ authJwt: true, supabaseUrl: SUPABASE_URL });
  return startTestServerWith({
    config,
    runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
    auth: createAuthGate({
      config,
      verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: null, keySet: KEY_SET }),
      profiles,
    }),
  });
}

const REPORT = {
  kind: "bug",
  summary: "the aid record for the beneficiary in Nazira shows twice",
  detail: "open the follow-ups tab and the same record is listed under both dates",
  buildCommit: "6c10af3",
  buildBranch: "main",
  viewPath: "/villages/village-1",
  userAgent: "Mozilla/5.0 (Linux; Android 13)",
};

interface FeedbackBody {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  buildCommit: string | null;
  buildBranch: string | null;
  viewPath: string | null;
  userAgent: string | null;
  reporterId: string | null;
  reporterEmail: string | null;
  reporterRole: string | null;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

describe("who may file feedback", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function post(role: UserRole, body: unknown) {
    return server.request("/feedback", {
      method: "POST",
      token: await tokenFor(role),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each(Object.keys(PEOPLE) as UserRole[])("admits %s — every signed-in user may report", async (role) => {
    server = await boot();
    const response = await post(role, REPORT);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("refuses an unauthenticated caller at the gate, before the handler", async () => {
    server = await boot();
    const response = await server.request("/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REPORT),
    });
    expect(response.status).toBe(401);
  });

  /**
   * The refusal ADR 0016 §"Signed-in only" argues for, on the path where the gate
   * does NOT refuse first: a deployment with no JWT configured (an open dev
   * server, or the transitional shared token) lets the request through with no
   * identity attached. A row with a null reporter is not a cheaper report — it is
   * the report nobody can follow up — so the handler refuses.
   */
  it("refuses an anonymous submission with 403, rather than writing a null reporter", async () => {
    // The runtime is held here rather than inside `startTestServer` so the test
    // can look in the store afterwards: the point is not the status code, it is
    // that no row exists.
    const runtime = createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) });
    server = await startTestServerWith({ config: testConfig(), runtime });

    const response = await server.request("/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REPORT),
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });

    const stored = await runtime.feedback.query({});
    expect(stored.ok && stored.value.reports).toEqual([]);
  });
});

describe("who may read and triage feedback", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it("admits an admin to the queue", async () => {
    server = await boot();
    const response = await server.request("/feedback", { token: await tokenFor("admin") });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  /**
   * The deliberate narrowing. ADR 0011 lets a district officer read the audit
   * trail; ADR 0016 §"Administrators only" does NOT let them read feedback,
   * because audit payloads are structured domain events and this is unbounded
   * prose that will name people. If this test ever needs changing, that section
   * is the argument to beat first.
   */
  it.each(NON_ADMIN_ROLES)("refuses %s with 403, including a district officer", async (role) => {
    server = await boot();
    const response = await server.request("/feedback", { token: await tokenFor(role) });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });
    expect((response.body as { error: string }).error).toMatch(new RegExp(role));
  });

  it.each(NON_ADMIN_ROLES)("refuses %s a status change with 403", async (role) => {
    server = await boot();
    const response = await server.request("/feedback/feedback-1", {
      method: "PATCH",
      token: await tokenFor(role),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });
  });

  /**
   * THE STRUCTURAL GUARD, and the reason the exception to ADR 0009 in
   * `routes/feedback.ts` is tolerable — the same argument `audit-routes.test.ts`
   * makes, adapted to a router whose feedback routes are NOT uniformly gated.
   *
   * The role checks are lines of code in handlers rather than entries in the
   * policy table, so a fourth feedback route added later could omit one and
   * nothing would fail. This enumerates the routes from the ROUTER, not from a
   * list written here, and requires every one of them to be EITHER gated to
   * `admin` OR named in the exported allowlist. A new route is therefore covered
   * the day it is registered: it is in neither category, so the test fails until
   * its author decides — visibly, in the allowlist or in a gate — which it is.
   */
  it("gates every registered /feedback route, enumerated from the router", async () => {
    const runtime = createMemoryRuntime();
    const router = buildRouter({ config: testConfig(), runtime });
    const routes = (
      router as unknown as { routes: { method: string; segments: string[] }[] }
    ).routes
      .filter((route) => route.segments[0] === "feedback")
      .map((route) => ({
        key: `${route.method} /${route.segments.join("/")}`,
        path: "/" + route.segments.map((s) => (s.startsWith(":") ? "feedback-1" : s)).join("/"),
        method: route.method,
      }));

    expect(routes.length, "no /feedback routes were registered at all").toBeGreaterThanOrEqual(3);

    // The allowlist may only name routes that exist — a stale entry would quietly
    // excuse a route from the gate check by matching nothing.
    for (const declared of FEEDBACK_ROUTES_OPEN_TO_ANY_SIGNED_IN_USER) {
      expect(routes.map((route) => route.key)).toContain(declared);
    }

    server = await boot();
    for (const route of routes) {
      if (FEEDBACK_ROUTES_OPEN_TO_ANY_SIGNED_IN_USER.includes(route.key)) continue;
      for (const role of NON_ADMIN_ROLES) {
        const response = await server.request(route.path, {
          method: route.method,
          token: await tokenFor(role),
          headers: { "content-type": "application/json" },
          body: route.method === "GET" ? undefined : JSON.stringify({ status: "resolved" }),
        });
        expect(response.status, `${route.key} did not refuse ${role}`).toBe(403);
      }
    }
  });

  /**
   * The allowlist is the one way past the check above, so its size is pinned.
   * Growing it means declaring that another endpoint is reachable by every
   * signed-in account on the platform, including `citizen`, and that should cost
   * a failing test and a sentence of justification rather than a quiet line.
   */
  it("keeps exactly two routes open to every signed-in user, and no more", () => {
    // WHY THIS LIST GREW FROM ONE TO TWO, since the whole point of the test is
    // that growing it costs a sentence.
    //
    // The write was always open — that is what the feature is for. The READ was
    // `admin` alone, on the argument that free text written by somebody nobody
    // has briefed will name beneficiaries, and the reader set for that should be
    // the smallest set that can act on it. That argument is untouched and still
    // governs `GET /feedback`.
    //
    // What it did not weigh is that a suggestion box nobody can see into
    // collects the same idea five times, and tells no one it is already agreed,
    // already built, or already declined.
    //
    // So the second entry is a READ, and its control is the SHAPE of what it
    // returns rather than the role that may call it: feature requests only, and
    // `toSuggestion` keeps id, summary, status and date. The `detail` box — the
    // field the PII argument is actually about — and the reporter's identity
    // never leave the server on that path. Both properties are tested below;
    // this entry is not to be trusted on the strength of the comment.
    expect([...FEEDBACK_ROUTES_OPEN_TO_ANY_SIGNED_IN_USER]).toEqual([
      "POST /feedback",
      "GET /feedback/suggestions",
    ]);
  });

  it("admits admin alone, per ADR 0016 — not the audit log's two roles", () => {
    expect([...FEEDBACK_ADMIN_ROLES]).toEqual(["admin"]);
  });
});

// ---------------------------------------------------------------------------
// What a submission records
// ---------------------------------------------------------------------------

describe("what a submission records", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function post(role: UserRole, body: unknown) {
    return server.request("/feedback", {
      method: "POST",
      token: await tokenFor(role),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("opens the report, stamps it, and hands back the stored row", async () => {
    server = await boot();
    const response = await post("citizen", REPORT);
    const body = response.body as FeedbackBody;

    expect(response.status).toBe(201);
    expect(body.id).toBe("feedback-1");
    expect(body.status).toBe("open");
    expect(body.createdAt).toEqual(expect.any(String));
  });

  it("attaches the context the page supplied, which the user typed none of", async () => {
    server = await boot();
    const body = (await post("citizen", REPORT)).body as FeedbackBody;

    expect(body.buildCommit).toBe("6c10af3");
    expect(body.buildBranch).toBe("main");
    expect(body.viewPath).toBe("/villages/village-1");
    expect(body.userAgent).toBe("Mozilla/5.0 (Linux; Android 13)");
  });

  it("stores a report with no context at all rather than refusing it", async () => {
    // An un-stamped build has no commit. A report with less context is worth
    // less; a report refused for want of it is worth nothing.
    server = await boot();
    const response = await post("citizen", { kind: "other", summary: "the map will not load" });
    const body = response.body as FeedbackBody;

    expect(response.status).toBe(201);
    expect(body.buildCommit).toBeNull();
    expect(body.detail).toBeNull();
  });

  /**
   * THE TEST THAT MUST NOT BE DELETED.
   *
   * The reporter is taken from `ctx.actor` and from nowhere else. If it were
   * taken from the body, any signed-in user could file a report in a colleague's
   * name, and the administrator working the queue would go back to the wrong
   * person about words they never wrote — a fabricated record on a platform whose
   * founding complaint is that records cannot be trusted.
   */
  it("attributes the report to the signed-in caller, never to whoever the body names", async () => {
    server = await boot();
    const body = (await post("citizen", {
      ...REPORT,
      reporterId: PEOPLE.admin.id,
      reporterEmail: PEOPLE.admin.email,
      reporterRole: "admin",
    })).body as FeedbackBody;

    expect(body.reporterId).toBe(PEOPLE.citizen.id);
    expect(body.reporterEmail).toBe(PEOPLE.citizen.email);
    expect(body.reporterRole).toBe("citizen");
  });

  it("refuses a kind outside the closed set", async () => {
    server = await boot();
    const response = await post("citizen", { ...REPORT, kind: "question" });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toContain("bug, feature, other");
  });

  it("refuses a report with no summary", async () => {
    server = await boot();
    expect((await post("citizen", { kind: "bug" })).status).toBe(400);
    expect((await post("citizen", { ...REPORT, summary: "   " })).status).toBe(400);
  });

  /**
   * The cap, enforced at the boundary. `POST /feedback` is reachable by every
   * signed-in account and writes into an unbounded `text` column, so without this
   * one account with a script fills the database — the request-body ceiling
   * bounds a single request and says nothing about how many arrive.
   */
  it("refuses an over-long summary with 400, and accepts one exactly at the cap", async () => {
    server = await boot();

    const over = await post("citizen", { ...REPORT, summary: "x".repeat(MAX_SUMMARY_LENGTH + 1) });
    expect(over.status).toBe(400);
    expect((over.body as { error: string }).error).toContain(String(MAX_SUMMARY_LENGTH));

    const at = await post("citizen", { ...REPORT, summary: "x".repeat(MAX_SUMMARY_LENGTH) });
    expect(at.status).toBe(201);
  });

  it("refuses an over-long detail with 400", async () => {
    server = await boot();
    const response = await post("citizen", { ...REPORT, detail: "x".repeat(MAX_DETAIL_LENGTH + 1) });
    expect(response.status).toBe(400);
  });

  it("refuses an over-long context field too — a client can send those as freely", async () => {
    server = await boot();
    const response = await post("citizen", { ...REPORT, viewPath: "x".repeat(5_000) });
    expect(response.status).toBe(400);
  });

  it("refuses a body that is not a JSON object", async () => {
    server = await boot();
    expect((await post("citizen", ["bug"])).status).toBe(400);
    expect((await post("citizen", { ...REPORT, summary: 42 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe("the administrator's queue", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function seed(): Promise<void> {
    for (const [role, report] of [
      ["citizen", { kind: "bug", summary: "first" }],
      ["district_officer", { kind: "feature", summary: "second" }],
      ["citizen", { kind: "bug", summary: "third" }],
    ] as const) {
      await server.request("/feedback", {
        method: "POST",
        token: await tokenFor(role),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
    }
  }

  async function list(query = ""): Promise<{ status: number; reports: FeedbackBody[]; nextCursor: string | null }> {
    const response = await server.request(`/feedback${query}`, { token: await tokenFor("admin") });
    const body = response.body as { reports?: FeedbackBody[]; nextCursor?: string | null };
    return {
      status: response.status,
      reports: body.reports ?? [],
      nextCursor: body.nextCursor ?? null,
    };
  }

  it("lists every report newest first, with who filed it", async () => {
    server = await boot();
    await seed();

    const { status, reports } = await list();

    expect(status).toBe(200);
    expect(reports.map((r) => r.summary)).toEqual(["third", "second", "first"]);
    expect(reports[1]?.reporterEmail).toBe(PEOPLE.district_officer.email);
  });

  it("filters by kind", async () => {
    server = await boot();
    await seed();

    expect((await list("?kind=bug")).reports.map((r) => r.summary)).toEqual(["third", "first"]);
  });

  it("filters by status", async () => {
    server = await boot();
    await seed();
    await server.request("/feedback/feedback-2", {
      method: "PATCH",
      token: await tokenFor("admin"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });

    expect((await list("?status=open")).reports.map((r) => r.summary)).toEqual(["third", "first"]);
    expect((await list("?status=resolved")).reports.map((r) => r.summary)).toEqual(["second"]);
  });

  it("refuses a filter value outside the closed set rather than ignoring it", async () => {
    server = await boot();
    await seed();

    // `?status=opne` answered with everything would look exactly like a correct
    // answer to somebody triaging.
    expect((await list("?status=opne")).status).toBe(400);
    expect((await list("?kind=question")).status).toBe(400);
  });

  it("refuses a nonsense limit", async () => {
    server = await boot();
    expect((await list("?limit=-5")).status).toBe(400);
    expect((await list("?limit=abc")).status).toBe(400);
  });

  it("refuses a cursor it did not issue", async () => {
    server = await boot();
    await seed();
    expect((await list("?cursor=not-a-cursor")).status).toBe(400);
  });

  it("pages, returning each report exactly once", async () => {
    server = await boot();
    await seed();

    const first = await list("?limit=2");
    expect(first.reports.map((r) => r.summary)).toEqual(["third", "second"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.reports.map((r) => r.summary)).toEqual(["first"]);
    expect(second.nextCursor).toBeNull();
  });

  it("moves a report's status and reports the moved row", async () => {
    server = await boot();
    await seed();

    const response = await server.request("/feedback/feedback-1", {
      method: "PATCH",
      token: await tokenFor("admin"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "acknowledged" }),
    });

    expect(response.status).toBe(200);
    expect((response.body as FeedbackBody).status).toBe("acknowledged");
    expect((response.body as FeedbackBody).summary).toBe("first");
  });

  it("ignores anything else in the PATCH body — a reporter's words are not editable", async () => {
    server = await boot();
    await seed();

    const response = await server.request("/feedback/feedback-1", {
      method: "PATCH",
      token: await tokenFor("admin"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "declined", summary: "something else entirely" }),
    });

    expect((response.body as FeedbackBody).summary).toBe("first");
  });

  it("refuses a status outside the closed set", async () => {
    server = await boot();
    await seed();

    const response = await server.request("/feedback/feedback-1", {
      method: "PATCH",
      token: await tokenFor("admin"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "wontfix" }),
    });

    expect(response.status).toBe(400);
  });

  it("answers 404 for a report that does not exist, not 502", async () => {
    server = await boot();

    const response = await server.request("/feedback/feedback-nope", {
      method: "PATCH",
      token: await tokenFor("admin"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The shared list of suggestions
// ---------------------------------------------------------------------------

/**
 * `GET /feedback/suggestions` — the one READ open to every signed-in account.
 *
 * This is a deliberate narrowing of ADR 0016's `admin` alone, and the whole
 * safety of it rests on two properties that a refactor could quietly remove:
 * only `feature` reports appear, and each one is reduced to four fields. Both
 * are tested here against the real HTTP server rather than the projection
 * function, because a route that forgets to call `toSuggestion` would leave a
 * unit test of `toSuggestion` perfectly green.
 */
describe("what other signed-in users may see of the suggestion box", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  const IDEA = {
    kind: "feature",
    summary: "let a village committee export its own recovery history",
    detail: "the committee for the village in Nazira asked for this in person",
    viewPath: "/villages/village-1",
  };

  async function file(body: unknown, role: UserRole): Promise<void> {
    const response = await server.request("/feedback", {
      method: "POST",
      token: await tokenFor(role),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status, "the fixture itself failed to file").toBe(201);
  }

  it("refuses an unidentified caller, like every other feedback route", async () => {
    server = await boot();
    const response = await server.request("/feedback/suggestions");
    expect(response.status).toBe(401);
  });

  it.each(NON_ADMIN_ROLES)("lets %s read it — this is the point of the endpoint", async (role) => {
    server = await boot();
    await file(IDEA, "citizen");

    const response = await server.request("/feedback/suggestions", { token: await tokenFor(role) });
    expect(response.status).toBe(200);
    const body = response.body as { suggestions: { summary: string }[] };
    expect(body.suggestions.map((s) => s.summary)).toContain(IDEA.summary);
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * A bug report is how somebody describes what went wrong, and the way anybody
   * describes what went wrong is by naming the record it went wrong on — the
   * `REPORT` fixture above says "the aid record for the beneficiary in Nazira".
   * That is the useful form of a bug report and the dangerous form of a public
   * one. If this endpoint ever returns one, the PII argument ADR 0016 was built
   * on has been lost, silently, to whoever reads the suggestion list next.
   */
  it("never returns a bug report, whatever else is in the store", async () => {
    server = await boot();
    await file(REPORT, "district_officer");            // kind: "bug"
    await file({ ...IDEA, kind: "other" }, "citizen"); // and the third kind
    await file(IDEA, "citizen");

    const response = await server.request("/feedback/suggestions", { token: await tokenFor("citizen") });
    const body = response.body as { suggestions: { summary: string }[] };

    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]?.summary).toBe(IDEA.summary);
    // Named explicitly, so the failure message says what leaked.
    expect(JSON.stringify(body)).not.toContain("aid record for the beneficiary");
  });

  /**
   * `detail` is the long free-text box — the field ADR 0016's argument is
   * actually about, and the one where somebody writes a name. It must not be on
   * this path at all, and neither must the reporter: an idea's merit does not
   * depend on whose it was, and who complained about what is nobody else's
   * business.
   */
  it("carries only id, summary, status and date — no detail, no reporter, no diagnostics", async () => {
    server = await boot();
    await file(IDEA, "district_officer");

    const response = await server.request("/feedback/suggestions", { token: await tokenFor("citizen") });
    const body = response.body as { suggestions: Record<string, unknown>[] };
    const suggestion = body.suggestions[0] as Record<string, unknown>;

    expect(Object.keys(suggestion).sort()).toEqual(["createdAt", "id", "status", "summary"]);
    // And by value, so that a field renamed rather than removed still fails.
    const serialised = JSON.stringify(body);
    for (const leaked of [IDEA.detail, IDEA.viewPath, "district_officer", "@"]) {
      expect(serialised, `${leaked} reached a non-admin reader`).not.toContain(leaked);
    }
  });

  it("still shows the admin the whole report, so nothing was taken away", async () => {
    server = await boot();
    await file(IDEA, "citizen");

    const response = await server.request("/feedback", { token: await tokenFor("admin") });
    const body = response.body as { reports: FeedbackBody[] };
    expect(body.reports[0]?.detail).toBe(IDEA.detail);
    expect(body.reports[0]?.reporterRole).toBe("citizen");
  });
});
