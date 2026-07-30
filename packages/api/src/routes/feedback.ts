import { forbiddenMessage, type UserRole } from "@afrip/shared-kernel";
import {
  isFeedbackStatus,
  normaliseDraft,
  normaliseFeedbackFilter,
  toSuggestion,
  FEEDBACK_STATUSES,
  SHARED_FEEDBACK_KIND,
  type FeedbackDraft,
  type FeedbackFilter,
} from "../feedback.js";
import { badRequest, forbidden, json, notFound, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalString, requiredString } from "../validate.js";
import type { RouteDeps } from "./deps.js";

/**
 * In-app feedback over HTTP (ADR 0016).
 *
 * WHY THE ROLE CHECKS ARE HERE AND NOT IN `authorizePlatform`.
 *
 * The same exception `routes/audit.ts` takes, for the same reason. ADR 0009 puts
 * authorization at the use-case boundary, and every other guarded operation goes
 * through the policy table because every other guarded operation is a use case on
 * a bounded context. Feedback is not: it is a report ABOUT the software, not
 * about a village, an NGO or a beneficiary. ADR 0016 §"Reuse the existing
 * issue-tracking context" rejects folding it into `Issue` precisely because
 * "the recovery bar renders wrong" and "the handpump is contaminated" are
 * different registers, and inventing a bounded context to hold a feedback form —
 * purely so the existing gate could see it — would put a false context into the
 * model to satisfy a mechanism.
 *
 * The cost of the exception is real and worth stating: these checks are lines of
 * code in route handlers, so a fourth feedback route added later can omit one and
 * nothing fails. `feedback-routes.test.ts` therefore enumerates every registered
 * `/feedback*` route FROM THE ROUTER and requires each to be either gated or
 * explicitly declared open, so a new route is covered the day it is registered.
 *
 * WHO MAY DO WHAT, and why the two halves differ:
 *
 *   POST /feedback   — any signed-in user. That is the whole point: the people
 *                      who will find version 1's faults are field workers and
 *                      district officers, not the person who built it.
 *   GET /feedback    — `admin` ALONE.
 *   PATCH /feedback/:id — `admin` alone.
 *
 * `admin` alone is deliberately NARROWER than the audit log's `admin` +
 * `district_officer`. ADR 0016 §"Administrators only" argues it: audit payloads
 * are domain events with known, structured fields, while a feedback row is
 * unbounded free text written by somebody who has not been told what not to
 * include — and it will therefore name beneficiaries, which is the sensitivity of
 * the registry itself (ADR 0009). A district officer has no operational need for
 * other districts' complaints, and the reader set for free-text PII should be the
 * smallest set that can act on it. If you are widening this, that section is the
 * argument you have to beat, and `feedback-routes.test.ts` is the test that will
 * stop you doing it by accident.
 */

/**
 * The single role ADR 0016 admits on the read and status-change side. Exported
 * so the test can enumerate rather than restate — and so that widening it is one
 * visible edit rather than three scattered ones.
 */
export const FEEDBACK_ADMIN_ROLES: readonly UserRole[] = ["admin"];

/**
 * The routes any signed-in user may reach, as `"<METHOD> /<path>"`.
 *
 * THIS IS AN ALLOWLIST AND IT IS THE POINT OF THE STRUCTURAL TEST. Every
 * registered `/feedback*` route that is NOT named here must refuse every
 * non-admin role, and `feedback-routes.test.ts` proves it by walking the router.
 * Adding an entry here is therefore a deliberate declaration that a new endpoint
 * is reachable by every signed-in account on the platform — including `citizen`
 * — and the test additionally pins the size of this list so that growing it
 * cannot happen quietly.
 *
 * Two entries. The submission itself, and the shared list of suggestions —
 * which is a READ, and therefore the one that needed an argument rather than an
 * assumption. See `FeedbackSuggestion` in `../feedback.ts` for it: the control
 * on that route is the SHAPE of what it returns, not the role that may call it.
 */
export const FEEDBACK_ROUTES_OPEN_TO_ANY_SIGNED_IN_USER: readonly string[] = [
  "POST /feedback",
  "GET /feedback/suggestions",
];

