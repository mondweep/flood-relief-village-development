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

/**
 * EVERY FIGURE BELOW EXCLUDES DEMONSTRATION VILLAGES, and `demonstrationVillages`
 * is here so that exclusion is visible rather than implied.
 *
 * The decision and its reason: a demonstration record is one that exists to be
 * looked at, not believed, so counting it in a published figure would be
 * publishing a number the platform never measured. The 2026-07-28 incident's
 * closing lesson — "fabrication is worse than deletion and harder to notice" —
 * is exactly about figures like these, where a seeded record is indistinguishable
 * from a measurement once it has been summed.
 *
 * But excluding them silently would be the same failure wearing the other hat.
 * A dashboard that says "1 village" over a database holding four, with nothing
 * saying where the other three went, has quietly deleted them from the reader's
 * view — and an absence is harder to notice than a wrong number. Hence the
 * companion count: the pair reads "1 village, plus 3 demonstration records",
 * which is the whole truth in two integers and cannot be rendered as either lie.
 */
export interface PublicStats {
  /** REAL villages only. Demonstration records are counted separately, below. */
  readonly totalVillages: number;
  /** REAL villages only, so a seeded `critical` cannot colour the severity bars. */
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** REAL villages only. */
  readonly villagesWithActiveNgo: number;
  /**
   * Mean composite across REAL villages that have a recovery index; null when
   * none do. A demonstration village's score is a number somebody made up to
   * make a screen look plausible; averaged in, it becomes a claim about how
   * recovery is actually going.
   */
  readonly averageRecoveryComposite: number | null;
  /**
   * How many villages in the registry are demonstration data.
   *
   * NOT optional and NOT omitted when zero. A field that disappears when there
   * is nothing to report is a field a page will stop rendering, and the day
   * something IS seeded the disclosure will be missing on precisely the page
   * that needed it. Zero here is a measured zero: "we checked, there are none".
   */
  readonly demonstrationVillages: number;
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
        /**
         * How the village's position was obtained (ADR 0012 §1) — and
         * deliberately NOT the position itself.
         *
         * The coordinates stay out of this projection: ADR 0012 §Context 4 notes
         * that they locate flood-affected settlements and, through the
         * beneficiary registry, vulnerable people. The PROVENANCE carries none of
         * that. It says only whether anyone has been to this village with a
         * device, which is a data-quality fact about our records rather than a
         * fact about the place.
         *
         * Published rather than kept internal because ADR 0012 §Consequences says
         * the feature's real payoff "is not nicer data entry but a visible
         * data-quality gap" — and a transparency dashboard that hides how
         * trustworthy its own map is has the wrong idea about transparency.
         */
        positionSource: village.positionSource,
        /**
         * Whether this record is DEMONSTRATION data (see `Village
         * .markAsDemonstration`). Published, and published to the
         * UNAUTHENTICATED projection specifically, because the flag is not
         * sensitive — it is the opposite of sensitive. Its entire purpose is
         * that a reader who has no account, no context and no reason to be
         * suspicious can still tell that this row is an illustration.
         *
         * Demonstration villages are LISTED here, not filtered out. Removing
         * them would trade a labelled illustration for an unexplained absence,
         * and the aggregate figures in `/public/stats` are where the exclusion
         * belongs — a count is a claim, a labelled row is not.
         */
        isDemonstration: village.isDemonstration,
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
    const listedVillages = listed.value;

    // The split every figure below is computed over. Done once, at the top,
    // rather than as a `filter` inside each aggregate: a figure that forgot the
    // filter would be indistinguishable from one that deliberately included the
    // demonstration rows, and this way there is no unfiltered list in scope to
    // reach for by accident.
    const villages = listedVillages.filter((village) => !village.isDemonstration);
    const demonstrationVillages = listedVillages.length - villages.length;

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
      demonstrationVillages,
      funds,
    };

    return json(200, stats);
  });
}
