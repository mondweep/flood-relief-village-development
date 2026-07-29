import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import { forbiddenMessage, type UserRole } from "@afrip/shared-kernel";
import { badRequest, forbidden, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Geocoding suggestions (ADR 0012 §3).
 *
 * SUGGESTIONS, and the plural is the whole design. The route returns a ranked
 * list and never a position, because for this geography a geocoder is frequently
 * and confidently wrong: village names repeat across districts, transliteration
 * varies (Rampur / Rampour / রামপুর), and many chapori settlements are in no
 * commercial gazetteer at all. ADR 0012 rejects auto-population outright — a
 * geocoder wired to fill a field without confirmation produces a map that is
 * confidently incorrect, and that map is the platform's first module.
 *
 * The contract: this endpoint proposes, a human confirms on a map, and the result
 * is recorded as `geocoded` — the second-lowest trust level — never as anything
 * surveyed. There is deliberately no `best` field in the response, because a
 * single-value field is an invitation to skip the confirming.
 */

/** Nominatim allows one request per second; nothing here should invite a burst. */
const MAX_CANDIDATES = 8;

/**
 * Who may consult the geocoder: exactly who may register a village, since that
 * is the only reason to call it.
 *
 * DERIVED from ADR 0009's policy table rather than restated, so the two cannot
 * drift. If `registerVillage` is ever opened or narrowed this follows
 * automatically; a second hand-written role list here would be one more thing to
 * remember, and the failure mode of forgetting is a route that stays open after
 * the operation it serves has been closed.
 *
 * The check lives in this handler rather than in the policy table for the same
 * reason as the audit routes: geocoding is not a use case on a bounded context,
 * it is an outbound adapter the registration form consults. `geocode-routes.
 * test.ts` asserts the derivation, so a rename of the policy key fails a test
 * rather than silently emptying the list.
 */
export const GEOCODE_ROLES: readonly UserRole[] =
  PLATFORM_PERMISSIONS["villageRegistry.registerVillage"]?.roles ?? [];

export function registerGeocodeRoutes(router: Router, deps: RouteDeps): void {
  function refuseUnlessWriter(ctx: RequestContext): HttpResponse | null {
    const actor = ctx.actor;
    // A null actor is the legacy-shared-token or open-dev path, which ADR 0009
    // documents as allowed everywhere. Kept consistent with that rather than
    // inventing a stricter rule in one route.
    if (actor == null) return null;
    if (actor.role === "admin") return null;
    if (!GEOCODE_ROLES.includes(actor.role)) {
      return forbidden(forbiddenMessage("look up village coordinates", actor.role));
    }
    return null;
  }

  router.get("/geocode/villages", async (ctx: RequestContext): Promise<HttpResponse> => {
    const refusal = refuseUnlessWriter(ctx);
    if (refusal !== null) return refusal;

    const geocoder = deps.runtime.geocoder;
    if (geocoder === undefined) {
      // Honest rather than empty. An empty candidate list means "the geocoder ran
      // and found nothing", which is a normal answer for a chapori settlement.
      // Returning that when no geocoder exists would send someone hunting for a
      // village the platform never looked for.
      return json(501, {
        error: "no geocoding service is configured on this deployment",
        code: "geocoding_unavailable",
      });
    }

    const name = (ctx.query.get("name") ?? "").trim();
    if (name === "") return badRequest("name is required");

    const district = (ctx.query.get("district") ?? "").trim();
    // Required, not optional. Biasing by district is the cheapest large accuracy
    // win available (ADR 0012 §3) — it is what separates Rampur-in-Barpeta from
    // Rampur-in-Sivasagar, and without it the ranking is close to meaningless.
    if (district === "") {
      return badRequest("district is required — it is what distinguishes villages that share a name");
    }

    const state = (ctx.query.get("state") ?? "").trim();
    const result = await geocoder.forward({
      name,
      district,
      ...(state === "" ? {} : { state }),
      limit: MAX_CANDIDATES,
    });

    if (!result.ok) {
      // 502, never 200-with-nothing. The distinction the port insists on is
      // carried all the way to the client: a geocoder that is down must not look
      // like a village that does not exist.
      return json(502, { error: result.error, code: "geocoding_failed" });
    }

    return json(200, {
      query: { name, district, ...(state === "" ? {} : { state }) },
      candidates: result.value,
      /**
       * Sent so a client cannot pretend it was handed a position. The page reads
       * this, shows the candidates for confirmation on a map, and records the
       * chosen one as `geocoded`.
       */
      guidance: {
        confirmationRequired: true,
        recordAs: "geocoded",
        note:
          "These are suggestions, not a position. Village names repeat across districts and many " +
          "small settlements are missing from map data entirely — confirm on the map before saving.",
      },
    });
  });
}