/**
 * ANONYMOUS SUBMISSION IS REFUSED, and ADR 0016 §"Signed-in only" calls this a
 * real trade-off rather than an oversight: the public transparency view is
 * reachable without an account, so a visitor who spots a fault there cannot
 * report it.
 *
 * It is accepted because the alternative is worse in this specific deployment.
 * An unauthenticated write endpoint on a single-file page with no captcha, no
 * rate limiter and no moderation queue is a spam sink, and the first thing that
 * fills it makes every genuine report harder to find. Everyone the PRD describes
 * as a *user* already needs an account to do anything beyond reading.
 *
 * So this returns 403 and NEVER writes a row with a null reporter. A row nobody
 * can be asked about is not a cheaper report; it is the report that cannot be
 * followed up, filed under a table whose whole value is that somebody can go back
 * to the person who noticed.
 *
 * `forbidden(forbiddenMessage(...))` rather than a bespoke body, so the
 * frontend's single 403 path handles this the same way it handles a use-case
 * denial. A second spelling would be a second thing to keep in step for no
 * benefit.
 */
function refuseUnlessSignedIn(ctx: RequestContext): HttpResponse | null {
  if (ctx.actor == null) {
    // No identity. On a JWT deployment the gate has already refused; this covers
    // the shared-token and open-dev paths, where "who is asking?" has no answer
    // and there is nobody to attribute the report to.
    return forbidden(forbiddenMessage("submit feedback", "an unidentified caller"));
  }
  return null;
}

/** The gate on everything an administrator does with the queue. */
function refuseUnlessAdmin(ctx: RequestContext, operation: string): HttpResponse | null {
  const actor = ctx.actor;
  if (actor == null) return forbidden(forbiddenMessage(operation, "an unidentified caller"));
  if (!FEEDBACK_ADMIN_ROLES.includes(actor.role)) {
    return forbidden(forbiddenMessage(operation, actor.role));
  }
  return null;
}

/**
 * Builds the draft from the request.
 *
 * TWO SOURCES, AND THE SPLIT IS THE SECURITY-RELEVANT PART.
 *
 * The context fields come from the BODY: the page knows which build it is
 * running and which view the user was on, and the server does not. They are
 * "captured automatically" in ADR 0016's sense — the user types none of them —
 * which is a statement about the form, not about who can forge them. A client
 * can lie about `viewPath`; the consequence is a misleading bug report, and it is
 * accepted for the same reason the ADR accepts that the "please do not type
 * names" line will be imperfectly obeyed.
 *
 * The reporter comes from `ctx.actor` and from NOWHERE ELSE. A body carrying
 * `reporterId` or `reporterEmail` is ignored in silence — not merged, not
 * preferred, not even read. If it were taken from the body, any signed-in user
 * could file a report in a colleague's name, and the administrator working the
 * queue would go back to the wrong person about words they never wrote. That is
 * a fabricated record on a platform whose founding complaint is that records
 * cannot be trusted, and `feedback-routes.test.ts` asserts it by POSTing a body
 * that claims to be somebody else.
 *
 * `userAgent` IS TAKEN FROM THE BODY, not from the request header, and that is
 * worth being explicit about because the header would be the more natural
 * source. `RequestContext` (see `router.ts`) carries method, path, params, query,
 * body, actor, claims, platform and requestId — it does not carry headers, and
 * `app.ts` does not put them there. Reaching the `user-agent` header would mean
 * widening that interface and the dispatcher that fills it, which is a change to
 * files outside this feature. Nothing is lost in security terms: a user agent is
 * client-supplied either way and is not an identity, so a body-supplied one is
 * exactly as trustworthy as a header-supplied one. What IS lost is convenience —
 * a client that forgets to send it stores null where the header would always have
 * had something. If that turns out to matter, the fix is a `headers` field on
 * `RequestContext`, populated in `app.ts`, read here in preference to the body.
 */
