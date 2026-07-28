import type { Severity } from "@afrip/village-registry";
import { badRequest, fromResult, fromResultWith, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalString,
  requiredCoordinates,
  requiredNumber,
  requiredString,
} from "../validate.js";
import type { RouteDeps } from "./deps.js";

export function registerVillageRoutes(router: Router, deps: RouteDeps): void {
  const villages = deps.runtime.platform.villageRegistry;

  router.post("/villages", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const district = requiredString(body.value, "district");
    if (!district.ok) return badRequest(district.error);
    const state = requiredString(body.value, "state");
    if (!state.ok) return badRequest(state.error);
    const geo = requiredCoordinates(body.value, "geo");
    if (!geo.ok) return badRequest(geo.error);
    const population = requiredNumber(body.value, "population");
    if (!population.ok) return badRequest(population.error);
    const households = requiredNumber(body.value, "households");
    if (!households.ok) return badRequest(households.error);
    const affectedFamilies = requiredNumber(body.value, "affectedFamilies");
    if (!affectedFamilies.ok) return badRequest(affectedFamilies.error);
    const severity = requiredString(body.value, "severity");
    if (!severity.ok) return badRequest(severity.error);

    // Severity is an enum the Village aggregate validates; we only assert it is a string.
    return fromResult(
      await villages.registerVillage.execute({
        name: name.value,
        district: district.value,
        state: state.value,
        geo: geo.value,
        population: population.value,
        households: households.value,
        affectedFamilies: affectedFamilies.value,
        severity: severity.value as Severity,
      }),
      201,
    );
  });

  router.get("/villages", async (): Promise<HttpResponse> =>
    fromResultWith(await villages.listVillagesBySeverity.execute(), (list) => ({ villages: list })),
  );

  router.get("/villages/:id", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await villages.getVillageProfile.execute({ villageId: ctx.params["id"] ?? "" })),
  );

  router.post("/villages/:id/damage-assessments", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const housesDamaged = requiredNumber(body.value, "housesDamaged");
    if (!housesDamaged.ok) return badRequest(housesDamaged.error);
    const schoolsDamaged = requiredNumber(body.value, "schoolsDamaged");
    if (!schoolsDamaged.ok) return badRequest(schoolsDamaged.error);
    const healthCentresDamaged = requiredNumber(body.value, "healthCentresDamaged");
    if (!healthCentresDamaged.ok) return badRequest(healthCentresDamaged.error);
    const waterSourcesDamaged = requiredNumber(body.value, "waterSourcesDamaged");
    if (!waterSourcesDamaged.ok) return badRequest(waterSourcesDamaged.error);
    const agricultureHectaresLost = requiredNumber(body.value, "agricultureHectaresLost");
    if (!agricultureHectaresLost.ok) return badRequest(agricultureHectaresLost.error);
    const livestockLost = requiredNumber(body.value, "livestockLost");
    if (!livestockLost.ok) return badRequest(livestockLost.error);
    const notes = optionalString(body.value, "notes");
    if (!notes.ok) return badRequest(notes.error);

    return fromResult(
      await villages.recordDamageAssessment.execute({
        villageId: ctx.params["id"] ?? "",
        assessment: {
          housesDamaged: housesDamaged.value,
          schoolsDamaged: schoolsDamaged.value,
          healthCentresDamaged: healthCentresDamaged.value,
          waterSourcesDamaged: waterSourcesDamaged.value,
          agricultureHectaresLost: agricultureHectaresLost.value,
          livestockLost: livestockLost.value,
          ...(notes.value === undefined ? {} : { notes: notes.value }),
        },
      }),
      201,
    );
  });

  router.patch("/villages/:id/severity", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const severity = requiredString(body.value, "severity");
    if (!severity.ok) return badRequest(severity.error);

    return fromResult(
      await villages.updateSeverity.execute({
        villageId: ctx.params["id"] ?? "",
        severity: severity.value as Severity,
      }),
    );
  });
}
