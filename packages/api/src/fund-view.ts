import { toMajorUnits } from "@afrip/shared-kernel";
import type { FundedProject } from "@afrip/fund-monitoring";

/**
 * Serialisation of the FundedProject aggregate for the HTTP layer.
 *
 * Two shapes, deliberately separate rather than one shape with fields filtered
 * at the call site: `FundProjectView` for authenticated operators, and
 * `PublicFundProject` for the unauthenticated transparency feed. Keeping the
 * public projection as its own type means adding a field to the operator view
 * cannot silently widen what an anonymous caller sees — the public mapper has
 * to be edited on purpose.
 *
 * UNITS. Every money field here is MAJOR units — rupees, `50000` meaning
 * ₹50,000 — and says so in its own name (`sanctionedInr`, not `sanctioned`).
 * The name carries the unit because that is the only part of a JSON number a
 * reader can see; a field called `amount` is exactly the ambiguity the move off
 * `amountMinor` was made to remove. Storage and arithmetic remain integer paise
 * inside `Money` — the division happens here, once, on the way out.
 *
 * There is no "₹" anywhere in these payloads. The symbol is presentation; the
 * payload states its currency in a sibling `currency` string field so a client
 * can format it however its locale wants.
 */

export interface ExpenditureView {
  readonly amountInr: number;
  readonly currency: string;
  readonly description: string;
  readonly evidenceRef: string | null;
  readonly spentAt: string;
}

export interface AnomalyView {
  readonly type: string;
  readonly detectedAt: string;
  readonly details: string;
}

export interface FundProjectView {
  readonly id: string;
  readonly villageId: string;
  readonly name: string;
  readonly category: string;
  readonly fundSource: string;
  readonly currency: string;
  readonly sanctionedInr: number;
  readonly releasedInr: number;
  readonly spentInr: number;
  readonly status: string;
  readonly lastReleasedAt: string | null;
  readonly expenditures: readonly ExpenditureView[];
  readonly anomalies: readonly AnomalyView[];
}

/**
 * One row of the fund-transparency feed. Mirrors the intent of the
 * `assam_floods.public_fund_transparency` view in
 * `supabase/migrations/00002_rls_policies.sql`: project identity, where the
 * money came from, and the sanctioned/released/spent ladder — no vendor, no
 * approver, no contact, and no expenditure descriptions (a free-text field an
 * operator could put anything into, including a person's name).
 */
export interface PublicFundProject {
  readonly id: string;
  readonly villageId: string;
  readonly name: string;
  readonly category: string;
  readonly fundSource: string;
  readonly currency: string;
  readonly sanctionedInr: number;
  readonly releasedInr: number;
  readonly spentInr: number;
  readonly status: string;
}

/** Aggregate money movement across a set of projects, for dashboard headlines. */
export interface FundTotals {
  readonly projectCount: number;
  readonly currency: string;
  readonly sanctionedInr: number;
  readonly releasedInr: number;
  readonly spentInr: number;
  /** Anomalies already flagged on these projects by `DetectAnomalies`. */
  readonly anomalyCount: number;
}

/** Currency reported when there are no projects to read one off. */
export const DEFAULT_FUND_CURRENCY = "INR";

export function toFundProjectView(project: FundedProject): FundProjectView {
  return {
    id: project.id,
    villageId: project.villageId,
    name: project.name,
    category: project.category,
    fundSource: project.fundSource,
    currency: project.sanctioned.currency,
    sanctionedInr: project.sanctioned.amountMajor,
    releasedInr: project.released.amountMajor,
    spentInr: project.spent.amountMajor,
    status: project.status,
    lastReleasedAt: project.lastReleasedAt,
    expenditures: project.expenditures.map((expenditure) => ({
      amountInr: expenditure.amount.amountMajor,
      currency: expenditure.amount.currency,
      description: expenditure.description,
      evidenceRef: expenditure.evidenceRef ?? null,
      spentAt: expenditure.spentAt,
    })),
    anomalies: project.anomalies.map((anomaly) => ({
      type: anomaly.type,
      detectedAt: anomaly.detectedAt,
      details: anomaly.details,
    })),
  };
}

export function toPublicFundProject(project: FundedProject): PublicFundProject {
  return {
    id: project.id,
    villageId: project.villageId,
    name: project.name,
    category: project.category,
    fundSource: project.fundSource,
    currency: project.sanctioned.currency,
    sanctionedInr: project.sanctioned.amountMajor,
    releasedInr: project.released.amountMajor,
    spentInr: project.spent.amountMajor,
    status: project.status,
  };
}

/**
 * Sums the ladder. Mixed currencies are not summable, so the reported currency
 * is that of the first project and callers must not mix them — the platform
 * only mints INR today (see `Money.of`'s default).
 *
 * The accumulation runs in integer paise and converts ONCE at the end. Summing
 * rupee floats instead would let a dashboard headline disagree with the rows it
 * is a total of, by a paisa per project.
 */
export function summariseFunds(projects: readonly FundedProject[]): FundTotals {
  let sanctionedMinor = 0;
  let releasedMinor = 0;
  let spentMinor = 0;
  let anomalyCount = 0;

  for (const project of projects) {
    sanctionedMinor += project.sanctioned.amountMinor;
    releasedMinor += project.released.amountMinor;
    spentMinor += project.spent.amountMinor;
    anomalyCount += project.anomalies.length;
  }

  return {
    projectCount: projects.length,
    currency: projects[0]?.sanctioned.currency ?? DEFAULT_FUND_CURRENCY,
    sanctionedInr: toMajorUnits(sanctionedMinor),
    releasedInr: toMajorUnits(releasedMinor),
    spentInr: toMajorUnits(spentMinor),
    anomalyCount,
  };
}
