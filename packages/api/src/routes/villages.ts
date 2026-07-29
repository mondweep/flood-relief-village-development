import type { DamageAssessment, Severity } from "@afrip/village-registry";
import { badRequest, fromResult, fromResultWith, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalCoordinates,
  optionalNumber,
  optionalString,
  requiredCoordinates,
  requiredNumber,
  requiredString,
} from "../validate.js";
import type { RouteDeps } from "./deps.js";

/** One entry on a village's timeline (ADR 0013). */
interface HistoryItem {
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: unknown;
}

export function registerVillageRoutes(router: Router, deps: RouteDeps): void {
  const villages = deps.runtime.platform.villageRegistry;
  const recovery = deps.runtime.platform.recoveryIntelligence;

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

  /**
   * Correction — "our record was wrong" (ADR 0013). Deliberately NOT a
   * `PUT /villages/:id`: a full-replacement route cannot say whether a value
   * moved because the world changed or because we mistyped it, and the whole
   * point of this platform is that someone can reconstruct that later.
   *
   * Every field is optional, `reason` is not. Severity is absent on purpose —
   * it is a transition, and `PATCH /villages/:id/severity` already records it
   * with its previous value.
   */
  router.patch("/villages/:id/profile", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const reason = requiredString(body.value, "reason");
    if (!reason.ok) return badRequest(reason.error);
    const name = optionalString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const district = optionalString(body.value, "district");
    if (!district.ok) return badRequest(district.error);
    const state = optionalString(body.value, "state");
    if (!state.ok) return badRequest(state.error);
    const geo = optionalCoordinates(body.value, "geo");
    if (!geo.ok) return badRequest(geo.error);
    const population = optionalNumber(body.value, "population");
    if (!population.ok) return badRequest(population.error);
    const households = optionalNumber(body.value, "households");
    if (!households.ok) return badRequest(households.error);
    const affectedFamilies = optionalNumber(body.value, "affectedFamilies");
    if (!affectedFamilies.ok) return badRequest(affectedFamilies.error);

    return fromResult(
      await villages.correctVillageProfile.execute({
        villageId: ctx.params["id"] ?? "",
        reason: reason.value,
        ...(name.value === undefined ? {} : { name: name.value }),
        ...(district.value === undefined ? {} : { district: district.value }),
        ...(state.value === undefined ? {} : { state: state.value }),
        ...(geo.value === undefined ? {} : { geo: geo.value }),
        ...(population.value === undefined ? {} : { population: population.value }),
        ...(households.value === undefined ? {} : { households: households.value }),
        ...(affectedFamilies.value === undefined ? {} : { affectedFamilies: affectedFamilies.value }),
      }),
    );
  });

  /**
   * The village's timeline (ADR 0013), oldest first.
   *
   * It reports only what is genuinely persisted today:
   *   - damage assessments, append-only on the Village aggregate;
   *   - recovery index recalculations, from Recovery Intelligence's own history.
   *
   * Deliberately ABSENT: severity transitions, profile corrections, and NGO
   * assignments. Those emit events carrying both sides of the change, but
   * nothing stores them — only the current value survives — so a timeline entry
   * for them would have to be invented, and an invented history is worse than a
   * short one on a platform whose purpose is reconstructing what happened. The
   * full attributed timeline arrives with the audit log (ADR 0011), which
   * persists the event stream; this route grows to read it then.
   */
  router.get("/villages/:id/history", async (ctx: RequestContext): Promise<HttpResponse> => {
    const id = ctx.params["id"] ?? "";

    const profile = await villages.getVillageProfile.execute({ villageId: id });
    if (!profile.ok) return fromResult(profile);

    const items: HistoryItem[] = profile.value.damageAssessments.map(damageAssessmentItem);

    // A village with no recovery index yet is the normal case, not an error:
    // the index only exists once scores have been recorded.
    const scores = await recovery.getScoreHistory.execute({ villageId: id });
    if (scores.ok) {
      for (const entry of scores.value.history) {
        items.push({
          at: entry.calculatedAt,
          kind: "recovery-index",
          summary: `Recovery index recalculated to ${entry.composite}`,
          detail: { composite: entry.composite },
        });
      }
    }

    // Stable sort: entries sharing a timestamp keep the order their own context
    // recorded them in, rather than being shuffled by the merge.
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    return json(200, { villageId: profile.value.id, history: items });
  });
}

function damageAssessmentItem(assessment: DamageAssessment): HistoryItem {
  return {
    at: assessment.assessedAt,
    kind: "damage-assessment",
    summary: `Damage assessment recorded: ${assessment.housesDamaged} houses damaged`,
    detail: assessment,
  };
}
