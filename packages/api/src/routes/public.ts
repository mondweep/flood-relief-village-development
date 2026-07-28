import type { Severity } from "@afrip/village-registry";
import { json, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

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

/**
 * One row of the fund-transparency feed. Mirrors the intent of the
 * `assam_floods.public_fund_transparency` view in
 * `supabase/migrations/00002_rls_policies.sql`: project identity, where the
 * money came from, and the sanctioned/released/spent ladder — no vendor,
 * no approver, no contact.
 */
export interface PublicFundProject {
  readonly id: string;
  readonly villageId: string;
  readonly name: string;
  readonly category: string;
  readonly fundSource: string;
  readonly currency: string;
  readonly sanctionedMinor: number;
  readonly releasedMinor: number;
  readonly spentMinor: number;
  readonly status: string;
}

export interface PublicStats {
  readonly totalVillages: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly villagesWithActiveNgo: number;
  /** Mean composite across villages that have a recovery index; null when none do. */
  readonly averageRecoveryComposite: number | null;
}

export function registerPublicRoutes(router: Router, deps: RouteDeps): void {
  const { villageRegistry, ngoCoordination, recoveryIntelligence } = deps.runtime.platform;

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

  /**
   * Fund transparency.
   *
   * STRUCTURALLY EMPTY, DELIBERATELY. The Fund Monitoring context
   * (`@afrip/fund-monitoring`) exists and is fully tested, but the composition
   * root in `packages/platform/src/composition-root.ts` does not wire it: the
   * `Platform` it returns has no fund-monitoring member, so this route has no
   * source of projects to read from. Rather than invent plausible-looking money
   * — the single most damaging thing a *transparency* endpoint could do — it
   * answers with the honest one: nothing has been published yet.
   *
   * The response shape is already the contract the dashboard codes against, so
   * wiring the context later fills this in with no client-visible change: add
   * fund monitoring to the platform, then map its projects onto
   * `PublicFundProject` here.
   */
  router.get("/public/funds", async (): Promise<HttpResponse> => {
    const projects: PublicFundProject[] = [];
    return json(200, { projects });
  });

  /**
   * Dashboard summary. Every figure is derived from a wired context through its
   * own query use case — the route never reaches past an application boundary
   * into a repository.
   */
  router.get("/public/stats", async (): Promise<HttpResponse> => {
    const listed = await villageRegistry.listVillagesBySeverity.execute();
    if (!listed.ok) return json(400, { error: listed.error });
    const villages = listed.value;

    // Seeded with every severity so the dashboard can render four bars without
    // guessing which keys are present.
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const village of villages) bySeverity[village.severity] += 1;

    // NGO Coordination owns assignment state but takes the village list as
    // input (it never calls Village Registry itself), so "assigned" is the
    // complement of what it reports as unassigned.
    const unassigned = await ngoCoordination.listUnassignedVillages.execute(
      villages.map((village) => ({ villageId: village.id, severity: village.severity })),
    );
    const villagesWithActiveNgo = unassigned.ok ? villages.length - unassigned.value.length : 0;

    let scored = 0;
    let compositeTotal = 0;
    for (const village of villages) {
      const index = await recoveryIntelligence.getRecoveryIndex.execute({ villageId: village.id });
      if (!index.ok) continue;
      scored += 1;
      compositeTotal += index.value.composite;
    }

    const stats: PublicStats = {
      totalVillages: villages.length,
      bySeverity,
      villagesWithActiveNgo,
      // No village scored yet is not "0% recovered", it is "unknown". A zero
      // here would be a lie the dashboard would faithfully render as a red bar.
      averageRecoveryComposite: scored === 0 ? null : compositeTotal / scored,
    };

    return json(200, stats);
  });
}
