import { forbiddenMessage, isSuperAdmin } from "@afrip/shared-kernel";
import {
  decideRoleChange,
  roleChangedEvent,
  type ManagedUser,
} from "../user-administration.js";
import { badRequest, forbidden, json, notFound, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, requiredString } from "../validate.js";
import type { RouteDeps } from "./deps.js";

/**
 * Appointing people over HTTP (ADR 0018).
 *
 * THE MOST DANGEROUS WRITE ON THE PLATFORM. Every other route changes a record
 * about the world; this one changes who is allowed to read the register of
 * widows and orphaned children. It is therefore the narrowest: two routes, one
 * caller type, and the decision itself lives in `user-administration.ts` where
 * it can be tested without an HTTP server.
 *
 * THE GATE IS `isSuperAdmin`, NOT "is an admin".
 *
 * Being an `admin` is not enough, and that distinction is the whole feature. An
 * administrator appointed through this endpoint can do everything an
 * administrator does — read the beneficiary register, the audit trail, the
 * feedback queue — EXCEPT appoint another one. So the set of people who can hand
 * out unchecked access stays exactly the set named in `role_grants`, which is a
 * migration, which is a diff somebody reviewed.
 *
 * Without that, "who may appoint administrators" stops being a question
 * answerable from this repository, and becomes a click somebody made once.
 *
 * WHY THE CHECKS ARE HERE AND NOT IN `authorizePlatform`: the same exception
 * `routes/audit.ts` and `routes/feedback.ts` take. "Who may act as a district
 * officer" is a statement about the platform's own access control, not about
 * villages, NGOs or beneficiaries, and inventing a bounded context to hold it
 * would put a false context into the model to satisfy a mechanism.
 *
 * The cost is the same and so is the mitigation: `admin-users-routes.test.ts`
 * enumerates every registered `/admin/*` route FROM THE ROUTER and requires each
 * to refuse every role including a non-grant `admin`, so a route added later is
 * covered the day it is registered.
 */

/** Refuses anyone who is not an administrator named in version control. */
function refuseUnlessSuperAdmin(ctx: RequestContext, operation: string): HttpResponse | null {
  if (isSuperAdmin(ctx.actor ?? null)) return null;
  // `forbiddenMessage` so the frontend's single 403 path handles this the same
  // way it handles a use-case denial. The role is named where there is one — an
  // appointed admin being refused deserves to know it is not their role that is
  // wrong but where it came from, and the body carries that below.
  return forbidden(forbiddenMessage(operation, ctx.actor?.role ?? "an unidentified caller"));
}

export function registerAdminUserRoutes(router: Router, deps: RouteDeps): void {
  /**
   * Everyone registered with AFRIP, and what role they hold.
   *
   * SUPER ADMIN ONLY, even though this is only a read. The list is every user's
   * email address next to their role — a directory of who has access to what, on
   * a platform holding a register of vulnerable people. That is exactly the
   * reconnaissance an attacker who has compromised one account wants, and there
   * is no operational need for anybody else to have it: an administrator who
   * cannot appoint cannot act on this list either.
   */
  router.get("/admin/users", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessSuperAdmin(ctx, "list the platform's users");
    if (refusal !== null) return refusal;

    const result = await deps.runtime.users.list();
    if (!result.ok) {
      // Never an empty list on failure. "Nobody is registered" is a statement
      // somebody would act on, and it is never true — the caller is registered.
      return json(502, { error: result.error, code: "users_unreadable" });
    }
    return json(200, { users: result.value });
  });

  /**
   * Change somebody's role.
   *
   * The sequence matters and is not incidental:
   *
   *   1. gate on super admin — before anything is read, so a refused caller
   *      learns nothing about who exists;
   *   2. read the target, and keep its CURRENT role;
   *   3. apply every rule in `decideRoleChange`, which does no I/O;
   *   4. write;
   *   5. record the change, with both the old and the new role.
   *
   * Step 2's "keep the current role" is the one that would be easy to lose. The
   * previous value is unrecoverable after the update — `audit_log` is
   * append-only and there is no earlier row for this to join to — so a log entry
   * saying only "X is now a district officer" could never be reviewed. "X was a
   * citizen and is now a district officer" can.
   */
  router.patch("/admin/users/:id/role", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessSuperAdmin(ctx, "change a user's role");
    if (refusal !== null) return refusal;

    const parsed = asObject(ctx.body);
    if (!parsed.ok) return badRequest(parsed.error);
    const role = requiredString(parsed.value, "role");
    if (!role.ok) return badRequest(role.error);

    const id = ctx.params["id"] ?? "";
    if (id === "") return badRequest("id is required");

    const found = await deps.runtime.users.find(id);
    if (!found.ok) return json(502, { error: found.error, code: "users_unreadable" });
    const target: ManagedUser | null = found.value;

    const decision = decideRoleChange({ actor: ctx.actor ?? null, target, role: role.value });
    if (!decision.allowed) {
      // 404 only for a target that does not exist; every other refusal is a 403
      // with the reason, because the caller is entitled to know why — they are
      // the platform's owner and "it did not work" is not an answer they can act
      // on.
      if (decision.refusal === "unknown_user") return notFound(decision.because ?? "no such user");
      if (decision.refusal === "unknown_role") return badRequest(decision.because ?? "unknown role");
      return json(403, {
        error: decision.because ?? "not permitted",
        code: "not_permitted",
        refusal: decision.refusal,
      });
    }

    // Captured BEFORE the write. See the note above.
    const previousRole = (target as ManagedUser).role;

    const changed = await deps.runtime.users.changeRole({ userId: id, role: role.value as ManagedUser["role"] });
    if (!changed.ok) return json(502, { error: changed.error, code: "users_unwritable" });
    if (changed.value === null) {
      // The adapter's own `neq("role_source", "grant")` matched nothing. Either
      // the row vanished between the two calls, or it is grant-sourced and
      // `decideRoleChange` was bypassed. Both are "refused", not "written".
      return json(409, {
        error: "That user's role could not be changed. It may be set in the platform's grant list.",
        code: "role_unchanged",
      });
    }

    /*
     * THE AUDIT WRITE, and it is deliberately AFTER the change rather than
     * around it.
     *
     * ADR 0011's position is that the log records what happened, so an entry for
     * a write that failed would be a false record — worse than a missing one.
     * The cost is the opposite failure: a change that succeeds and is not
     * logged, if this throws. That is why it is not swallowed silently; the
     * error is surfaced to the operator in the log even though the caller gets
     * their 200, because the change DID happen and telling them otherwise would
     * be the false record all over again.
     */
    try {
      await deps.runtime.auditLog.record({
        ...roleChangedEvent({
          target: target as ManagedUser,
          from: previousRole,
          to: changed.value.role,
          occurredAt: new Date().toISOString(),
        }),
        // Stamped here rather than by `ActorStampingPublisher`, because this
        // event does not travel through the domain event bus — there is no
        // bounded context to raise it. Named explicitly so the exception is
        // visible rather than looking like the ADR 0010 path.
        //
        // `kind: "user"` is what makes it an `EventActor` rather than an
        // `AuthenticatedActor`; the two differ because an event is a record of
        // the past and types its role as a plain string, so a renamed role still
        // round-trips through the audit trail.
        ...(ctx.actor == null
          ? {}
          : {
              actor: {
                kind: "user" as const,
                id: ctx.actor.id,
                email: ctx.actor.email,
                role: ctx.actor.role,
              },
            }),
      });
    } catch (error) {
      console.error(
        `[api] role change for ${id} was applied but NOT audited: ${String(error)}`,
      );
    }

    return json(200, changed.value);
  });
}
