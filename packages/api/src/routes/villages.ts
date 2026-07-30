import type { DamageAssessment, GeoCoordinates, Severity } from "@afrip/village-registry";
import { badRequest, fromResult, fromResultWith, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalNumber,
  optionalProvenancedCoordinates,
  optionalString,
  requiredNumber,
  requiredProvenancedCoordinates,
  requiredString,
} from "../validate.js";
import type { AuditEntry } from "../audit.js";
import { AUDIT_READER_ROLES } from "./audit.js";
import type { RouteDeps } from "./deps.js";

/** One entry on a village's timeline (ADR 0013). */
interface HistoryItem {
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: unknown;
  /**
   * Who caused it (ADR 0011). Absent on entries drawn from the aggregate's own
   * rows, which predate the audit log and carry no actor — absent meaning "not
   * recorded", never "nobody".
   */
  readonly actor?: string;
}

export function registerVillageRoutes(router: Router, deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const villages = (ctx: RequestContext) => ctx.platform.villageRegistry;
  const recovery = (ctx: RequestContext) => ctx.platform.recoveryIntelligence;

  router.post("/villages", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const district = requiredString(body.value, "district");
    if (!district.ok) return badRequest(district.error);
    const state = requiredString(body.value, "state");
    if (!state.ok) return badRequest(state.error);
    const geo = requiredProvenancedCoordinates(body.value, "geo");
    if (!geo.ok) return badRequest(geo.error);
    const population = requiredNumber(body.value, "population");
    if (!population.ok) return badRequest(population.error);
    const households = requiredNumber(body.value, "households");
    if (!households.ok) return badRequest(households.error);
    const affectedFamilies = requiredNumber(body.value, "affectedFamilies");
    if (!affectedFamilies.ok) return badRequest(affectedFamilies.error);
    const severity = requiredString(body.value, "severity");
    if (!severity.ok) return badRequest(severity.error);

    // Severity and `geo.source` are both enums the Village aggregate validates;
    // we only assert here that they are strings (ADR 0012 §1).
    return fromResult(
      await villages(ctx).registerVillage.execute({
        name: name.value,
        district: district.value,
        state: state.value,
        geo: geo.value as GeoCoordinates,
        population: population.value,
        households: households.value,
        affectedFamilies: affectedFamilies.value,
        severity: severity.value as Severity,
      }),
      201,
    );
  });

  router.get("/villages", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResultWith(await villages(ctx).listVillagesBySeverity.execute(), (list) => ({ villages: list })),
  );

  router.get("/villages/:id", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await villages(ctx).getVillageProfile.execute({ villageId: ctx.params["id"] ?? "" })),
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
      await villages(ctx).recordDamageAssessment.execute({
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
      await villages(ctx).updateSeverity.execute({
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
    const geo = optionalProvenancedCoordinates(body.value, "geo");
    if (!geo.ok) return badRequest(geo.error);
    const population = optionalNumber(body.value, "population");
    if (!population.ok) return badRequest(population.error);
    const households = optionalNumber(body.value, "households");
    if (!households.ok) return badRequest(households.error);
    const affectedFamilies = optionalNumber(body.value, "affectedFamilies");
    if (!affectedFamilies.ok) return badRequest(affectedFamilies.error);

    return fromResult(
      await villages(ctx).correctVillageProfile.execute({
        villageId: ctx.params["id"] ?? "",
        reason: reason.value,
        ...(name.value === undefined ? {} : { name: name.value }),
        ...(district.value === undefined ? {} : { district: district.value }),
        ...(state.value === undefined ? {} : { state: state.value }),
        ...(geo.value === undefined ? {} : { geo: geo.value as GeoCoordinates }),
        ...(population.value === undefined ? {} : { population: population.value }),
        ...(households.value === undefined ? {} : { households: households.value }),
        ...(affectedFamilies.value === undefined ? {} : { affectedFamilies: affectedFamilies.value }),
      }),
    );
  });

  /**
   * Declares a village to be DEMONSTRATION data — a record that exists so the
   * platform can be shown to someone, and that must never be read as a claim
   * about a real place.
   *
   * A route of its own, and a POST rather than a field on `POST /villages` or a
   * key in `PATCH /villages/:id/profile`. The registration path cannot express
   * this at all (`Village.create` has no such parameter), so a real village
   * cannot arrive flagged by a mistyped body, and the correction path cannot
   * either — a correction says "our record of the world was wrong", while this
   * says "this record is not about the world".
   *
   * NOTE WHAT IS MISSING: there is no DELETE. The flag is permanent by design;
   * see `Village.markAsDemonstration`. Admin-only, per
   * `villageRegistry.markAsDemonstration` in the permission table.
   */
  router.post("/villages/:id/demonstration", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const reason = requiredString(body.value, "reason");
    if (!reason.ok) return badRequest(reason.error);

    return fromResult(
      await villages(ctx).markAsDemonstration.execute({
        villageId: ctx.params["id"] ?? "",
        reason: reason.value,
      }),
    );
  });

  /**
   * The village's timeline (ADR 0013), oldest first.
   *
   * ADR 0013 shipped this with a hole it named: severity transitions, profile
   * corrections and NGO assignments emitted events carrying both sides of the
   * change, but nothing stored them, so the timeline could only show the two
   * things that happened to be persisted as rows. It said "this route grows to
   * read the audit log when ADR 0011 lands". ADR 0011 has landed, and this is
   * that growth.
   *
   * Three sources, merged:
   *   - the AUDIT LOG (ADR 0011) — every event ever raised about this village,
   *     with who caused it. This is now the substantive source;
   *   - damage assessments from the aggregate;
   *   - recovery index recalculations from Recovery Intelligence's history.
   *
   * The last two are kept rather than replaced by audit, and not from caution:
   * they are the record for anything that happened BEFORE the audit log existed.
   * A village registered last week has assessment rows and no audit rows, and
   * dropping them would make its history look emptier than it is — which on this
   * platform is the specific failure being designed against.
   *
   * That does mean an event can appear twice for records created after 00006:
   * once from its own table, once from audit. Deduplicated below on
   * (kind, timestamp) rather than left to the reader, since a timeline showing
   * one assessment twice reads as two assessments.
   *
   * WHO SEES WHAT. Audit payloads may name beneficiaries, and ADR 0011 restricts
   * the audit endpoints to admin and district_officer. This route is reachable
   * by anyone who may read a village, so the audit portion is included ONLY for
   * those two roles. Everyone else gets the timeline as it was before — real,
   * just thinner. Widening it here would route around the restriction rather
   * than the restriction being wrong.
   */
  router.get("/villages/:id/history", async (ctx: RequestContext): Promise<HttpResponse> => {
    const id = ctx.params["id"] ?? "";

    const profile = await villages(ctx).getVillageProfile.execute({ villageId: id });
    if (!profile.ok) return fromResult(profile);

    const items: HistoryItem[] = profile.value.damageAssessments.map(damageAssessmentItem);

    // A village with no recovery index yet is the normal case, not an error:
    // the index only exists once scores have been recorded.
    const scores = await recovery(ctx).getScoreHistory.execute({ villageId: id });
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

    // ADR 0011: the attributed stream, for the roles allowed to read it.
    const auditLog = deps.runtime.auditLog;
    const mayReadAudit = ctx.actor != null && AUDIT_READER_ROLES.includes(ctx.actor.role);
    let auditUnavailable = false;
    if (auditLog !== undefined && mayReadAudit) {
      const page = await auditLog.query({ subjectType: "village", subjectId: id, limit: 200 });
      if (page.ok) {
        for (const entry of page.value.entries) items.push(auditItem(entry));
      } else {
        // Reported, not swallowed. A timeline silently missing its audit half
        // looks like a village where nothing happened, which is the exact wrong
        // answer on a platform built because records vanish.
        auditUnavailable = true;
        console.error(`[api] audit read failed for village ${id}: ${page.error}`);
      }
    }

    // Stable sort: entries sharing a timestamp keep the order their own context
    // recorded them in, rather than being shuffled by the merge.
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    return json(200, {
      villageId: profile.value.id,
      history: dedupe(items),
      // Says which view the reader is getting. Without it, a citizen and a
      // district officer see different histories for the same village with
      // nothing explaining why, and the thinner one looks like data loss.
      attributed: mayReadAudit && auditLog !== undefined && !auditUnavailable,
      ...(auditUnavailable ? { auditUnavailable: true } : {}),
    });
  });
}

