import type { Severity } from "@afrip/village-registry";
import { jwtAuthEnabled, legacyTokenEnabled } from "../auth.js";
import { summariseFunds, toPublicFundProject, type FundTotals } from "../fund-view.js";
import { json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

export type { PublicFundProject } from "../fund-view.js";

/**
 * Public transparency projection — unauthenticated by design.
 *
 * Every field served here is drawn from queries whose outputs are already free
 * of personal data: village summaries (location, severity, aggregate household
 * counts), composite recovery scores, and project-level fund totals. Beneficiary
 * rows, committee contacts, reporter identities and follow-up worklists are
 * deliberately absent and must never be added — see the PII assertion in
 * `test/public-endpoints.test.ts`, which fails the build if a name-, phone- or
 * address-shaped key ever appears in one of these payloads.
 */

/** The four severities, in the order the dashboard reads them. */
const SEVERITIES: readonly Severity[] = ["critical", "severe", "moderate", "minor"];

export interface PublicStats {
  readonly totalVillages: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly villagesWithActiveNgo: number;
  /** Mean composite across villages that have a recovery index; null when none do. */
  readonly averageRecoveryComposite: number | null;
  /** Money movement across every sanctioned project, plus flagged anomalies. */
  readonly funds: FundTotals;
}

/**
 * What the sign-in page needs before it holds any credential (ADR 0008). The
 * browser talks to GoTrue directly — no SDK — so it must be told where GoTrue
 * is and which publishable key to present.
 */
export interface PublicAuthConfig {
  /** Project base URL, or null when sign-in is not configured in this revision. */
  readonly supabaseUrl: string | null;
  /** Publishable (anon) key. NEVER the service-role key. */
  readonly supabasePublishableKey: string | null;
  /** OAuth providers to offer. A list, so adding one is configuration (ADR 0008). */
  readonly authProviders: readonly string[];
  readonly googleEnabled: boolean;
  /**
   * True when this API verifies Supabase JWTs at all.
   *
   * LOAD-BEARING, not informational: the page gates its entire sign-in surface
   * on it. `supabaseUrl` being present is not sufficient — SUPABASE_URL is also
   * what PERSISTENCE=supabase needs, so a deployment can have a working project
   * and still not be verifying its tokens (`AUTH_JWT=off`). Offering sign-in in
   * that state produces an authentication that succeeds and is then refused on
   * the next request. Do not remove this field or fold it into `supabaseUrl`.
   */
  readonly jwtEnabled: boolean;
  /** True while the transitional shared token is still accepted. */
  readonly legacyTokenEnabled: boolean;
}

export function registerPublicRoutes(router: Router, deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const villageRegistry = (ctx: RequestContext) => ctx.platform.villageRegistry;
  const ngoCoordination = (ctx: RequestContext) => ctx.platform.ngoCoordination;
  const recoveryIntelligence = (ctx: RequestContext) => ctx.platform.recoveryIntelligence;
  const fundMonitoring = (ctx: RequestContext) => ctx.platform.fundMonitoring;

  /**
   * Sign-in bootstrap. Unauthenticated of necessity: it is what a page reads in
   * order to *become* authenticated, so gating it would be circular.
   *
   * Answers 200 with nulls rather than 404 when auth is unconfigured. The two
   * failures are different and the page renders them differently: "sign-in is
   * not available in this deployment" is an operator's misconfiguration, while
   * a missing endpoint would send a frontend developer hunting for a routing bug.
   *
   * Only publishable values appear here. The service-role key is never read by
   * this module and must never be added to it — that key bypasses RLS.
   */
  router.get("/public/config", async (): Promise<HttpResponse> => {
    const providers = deps.config.authProviders;
    const body: PublicAuthConfig = {
      supabaseUrl: deps.config.supabaseUrl,
      supabasePublishableKey: deps.config.supabasePublishableKey,
      authProviders: providers,
      googleEnabled: providers.includes("google"),
      // Off the gate for the same reason /health is: the page gates its sign-in
      // surface on `jwtEnabled`, so it must describe the gate that will actually
      // judge the token, not the configuration that was meant to build one.
      jwtEnabled: deps.auth?.jwtEnabled ?? jwtAuthEnabled(deps.config),
      legacyTokenEnabled: deps.auth?.legacyTokenEnabled ?? legacyTokenEnabled(deps.config),
    };
    return json(200, body);
  });

  router.get("/public/villages", async (ctx: RequestContext): Promise<HttpResponse> => {
    const listed = await villageRegistry(ctx).listVillagesBySeverity.execute();
    if (!listed.ok) return json(400, { error: listed.error });

    const villages = [];
    for (const village of listed.value) {
      const index = await recoveryIntelligence(ctx).getRecoveryIndex.execute({ villageId: village.id });
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

  /**
   * Fund transparency — real project data, now that Fund Monitoring is wired
   * into the composition root.
   *
   * Every project appears the moment it is sanctioned: publishing only
   * completed ones would let a stalled project stay invisible for exactly as
   * long as it was going wrong. What is withheld is the detail below the
   * ladder — expenditure descriptions, evidence references and anomaly notes
   * are free text an operator could put a person's name into, so
   * `toPublicFundProject` drops them and only the authenticated `GET /projects`
   * carries them.
   */
  router.get("/public/funds", async (ctx: RequestContext): Promise<HttpResponse> => {
    const projects = await fundMonitoring(ctx).projectRepository.listAll();
    return json(200, { projects: projects.map(toPublicFundProject) });
  });

  /**
   * Dashboard summary. Every figure is derived from a wired context through its
   * own query use case — the route never reaches past an application boundary
   * into a repository.
   */
  router.get("/public/stats", async (ctx: RequestContext): Promise<HttpResponse> => {
    const listed = await villageRegistry(ctx).listVillagesBySeverity.execute();
    if (!listed.ok) return json(400, { error: listed.error });
    const villages = listed.value;

    // Seeded with every severity so the dashboard can render four bars without
    // guessing which keys are present.
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const village of villages) bySeverity[village.severity] += 1;

    // NGO Coordination owns assignment state but takes the village list as
    // input (it never calls Village Registry itself), so "assigned" is the
    // complement of what it reports as unassigned.
    const unassigned = await ngoCoordination(ctx).listUnassignedVillages.execute(
      villages.map((village) => ({ villageId: village.id, severity: village.severity })),
    );
    const villagesWithActiveNgo = unassigned.ok ? villages.length - unassigned.value.length : 0;

    let scored = 0;
    let compositeTotal = 0;
    for (const village of villages) {
      const index = await recoveryIntelligence(ctx).getRecoveryIndex.execute({ villageId: village.id });
      if (!index.ok) continue;
      scored += 1;
      compositeTotal += index.value.composite;
    }

    // Unlike the recovery average, zero is the honest answer for money: no
    // sanctioned project means no rupee has moved, which is a fact, not a gap.
    const funds = summariseFunds(await fundMonitoring(ctx).projectRepository.listAll());

    const stats: PublicStats = {
      totalVillages: villages.length,
      bySeverity,
      villagesWithActiveNgo,
      // No village scored yet is not "0% recovered", it is "unknown". A zero
      // here would be a lie the dashboard would faithfully render as a red bar.
      averageRecoveryComposite: scored === 0 ? null : compositeTotal / scored,
      funds,
    };

    return json(200, stats);
  });
}
