import type { Severity } from "@afrip/village-registry";
import { summariseFunds, toPublicFundProject, type FundTotals } from "../fund-view.js";
import { json, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
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

export function registerPublicRoutes(router: Router, deps: RouteDeps): void {
  const { villageRegistry, ngoCoordination, recoveryIntelligence, fundMonitoring } =
    deps.runtime.platform;

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
  router.get("/public/funds", async (): Promise<HttpResponse> => {
    const projects = await fundMonitoring.projectRepository.listAll();
    return json(200, { projects: projects.map(toPublicFundProject) });
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

    // Unlike the recovery average, zero is the honest answer for money: no
    // sanctioned project means no rupee has moved, which is a fact, not a gap.
    const funds = summariseFunds(await fundMonitoring.projectRepository.listAll());

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
