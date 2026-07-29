import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import type { UserRole } from "@afrip/shared-kernel";
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
export function registerMeRoutes(router: Router, _deps: RouteDeps): void {
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

    const body: MeResponse = {
      id: actor.id,
      email: actor.email,
      role: actor.role,
      permissions: permissionsFor(actor.role),
    };
    return json(200, body);
  });
}
