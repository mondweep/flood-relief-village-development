import { Router } from "../router.js";
import { registerAuditRoutes } from "./audit.js";
import { registerBeneficiaryRoutes } from "./beneficiaries.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { registerFundRoutes } from "./funds.js";
import { registerGeocodeRoutes } from "./geocode.js";
import { registerHealthRoutes } from "./health.js";
import { registerIssueRoutes } from "./issues.js";
import { registerMapRoutes } from "./map.js";
import { registerMeRoutes } from "./me.js";
import { registerNgoRoutes } from "./ngos.js";
import { registerPlanningRoutes } from "./planning.js";
import { registerPublicRoutes } from "./public.js";
import { registerRecoveryRoutes } from "./recovery.js";
import { registerSignalRoutes } from "./signals.js";
import { registerVillageRoutes } from "./villages.js";
import { registerVolunteerRoutes } from "./volunteers.js";
import type { RouteDeps } from "./deps.js";

export type { RouteDeps } from "./deps.js";

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  registerDashboardRoutes(router, deps);
  registerHealthRoutes(router, deps);
  registerMeRoutes(router, deps);
  registerVillageRoutes(router, deps);
  registerNgoRoutes(router, deps);
  registerBeneficiaryRoutes(router, deps);
  registerIssueRoutes(router, deps);
  registerRecoveryRoutes(router, deps);
  registerFundRoutes(router, deps);
  registerVolunteerRoutes(router, deps);
  registerPlanningRoutes(router, deps);
  registerSignalRoutes(router, deps);
  registerAuditRoutes(router, deps);
  registerFeedbackRoutes(router, deps);
  registerGeocodeRoutes(router, deps);
  registerMapRoutes(router, deps, deps.fetchTile === undefined ? {} : { fetchTile: deps.fetchTile });
  registerPublicRoutes(router, deps);
  return router;
}
