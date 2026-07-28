import type { CommitteeRole } from "@afrip/ngo-coordination";
import { badRequest, fromResult, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalString, requiredNumber, requiredString, requiredStringArray } from "../validate.js";
import type { RouteDeps } from "./deps.js";

/**
 * The VillageAssignment aggregate enforces "one member per role" but does not
 * check the role against the CommitteeRole union, so an arbitrary string would
 * otherwise be persisted. Validating it here keeps the boundary honest.
 */
const COMMITTEE_ROLES: readonly string[] = [
  "leader",
  "volunteer",
  "engineer",
  "teacher",
  "doctor",
  "government_rep",
  "health_worker",
  "school_rep",
  "womens_rep",
];

export function registerNgoRoutes(router: Router, deps: RouteDeps): void {
  const ngos = deps.runtime.platform.ngoCoordination;

  router.post("/ngos", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const focusAreas = requiredStringArray(body.value, "focusAreas");
    if (!focusAreas.ok) return badRequest(focusAreas.error);
    const capacity = requiredNumber(body.value, "capacity");
    if (!capacity.ok) return badRequest(capacity.error);

    return fromResult(
      await ngos.registerNgo.execute({
        name: name.value,
        focusAreas: focusAreas.value,
        capacity: capacity.value,
      }),
      201,
    );
  });

  /** Assigns the village's lead NGO. Retiring any previous assignment is the use case's job. */
  router.post("/villages/:id/assignment", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const ngoId = requiredString(body.value, "ngoId");
    if (!ngoId.ok) return badRequest(ngoId.error);

    return fromResult(
      await ngos.assignNgoToVillage.execute({
        villageId: ctx.params["id"] ?? "",
        ngoId: ngoId.value,
      }),
      201,
    );
  });

  router.post("/villages/:id/committee", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const role = requiredString(body.value, "role");
    if (!role.ok) return badRequest(role.error);
    if (!COMMITTEE_ROLES.includes(role.value)) {
      return badRequest(`invalid committee role: ${role.value}`);
    }
    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const contact = optionalString(body.value, "contact");
    if (!contact.ok) return badRequest(contact.error);

    return fromResult(
      await ngos.addCommitteeMember.execute({
        villageId: ctx.params["id"] ?? "",
        role: role.value as CommitteeRole,
        name: name.value,
        ...(contact.value === undefined ? {} : { contact: contact.value }),
      }),
      201,
    );
  });
}
