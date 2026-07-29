import { forbiddenMessage, type UserRole } from "@afrip/shared-kernel";
import type { AuditFilter } from "../audit.js";
import { badRequest, forbidden, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Audit reporting (ADR 0011 §Reporting).
 *
 * WHY THE ROLE CHECK IS HERE AND NOT IN `authorizePlatform`.
 *
 * ADR 0009 puts authorization at the use-case boundary, and every other guarded
 * operation in this API goes through the policy table because every other
 * guarded operation is a use case on a bounded context. The audit log is not: it
 * is cross-cutting infrastructure that sits *beside* the nine contexts and
 * records all of them. Inventing a tenth context to hold it, purely so the
 * existing gate could see it, would put a false bounded context into the model
 * to satisfy a mechanism.
 *
 * The cost of the exception is real and worth stating: this check is a line of
 * code in a route handler, so a tenth audit route added later can omit it and
 * nothing fails. `audit-routes.test.ts` therefore asserts that EVERY registered
 * `/audit*` path refuses a citizen — enumerated from the router, not listed by
 * hand, so a new route is covered the day it is added.
 *
 * WHO MAY READ. `admin` and `district_officer` only. Payloads carry whatever the
 * events carried, which for `beneficiary.registered.v1` is a name — so this
 * inherits the beneficiary registry's sensitivity (ADR 0011 §PII) and is never
 * served under `/public/*`, never to `anon`, and never to a citizen, an NGO
 * coordinator or a village committee member. An NGO coordinator can already read
 * the beneficiaries they are responsible for through the registry; what they
 * cannot have is the cross-village history of everyone.
 */

/** The two roles ADR 0011 admits. Exported so the test can enumerate rather than restate. */
export const AUDIT_READER_ROLES: readonly UserRole[] = ["admin", "district_officer"];

/**
 * The refusal, in the same shape a use-case denial produces, so the frontend's
 * single 403 path handles both. A separate spelling here would be a second thing
 * to keep in step for no benefit.
 */
function refuseUnlessReader(ctx: RequestContext): HttpResponse | null {
  const actor = ctx.actor;
  if (actor == null) {
    // No identity. On a JWT deployment the gate has already refused; this covers
    // the shared-token and open-dev paths, where "who is asking?" has no answer
    // and the honest response to an audit query is not to serve it.
    return forbidden(forbiddenMessage("read the audit trail", "an unidentified caller"));
  }
  if (!AUDIT_READER_ROLES.includes(actor.role)) {
    return forbidden(forbiddenMessage("read the audit trail", actor.role));
  }
  return null;
}

/** ISO-8601 or nothing. A malformed bound silently ignored would quietly widen the query. */
function isoOrNull(raw: string | null): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true };
  if (Number.isNaN(Date.parse(raw))) return { ok: false, error: `not an ISO-8601 instant: ${raw}` };
  return { ok: true, value: raw };
}

function readFilter(ctx: RequestContext): { ok: true; value: AuditFilter } | { ok: false; error: string } {
  const q = ctx.query;
  const from = isoOrNull(q.get("from"));
  if (!from.ok) return { ok: false, error: `from: ${from.error}` };
  const to = isoOrNull(q.get("to"));
  if (!to.ok) return { ok: false, error: `to: ${to.error}` };

  const rawLimit = q.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    limit = parsed;
  }

  const filter: AuditFilter = {
    ...(q.get("subjectType") ? { subjectType: q.get("subjectType") as string } : {}),
    ...(q.get("subjectId") ? { subjectId: q.get("subjectId") as string } : {}),
    ...(q.get("actorId") ? { actorId: q.get("actorId") as string } : {}),
    ...(q.get("eventName") ? { eventName: q.get("eventName") as string } : {}),
    ...(from.value === undefined ? {} : { from: from.value }),
    ...(to.value === undefined ? {} : { to: to.value }),
    ...(limit === undefined ? {} : { limit }),
    ...(q.get("cursor") ? { cursor: q.get("cursor") as string } : {}),
  };
  return { ok: true, value: filter };
}

export function registerAuditRoutes(router: Router, deps: RouteDeps): void {
  /**
   * Answers a query, or says why it cannot. A read failure is reported as a
   * failure — never as an empty page, which in an audit report would read as
   * "nothing ever happened here" and is the most dangerous wrong answer this
   * endpoint could give.
   */
  async function answer(ctx: RequestContext, filter: AuditFilter): Promise<HttpResponse> {
    const log = deps.runtime.auditLog;
    if (log === undefined) {
      return json(501, {
        error: "this deployment keeps no audit log",
        code: "audit_unavailable",
      });
    }
    const result = await log.query(filter);
    if (!result.ok) {
      return json(502, { error: result.error, code: "audit_unreadable" });
    }
    return json(200, { entries: result.value.entries, nextCursor: result.value.nextCursor });
  }

  router.get("/audit", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessReader(ctx);
    if (refusal !== null) return refusal;
    const filter = readFilter(ctx);
    if (!filter.ok) return badRequest(filter.error);
    return answer(ctx, filter.value);
  });

  /**
   * "Show me everything that ever happened to this village."
   *
   * ADR 0011 calls this the one that matters to the product, and it is the
   * question a district officer actually asks. Note the honest limit, which is
   * documented on AUDIT_SUBJECTS: an event's subject is the aggregate whose
   * state changed, so this returns what happened TO the village, not everything
   * that mentions it — an NGO assignment is subject `assignment`, a beneficiary
   * registration is subject `beneficiary`. Widening it would mean a second
   * index on payload contents and is deliberately not done here.
   */
  router.get("/audit/subjects/:type/:id", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessReader(ctx);
    if (refusal !== null) return refusal;
    const filter = readFilter(ctx);
    if (!filter.ok) return badRequest(filter.error);
    return answer(ctx, {
      ...filter.value,
      subjectType: ctx.params["type"] ?? "",
      subjectId: ctx.params["id"] ?? "",
    });
  });

  /** Everything one account has done. The other half of accountability. */
  router.get("/audit/actors/:id", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessReader(ctx);
    if (refusal !== null) return refusal;
    const filter = readFilter(ctx);
    if (!filter.ok) return badRequest(filter.error);
    return answer(ctx, { ...filter.value, actorId: ctx.params["id"] ?? "" });
  });
}
