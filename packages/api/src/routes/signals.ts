import { signalId, type SignalId } from "@afrip/shared-kernel";
import type { RegistryFacts, Signal, SmartAlert, Source } from "@afrip/social-media-intelligence";
import { badRequest, fromResult, json, notFound, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalStringArray,
  requiredObject,
  requiredString,
} from "../validate.js";
import type { RouteDeps } from "./deps.js";

export interface SignalView {
  readonly id: string;
  readonly source: string;
  readonly rawText: string;
  readonly detectedAt: string;
  readonly extracted: {
    readonly villageName: string | null;
    readonly ngoName: string | null;
    readonly activityType: string | null;
    readonly needs: readonly string[];
  };
}

export interface AlertView {
  readonly id: string;
  readonly type: string;
  readonly signalId: string;
  readonly villageName: string | null;
  readonly details: string;
  readonly raisedAt: string;
}

function toSignalView(signal: Signal): SignalView {
  return {
    id: signal.id,
    source: signal.source,
    rawText: signal.rawText,
    detectedAt: signal.detectedAt,
    extracted: {
      villageName: signal.extracted.villageName ?? null,
      ngoName: signal.extracted.ngoName ?? null,
      activityType: signal.extracted.activityType ?? null,
      needs: [...signal.extracted.needs],
    },
  };
}

function toAlertView(alert: SmartAlert): AlertView {
  return {
    id: alert.id,
    type: alert.type,
    signalId: alert.signalId,
    villageName: alert.villageName ?? null,
    details: alert.details,
    raisedAt: alert.raisedAt,
  };
}

export function registerSignalRoutes(router: Router, deps: RouteDeps): void {
  const signals = deps.runtime.platform.socialMediaIntelligence;
  const { villageRegistry, ngoCoordination } = deps.runtime.platform;

  /**
   * Ingests a raw field report or social post. The `SignalExtractor` behind the
   * anti-corruption layer does the extraction — by default the deterministic
   * keyword adapter, so this route needs no model credentials to work.
   */
  router.post("/signals", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const rawText = requiredString(body.value, "rawText");
    if (!rawText.ok) return badRequest(rawText.error);
    const source = requiredString(body.value, "source");
    if (!source.ok) return badRequest(source.error);

    // `source` is an enum the use case validates; the cast only satisfies the signature.
    return fromResult(
      await signals.ingestRawReport.execute({
        rawText: rawText.value,
        source: source.value as Source,
      }),
      201,
    );
  });

  /**
   * Runs the alert rules over an ingested signal. 200, not 201: the caller asks
   * for an evaluation and may legitimately get back zero alerts, so this is not
   * a creation whose success is a new resource.
   *
   * `registryFacts` may be supplied explicitly. Omitted, they are assembled from
   * the wired Village Registry and NGO Coordination contexts by matching the
   * signal's extracted village name against registered villages. `recentAidTypes`
   * defaults to empty and is NOT inferred: no wired query answers "what aid did
   * this village recently receive", and guessing it would fire (or suppress) the
   * duplicate-aid rule on invented evidence.
   */
  router.post("/signals/:id/evaluate", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body ?? {});
    if (!body.ok) return badRequest(body.error);

    const id = signalId(ctx.params["id"] ?? "");
    if (!id.ok) return badRequest(id.error);

    let facts: RegistryFacts;
    if (body.value["registryFacts"] === undefined || body.value["registryFacts"] === null) {
      facts = await deriveRegistryFacts(id.value);
    } else {
      const supplied = requiredObject(body.value, "registryFacts");
      if (!supplied.ok) return badRequest(supplied.error);
      const villageKnown = supplied.value["villageKnown"];
      const hasActiveNgo = supplied.value["hasActiveNgo"];
      if (typeof villageKnown !== "boolean") {
        return badRequest("registryFacts.villageKnown must be a boolean");
      }
      if (typeof hasActiveNgo !== "boolean") {
        return badRequest("registryFacts.hasActiveNgo must be a boolean");
      }
      const recentAidTypes = optionalStringArray(supplied.value, "recentAidTypes");
      if (!recentAidTypes.ok) return badRequest(`registryFacts.${recentAidTypes.error}`);
      facts = { villageKnown, hasActiveNgo, recentAidTypes: recentAidTypes.value };
    }

    return fromResult(
      await signals.evaluateAlerts.execute({ signalId: id.value, registryFacts: facts }),
    );
  });

  router.get("/signals", async (): Promise<HttpResponse> => {
    const all = await signals.signalRepository.listAll();
    return json(200, { signals: all.map(toSignalView) });
  });

  router.get("/alerts", async (): Promise<HttpResponse> => {
    const all = await signals.alertRepository.listAll();
    return json(200, { alerts: all.map(toAlertView) });
  });

  /** Facts about the signal's village, read from the two contexts that own them. */
  async function deriveRegistryFacts(id: SignalId): Promise<RegistryFacts> {
    const empty: RegistryFacts = { villageKnown: false, hasActiveNgo: false, recentAidTypes: [] };

    const signal = await signals.signalRepository.findById(id);
    const villageName = signal?.extracted.villageName;
    if (villageName === undefined) return empty;

    const listed = await villageRegistry.listVillagesBySeverity.execute();
    if (!listed.ok) return empty;

    const match = listed.value.find(
      (village) => village.name.trim().toLowerCase() === villageName.trim().toLowerCase(),
    );
    if (match === undefined) return empty;

    // NGO Coordination reports the UNassigned subset of the villages it is given,
    // so "has an active NGO" is this village being absent from that answer.
    const unassigned = await ngoCoordination.listUnassignedVillages.execute([
      { villageId: match.id, severity: match.severity },
    ]);
    const hasActiveNgo = unassigned.ok && unassigned.value.length === 0;

    return { villageKnown: true, hasActiveNgo, recentAidTypes: [] };
  }

  /** Answers 404 for a signal id that matches no ingested signal. */
  router.get("/signals/:id", async (ctx: RequestContext): Promise<HttpResponse> => {
    const id = signalId(ctx.params["id"] ?? "");
    if (!id.ok) return badRequest(id.error);

    const signal = await signals.signalRepository.findById(id.value);
    if (signal === null) return notFound(`signal not found: ${id.value}`);
    return json(200, toSignalView(signal));
  });
}