function readDraft(ctx: RequestContext): { ok: true; value: FeedbackDraft } | { ok: false; error: string } {
  const parsed = asObject(ctx.body);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const body = parsed.value;

  const kind = requiredString(body, "kind");
  if (!kind.ok) return { ok: false, error: kind.error };
  const summary = requiredString(body, "summary");
  if (!summary.ok) return { ok: false, error: summary.error };
  const detail = optionalString(body, "detail");
  if (!detail.ok) return { ok: false, error: detail.error };

  const context: Record<string, string | null> = {};
  for (const field of ["buildCommit", "buildBranch", "viewPath", "userAgent"] as const) {
    const value = optionalString(body, field);
    if (!value.ok) return { ok: false, error: value.error };
    context[field] = value.value ?? null;
  }

  // The actor is non-null by the time this is called — `refuseUnlessSignedIn`
  // ran first — but it is read defensively rather than asserted, so that
  // reordering the two calls degrades to a null reporter rather than a crash.
  const actor = ctx.actor ?? null;

  const draft: FeedbackDraft = {
    // `kind` is checked against the closed set by `normaliseDraft` below, which
    // is also what the adapters call — one list, one place, no drift.
    kind: kind.value as FeedbackDraft["kind"],
    summary: summary.value,
    detail: detail.value ?? null,
    context: {
      buildCommit: context["buildCommit"] ?? null,
      buildBranch: context["buildBranch"] ?? null,
      viewPath: context["viewPath"] ?? null,
      userAgent: context["userAgent"] ?? null,
    },
    reporter: {
      id: actor?.id ?? null,
      email: actor?.email ?? null,
      role: actor?.role ?? null,
    },
  };

  // The caps and the closed `kind` set, applied HERE so the caller gets a 400
  // that names the field. The adapters re-apply them; see `normaliseDraft` for
  // why the duplication is deliberate.
  const normalised = normaliseDraft(draft);
  if (!normalised.ok) return { ok: false, error: normalised.error };
  return { ok: true, value: normalised.value };
}

/** Reads `?kind=`, `?status=`, `?limit=` and `?cursor=`. Values are checked in `feedback.ts`. */
function readFilter(ctx: RequestContext): { ok: true; value: FeedbackFilter } | { ok: false; error: string } {
  const q = ctx.query;

  const rawLimit = q.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    limit = parsed;
  }

  return {
    ok: true,
    value: {
      ...(q.get("kind") ? { kind: q.get("kind") as string } : {}),
      ...(q.get("status") ? { status: q.get("status") as string } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(q.get("cursor") ? { cursor: q.get("cursor") as string } : {}),
    },
  };
}

