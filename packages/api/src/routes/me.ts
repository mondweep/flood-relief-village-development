import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import type { UserRole } from "@afrip/shared-kernel";
import type { ActorContext } from "../auth.js";
import { json, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/** The body `GET /me` answers with. The frontend renders `email` and `role`. */
export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  /**
   * Which `"<context>.<useCase>"` keys this role may invoke (ADR 0009), so the
   * page can hide controls the API would refuse.
   *
   * DERIVED from `PLATFORM_PERMISSIONS`, never hand-written. The alternative — a
   * copy of the matrix in the frontend — is a second source of truth for
   * authorization, and the way it fails is that a rule tightened here keeps
   * showing an enabled button there. One table, two readers.
   *
   * Advisory only. It says what the server would allow, and the server checks
   * again on every call; a client that ignores this list gets 403s, not access.
   *
   * Ownership is deliberately NOT reflected. A rule the actor can reach only for
   * records they created is listed as permitted, because whether they own any
   * given record is a per-record question this response has no record in hand
   * for. The consequence is a control that is shown and sometimes refused, which
   * is the right way round: hiding it would deny people the edit ADR 0009 exists
   * to grant them.
   */
  readonly permissions: readonly string[];
  /** Absent when the deployment cannot say. See `meBody`. */
  readonly roleSource?: string;
}

/**
 * The keys `role` may invoke. `admin` is allowed everywhere without appearing in
 * any rule (see `authorize-platform.ts`), so it gets the whole table.
 */
export function permissionsFor(role: UserRole): string[] {
  return Object.entries(PLATFORM_PERMISSIONS)
    .filter(([, rule]) => role === "admin" || rule.roles.includes(role))
    .map(([key]) => key)
    .sort();
}

export const NO_IDENTITY_CODE = "identity_unavailable";

/**
 * Who am I? (ADR 0008)
 *
 * The frontend calls this immediately after sign-in for two reasons: to prove
 * the token it just obtained is one this API will actually accept — a token
 * that verifies against a *different* project looks fine to the browser and
 * fails on every subsequent call — and to render the signed-in identity.
 *
 * It reports the profile, not the token: `role` is the value in
 * `assam_floods.user_profiles`, so a user cannot see a role here that the API
 * would not act on.
 */
/** The 401 code the frontend turns into an offer to register. */
export const NOT_ENROLLED_CODE = "user_unknown";

export function registerMeRoutes(router: Router, deps: RouteDeps): void {
  /**
   * Register with AFRIP.
   *
   * The one route reachable with a verified token and NO AFRIP profile (see
   * `IDENTIFIED_ONLY_PATHS`), because creating that profile is what it does.
   *
   * This exists because the Supabase project is shared with four unrelated
   * applications and `auth.users` is project-wide. An earlier design had a
   * database trigger create a profile for every signup on the project, which
   * enrolled those applications' users in AFRIP without anyone here deciding so.
   * That trigger is gone. Membership is now something a person asks for.
   *
   * It is deliberately NOT a gate against those users — their credential still
   * works, so any of them could call this. What it removes is enrolment they did
   * not ask for. `user_profiles` records `auth_created_at` alongside
   * `enrolled_at` so an administrator can see an account that existed for months
   * before it turned up here, which is the shape a wandering neighbour has.
   *
   * Idempotent: enrolling twice returns the existing profile, and never resets a
   * role. A district officer who clicks register again stays a district officer.
   */
  router.post("/me/enrolment", async (ctx): Promise<HttpResponse> => {
    // Already enrolled: answer with the profile rather than an error. The client
    // reaches here after a 401 it may have raced against another tab.
    if (ctx.actor != null) return json(200, meBody(ctx.actor));

    const claims = ctx.claims;
    if (claims === undefined) {
      // No verified token — the shared legacy token, or an open dev server.
      // Enrolment needs a `sub` that was SIGNED; there is nobody here to enrol.
      return {
        ...json(401, {
          error: "registration needs a Supabase sign-in — this request carries no verified identity",
          code: NO_IDENTITY_CODE,
        }),
        headers: { "www-authenticate": 'Bearer realm="afrip"' },
      };
    }

    const enrolment = deps.runtime.enrolment;
    if (enrolment === undefined) {
      // Memory-mode runtimes have no profile store to write to. Say so plainly
      // rather than pretending to have registered someone.
      return json(501, {
        error: "this deployment has no profile store, so it cannot register users",
        code: "enrolment_unavailable",
      });
    }

    const result = await enrolment.enrol(claims);
    if (!result.ok) return json(502, { error: result.error, code: "enrolment_failed" });
    return json(201, meBody(result.value));
  });

  router.get("/me", async (ctx): Promise<HttpResponse> => {
    const actor = ctx.actor ?? null;
    if (actor === null) {
      // Reached when the request was authorised by something that carries no
      // identity: the transitional shared token, or a wide-open dev server.
      // Answering 200 with a fabricated user would be worse than refusing.
      return {
        ...json(401, {
          error: "this request carries no user identity — sign in with Supabase",
          code: NO_IDENTITY_CODE,
        }),
        headers: { "www-authenticate": 'Bearer realm="afrip"' },
      };
    }

    return json(200, meBody(actor));
  });
}

function meBody(actor: ActorContext): MeResponse {
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    permissions: permissionsFor(actor.role),
    /*
     * WHERE THE ROLE CAME FROM (ADR 0018), so the page can show the appointment
     * panel to the people who may use it.
     *
     * COSMETIC, exactly like `permissions`. The gate that matters is
     * `isSuperAdmin` in front of every /admin route; this is here so an
     * administrator who cannot appoint is not shown a panel whose every button
     * returns 403. Flipping it in devtools reveals a form and changes nothing
     * about what the server will accept.
     *
     * Emitted only when it is known — an actor resolved by the in-memory
     * directory has no provenance, and a fabricated "self" would be this file
     * inventing a fact rather than reporting one.
     */
    ...(actor.roleSource === undefined ? {} : { roleSource: actor.roleSource }),
  };
}
