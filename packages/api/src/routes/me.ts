import { json, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/** The body `GET /me` answers with. The frontend renders `email` and `role`. */
export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly role: string;
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

    const body: MeResponse = { id: actor.id, email: actor.email, role: actor.role };
    return json(200, body);
  });
}