/**
 * Drops the duplicate an event produces when it is both a row and an audit
 * entry — a damage assessment recorded after 00006 is in
 * `village_registry_damage_assessments` AND in `audit_log`.
 *
 * Keyed on kind plus timestamp rather than on identity, because the two sources
 * carry no shared id: the aggregate's row has no event id and the audit entry
 * has no assessment id. Two genuinely distinct assessments recorded in the same
 * millisecond would collapse into one — accepted, because they are recorded by a
 * human filling in a form and that collision does not occur in practice, whereas
 * the duplicate does on every single one.
 *
 * The AUDIT entry wins where both exist: it carries the actor, and "who" is the
 * thing ADR 0011 was built to add.
 */
function dedupe(items: readonly HistoryItem[]): HistoryItem[] {
  const byKey = new Map<string, HistoryItem>();
  const order: string[] = [];
  for (const item of items) {
    const key = `${item.kind}@${item.at}`;
    if (!byKey.has(key)) order.push(key);
    const existing = byKey.get(key);
    if (existing === undefined || (existing.actor === undefined && item.actor !== undefined)) {
      byKey.set(key, item);
    }
  }
  return order.map((key) => byKey.get(key) as HistoryItem);
}

/** One audit entry as a timeline item, carrying the actor the other sources lack. */
function auditItem(entry: AuditEntry): HistoryItem {
  return {
    at: entry.occurredAt,
    kind: KIND_BY_EVENT[entry.eventName] ?? entry.eventName,
    summary: summariseEvent(entry),
    detail: entry.payload,
    ...(entry.actorEmail === null && entry.actorRole === null
      ? {}
      : { actor: entry.actorEmail ?? entry.actorRole ?? "unknown" }),
  };
}

