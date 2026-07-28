import type { Dimension } from "@afrip/recovery-intelligence";
import { badRequest, fromResult, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalNumberRecord, requiredNumberRecord } from "../validate.js";
import type { RouteDeps } from "./deps.js";

export function registerRecoveryRoutes(router: Router, deps: RouteDeps): void {
  const recovery = deps.runtime.platform.recoveryIntelligence;

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
}