export function registerFeedbackRoutes(router: Router, deps: RouteDeps): void {
  /**
   * File a report (ADR 0016).
   *
   * 201 with the stored row, not 202 or an empty body: the row carries the id,
   * the status and the instant the database stamped, and a person who has just
   * reported a bug is owed the evidence that it landed somewhere.
   */
  router.post("/feedback", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessSignedIn(ctx);
    if (refusal !== null) return refusal;

    const draft = readDraft(ctx);
    if (!draft.ok) return badRequest(draft.error);

    const result = await deps.runtime.feedback.submit(draft.value);
    if (!result.ok) {
      // A failure the user must be told about, unlike a failed audit write: this
      // IS their request, and reporting success for a row that was never written
      // would send them away believing they had been heard.
      return json(502, { error: result.error, code: "feedback_unwritable" });
    }
    return json(201, result.value);
  });

  /**
   * What has already been suggested — readable by any signed-in user.
   *
   * REGISTERED BEFORE `GET /feedback/:id` would be, and that ordering matters:
   * `/feedback/suggestions` must not be matched as an id by a future
   * single-report route. There is no such route today; this comment is here so
   * that adding one does not silently turn this endpoint into a 404 or, worse,
   * a lookup for a report whose id happens to be "suggestions".
   *
   * The gate is `refuseUnlessSignedIn`, NOT `refuseUnlessAdmin`, and that is the
   * one place this feature departs from ADR 0016 as written. The departure is
   * argued in full at `FeedbackSuggestion` in `../feedback.ts`; the short form
   * is that a suggestion box only one person can see into collects the same idea
   * five times and tells nobody it is already agreed.
   *
   * TWO THINGS MAKE THAT SAFE, and both are enforced here rather than trusted:
   *
   *   1. Only `SHARED_FEEDBACK_KIND` — `feature`. Bug reports stay admin-only,
   *      because the way anybody describes what went wrong is by naming the
   *      record it went wrong on.
   *   2. `toSuggestion` drops everything except id, summary, status and date.
   *      The long free-text `detail` box — the field ADR 0016's PII argument is
   *      actually about — never leaves the server on this path, and neither
   *      does who filed it.
   *
   * The filter is applied at the STORE, not after fetching: a `detail` string
   * this endpoint never asked for cannot be leaked by a later refactor that
   * forgets to project.
   */
  router.get("/feedback/suggestions", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessSignedIn(ctx);
    if (refusal !== null) return refusal;

    const result = await deps.runtime.feedback.query({ kind: SHARED_FEEDBACK_KIND });
    if (!result.ok) {
      // Same reasoning as the admin queue: never an empty list on failure.
      // "Nobody has suggested anything" is an invitation to file a duplicate.
      return json(502, { error: result.error, code: "feedback_unreadable" });
    }

    // Defence in depth. `query` was asked for one kind and the adapters honour
    // it, but this list is the one non-admin readers see, so the kind is
    // checked again here rather than assumed. A bug report reaching this array
    // is the failure this whole endpoint has to not have.
    const suggestions = result.value.reports
      .filter((report) => report.kind === SHARED_FEEDBACK_KIND)
      .map(toSuggestion);

    return json(200, { suggestions });
  });

  /**
   * The administrator's queue. There is no notification anywhere in this
   * feature (ADR 0016 §Status), so this endpoint IS the mechanism by which a
   * report gets seen — which is why a filter that silently matched nothing, or
   * silently matched everything, would be worse here than in most listings. Both
   * filters are refused rather than ignored when they name a value outside the
   * closed set; see `normaliseFilter` in `feedback.ts`.
   */
  router.get("/feedback", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessAdmin(ctx, "read submitted feedback");
    if (refusal !== null) return refusal;

    const filter = readFilter(ctx);
    if (!filter.ok) return badRequest(filter.error);

    // Checked HERE as well as inside the store, so that a bad `status` or a
    // malformed cursor is a 400 that names the mistake rather than a 502 that
    // blames the database. The store checks again for callers that never came
    // through a route.
    const checked = normaliseFeedbackFilter(filter.value);
    if (!checked.ok) return badRequest(checked.error);

    const result = await deps.runtime.feedback.query(filter.value);
    if (!result.ok) {
      // Reported as a failure, never as an empty page. `reports: []` would read
      // as "nobody has ever reported anything" — and since nothing notifies an
      // administrator, that list is the only place a report is ever seen.
      return json(502, { error: result.error, code: "feedback_unreadable" });
    }
    return json(200, { reports: result.value.reports, nextCursor: result.value.nextCursor });
  });

  /**
   * Move a report's status — the entire workflow ADR 0016 admits.
   *
   * PATCH and not PUT: this replaces one field of a resource whose other fields
   * are the reporter's and must not be reachable from here at all. The body is
   * read for `status` and nothing else, so a body that also carries `summary` is
   * ignored rather than obeyed — the narrow write that 00009's `grant update`
   * cannot express in SQL (see that file's header).
   */
  router.patch("/feedback/:id", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessAdmin(ctx, "change the status of submitted feedback");
    if (refusal !== null) return refusal;

    const parsed = asObject(ctx.body);
    if (!parsed.ok) return badRequest(parsed.error);
    const status = requiredString(parsed.value, "status");
    if (!status.ok) return badRequest(status.error);
    if (!isFeedbackStatus(status.value)) {
      return badRequest(`status must be one of ${FEEDBACK_STATUSES.join(", ")}: ${status.value}`);
    }

    const id = ctx.params["id"] ?? "";
    if (id === "") return badRequest("id is required");

    const result = await deps.runtime.feedback.setStatus(id, status.value);
    if (!result.ok) return json(502, { error: result.error, code: "feedback_unwritable" });
    // `null` is "no such report", which the store reports separately from "the
    // store could not be asked" precisely so this can be a 404 rather than a 502.
    if (result.value === null) return notFound(`feedback not found: ${id}`);
    return json(200, result.value);
  });
}
