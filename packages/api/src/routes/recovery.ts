import type { Dimension, VillageSituation } from "@afrip/recovery-intelligence";
import { badRequest, fromResult, fromResultWith, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalNumberRecord, requiredNumberRecord } from "../validate.js";
import type { RouteDeps } from "./deps.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerRecoveryRoutes(router: Router, deps: RouteDeps): void {
  const recovery = deps.runtime.platform.recoveryIntelligence;
  const { villageRegistry, ngoCoordination } = deps.runtime.platform;

  router.get("/villages/:id/recovery-index", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await recovery.getRecoveryIndex.execute({ villageId: ctx.params["id"] ?? "" })),
  );

  /**
   * Upsert: dimensions omitted from `scores` keep their current value, which is
   * why this is a PUT of the village's scores rather than of a full document.
   * Unknown dimension names and out-of-range values are rejected by the aggregate.
   */
  router.put("/villages/:id/recovery-scores", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const scores = requiredNumberRecord(body.value, "scores");
    if (!scores.ok) return badRequest(scores.error);
    const weights = optionalNumberRecord(body.value, "weights");
    if (!weights.ok) return badRequest(weights.error);

    return fromResult(
      await recovery.upsertDimensionScores.execute({
        villageId: ctx.params["id"] ?? "",
        scores: scores.value as Partial<Record<Dimension, number>>,
        ...(weights.value === undefined
          ? {}
          : { weights: weights.value as Record<Dimension, number> }),
      }),
    );
  });

  /**
   * Prioritised action list across every village, from the `RecommendActions`
   * policy. The use case is pure — it takes situations and sorts them — so this
   * route's real job is assembling those situations out of the wired contexts:
   * severity from Village Registry, composite from Recovery Intelligence,
   * NGO cover from NGO Coordination, and days-since-aid from the API's own
   * beneficiary directory projection.
   *
   * Villages with no recovery index are EXCLUDED and listed separately rather
   * than passed in with a stand-in composite. The policy quotes the composite
   * verbatim in the reason it emits ("composite 0 … needs urgent help"), so a
   * placeholder would not merely skew the ranking, it would put a number the
   * platform never measured into the sentence a district officer acts on.
   */
  router.get("/recommendations", async (): Promise<HttpResponse> => {
    const listed = await villageRegistry.listVillagesBySeverity.execute();
    if (!listed.ok) return badRequest(listed.error);
    const villages = listed.value;

    // One call for the whole list: the port takes the villages and answers with
    // the unassigned subset, so assignment cover is the complement of that set.
    const unassigned = await ngoCoordination.listUnassignedVillages.execute(
      villages.map((village) => ({ villageId: village.id, severity: village.severity })),
    );
    const withoutNgo = new Set(unassigned.ok ? unassigned.value.map((entry) => entry.villageId) : []);

    const now = Date.now();
    const situations: VillageSituation[] = [];
    const villagesWithoutRecoveryIndex: string[] = [];

    for (const village of villages) {
      const index = await recovery.getRecoveryIndex.execute({ villageId: village.id });
      if (!index.ok) {
        villagesWithoutRecoveryIndex.push(village.id);
        continue;
      }
      situations.push({
        villageId: village.id,
        composite: index.value.composite,
        severity: village.severity,
        hasActiveNgo: !withoutNgo.has(village.id),
        daysSinceLastAid: daysSinceLastAid(village.id, now),
      });
    }

    return fromResultWith(
      await recovery.recommendActions.execute({ situations }),
      (recommendations) => ({
        recommendations,
        // The dashboard needs to distinguish "nothing to do here" from "we know
        // too little about this village to say", so the gap is reported, not hidden.
        villagesWithoutRecoveryIndex,
      }),
    );
  });

  /**
   * Whole days since the most recent aid delivery anywhere in the village, or
   * null when none was ever recorded — which the policy reads as "unknown" and
   * skips, rather than as "never aided" (an infinite, always-triggering gap).
   */
  function daysSinceLastAid(id: string, now: number): number | null {
    const timestamps = deps.runtime.beneficiaryDirectory
      .listByVillage(id)
      .map((entry) => (entry.lastAidAt === null ? Number.NaN : Date.parse(entry.lastAidAt)))
      .filter((value) => Number.isFinite(value));

    if (timestamps.length === 0) return null;
    return Math.floor((now - Math.max(...timestamps)) / DAY_MS);
  }
}
