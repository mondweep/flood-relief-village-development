import { Router } from "../router.js";
import { registerBeneficiaryRoutes } from "./beneficiaries.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerHealthRoutes } from "./health.js";
import { registerIssueRoutes } from "./issues.js";
import { registerNgoRoutes } from "./ngos.js";
import { registerPublicRoutes } from "./public.js";
import { registerRecoveryRoutes } from "./recovery.js";
import { registerVillageRoutes } from "./villages.js";
import type { RouteDeps } from "./deps.js";

export type { RouteDeps } from "./deps.js";

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  registerDashboardRoutes(router, deps);
  registerHealthRoutes(router, deps);
  registerVillageRoutes(router, deps);
  registerNgoRoutes(router, deps);
  registerBeneficiaryRoutes(router, deps);
  registerIssueRoutes(router, deps);
  registerRecoveryRoutes(router, deps);
  registerPublicRoutes(router, deps);
  return router;
}