/**
 * Timeline `kind`s for the events a village accumulates. Only the ones with a
 * natural existing kind are mapped; anything else falls through to its event
 * name, which is ugly but true — inventing a friendly label for an event nobody
 * anticipated is how a timeline starts describing things that did not happen.
 */
const KIND_BY_EVENT: Readonly<Record<string, string>> = {
  "village.damage-assessed.v1": "damage-assessment",
  "recovery.score-calculated.v1": "recovery-index",
  "village.registered.v1": "registered",
  "village.severity-updated.v1": "severity-change",
  "village.profile-corrected.v1": "correction",
  "village.marked-as-demonstration.v1": "demonstration-marked",
};

/** Plain-language one-liners. Falls back to the event name rather than guessing. */
function summariseEvent(entry: AuditEntry): string {
  const p = entry.payload;
  switch (entry.eventName) {
    case "village.registered.v1":
      return `Village registered as ${String(p["name"] ?? "unnamed")}`;
    case "village.severity-updated.v1":
      // The event carries both sides, which is exactly what ADR 0013 wanted and
      // could not show until the stream was durable.
      return `Severity changed from ${String(p["previous"] ?? "?")} to ${String(p["severity"] ?? "?")}`;
    case "village.profile-corrected.v1": {
      const changed = p["changed"];
      const fields =
        typeof changed === "object" && changed !== null ? Object.keys(changed).join(", ") : "details";
      return `Corrected ${fields} — ${String(p["reason"] ?? "no reason given")}`;
    }
    case "village.marked-as-demonstration.v1":
      // Phrased as what it means rather than as a field change: a reader of this
      // timeline needs to know that everything above and below it is illustrative.
      return `Marked as demonstration data, not a real village — ${String(p["reason"] ?? "no reason given")}`;
    case "village.damage-assessed.v1":
      return `Damage assessment recorded: ${String(p["housesDamaged"] ?? "?")} houses damaged`;
    case "recovery.score-calculated.v1":
      return `Recovery index recalculated to ${String(p["composite"] ?? "?")}`;
    default:
      return entry.eventName;
  }
}

function damageAssessmentItem(assessment: DamageAssessment): HistoryItem {
  return {
    at: assessment.assessedAt,
    kind: "damage-assessment",
    summary: `Damage assessment recorded: ${assessment.housesDamaged} houses damaged`,
    detail: assessment,
  };
}
