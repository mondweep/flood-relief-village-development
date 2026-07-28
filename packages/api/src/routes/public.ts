import { json, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Public transparency projection — unauthenticated by design.
 *
 * Composed from two queries whose outputs are already free of personal data:
 * the village summary (location, severity, aggregate household counts) and the
 * village's composite recovery score. Beneficiary rows, committee contacts and
 * follow-up worklists are deliberately absent and must never be added here.
 */
export function registerPublicRoutes(router: Router, deps: RouteDeps): void {
  const { villageRegistry, recoveryIntelligence } = deps.runtime.platform;

  router.get("/public/villages", async (): Promise<HttpResponse> => {
    const listed = await villageRegistry.listVillagesBySeverity.execute();
    if (!listed.ok) return json(400, { error: listed.error });

    const villages = [];
    for (const village of listed.value) {
      const index = await recoveryIntelligence.getRecoveryIndex.execute({ villageId: village.id });
      villages.push({
        id: village.id,
        name: village.name,
        district: village.district,
        state: village.state,
        severity: village.severity,
        households: village.households,
        affectedFamilies: village.affectedFamilies,
        // Villages with no assessment yet simply have no index — not an error.
        recovery: index.ok
          ? { composite: index.value.composite, calculatedAt: index.value.calculatedAt }
          : null,
      });
    }

    return json(200, { villages });
  });
}
