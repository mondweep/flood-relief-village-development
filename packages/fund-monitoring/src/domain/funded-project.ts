import { err, Money, ok, toMajorUnits, type ProjectId, type Result, type VillageId } from "@afrip/shared-kernel";

export type ProjectCategory =
  | "bridge"
  | "school"
  | "water_supply"
  | "housing"
  | "road"
  | "health"
  | "other";

const CATEGORIES: readonly ProjectCategory[] = [
  "bridge",
  "school",
  "water_supply",
  "housing",
  "road",
  "health",
  "other",
];

export function isProjectCategory(value: string): value is ProjectCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

export type FundSource = "district" | "csr" | "ngo" | "donor" | "mla" | "mp" | "scheme";

const FUND_SOURCES: readonly FundSource[] = ["district", "csr", "ngo", "donor", "mla", "mp", "scheme"];

export function isFundSource(value: string): value is FundSource {
  return (FUND_SOURCES as readonly string[]).includes(value);
}

export type ProjectStatus = "sanctioned" | "in_progress" | "completed" | "verified";

export interface Expenditure {
  readonly amount: Money;
  readonly description: string;
  readonly evidenceRef?: string;
  readonly spentAt: string;
}

export type AnomalyType = "overspend_vs_comparable" | "stalled" | "duplicate_funding";

export interface Anomaly {
  readonly type: AnomalyType;
  readonly detectedAt: string;
  readonly details: string;
}

export interface AnomalyDetectionInput {
  /** Spent totals (minor units) of completed comparable projects. */
  readonly comparableSpentMinor: readonly number[];
  /** Days without expenditure after the last release before a project counts as stalled. */
  readonly stalledAfterDays: number;
  /** Other active (not completed/verified) projects to check for duplicate funding. */
  readonly otherActiveProjects: readonly { villageId: string; category: string }[];
}

export interface FundedProjectCreateProps {
  id: ProjectId;
  villageId: VillageId;
  name: string;
  category: ProjectCategory;
  fundSource: FundSource;
  sanctioned: Money;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(instant: Date | string): string {
  return instant instanceof Date ? instant.toISOString() : instant;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class FundedProject {
  readonly id: ProjectId;
  readonly villageId: VillageId;
  readonly name: string;
  readonly category: ProjectCategory;
  readonly fundSource: FundSource;
  readonly sanctioned: Money;
  private _released: Money;
  private _spent: Money;
  private _status: ProjectStatus;
  private _lastReleasedAt: string | null;
  private readonly _expenditures: Expenditure[];
  private readonly _anomalies: Anomaly[];

  private constructor(props: FundedProjectCreateProps) {
    this.id = props.id;
    this.villageId = props.villageId;
    this.name = props.name;
    this.category = props.category;
    this.fundSource = props.fundSource;
    this.sanctioned = props.sanctioned;
    this._released = Money.zero(props.sanctioned.currency);
    this._spent = Money.zero(props.sanctioned.currency);
    this._status = "sanctioned";
    this._lastReleasedAt = null;
    this._expenditures = [];
    this._anomalies = [];
  }

  static sanction(props: FundedProjectCreateProps): Result<FundedProject> {
    if (props.name.trim().length === 0) return err("project name must not be empty");
    if (!isProjectCategory(props.category)) return err(`invalid category: ${String(props.category)}`);
    if (!isFundSource(props.fundSource)) return err(`invalid fundSource: ${String(props.fundSource)}`);
    if (props.sanctioned.amountMinor <= 0) return err("sanctioned amount must be positive");
    return ok(new FundedProject(props));
  }

  get released(): Money {
    return this._released;
  }

  get spent(): Money {
    return this._spent;
  }

  get status(): ProjectStatus {
    return this._status;
  }

  get lastReleasedAt(): string | null {
    return this._lastReleasedAt;
  }

  get expenditures(): readonly Expenditure[] {
    return this._expenditures;
  }

  get anomalies(): readonly Anomaly[] {
    return this._anomalies;
  }

  /** Release funds. First release moves the project to 'in_progress'. Invariant: released <= sanctioned. */
  release(amount: Money, releasedAt: Date | string): Result<{ firstRelease: boolean; totalReleased: Money }> {
    if (this._status !== "sanctioned" && this._status !== "in_progress") {
      return err(`cannot release funds on a ${this._status} project`);
    }
    if (amount.amountMinor <= 0) return err("release amount must be positive");

    const newReleased = this._released.add(amount);
    if (!newReleased.ok) return err(newReleased.error);
    if (!newReleased.value.lessThanOrEqual(this.sanctioned)) {
      return err(
        // Major units, because the caller sent major units. Quoting paise back
        // at someone who submitted rupees ("would exceed sanctioned 5000000"
        // for a ₹50,000 budget) reads as a hundredfold error in the platform,
        // and is the one place a rupee-speaking caller was still told a number
        // in a unit they never used.
        `released total ${newReleased.value.amountMajor} would exceed sanctioned ${this.sanctioned.amountMajor}`,
      );
    }

    const firstRelease = this._status === "sanctioned";
    this._released = newReleased.value;
    this._status = "in_progress";
    this._lastReleasedAt = toIso(releasedAt);
    return ok({ firstRelease, totalReleased: this._released });
  }

  /** Append an expenditure. Invariants: only while in_progress; spent <= released. */
  recordExpenditure(
    amount: Money,
    description: string,
    spentAt: Date | string,
    evidenceRef?: string,
  ): Result<Expenditure> {
    if (this._status !== "in_progress") {
      return err(`expenditures are only allowed while in_progress (status: ${this._status})`);
    }
    if (amount.amountMinor <= 0) return err("expenditure amount must be positive");
    if (description.trim().length === 0) return err("expenditure description must not be empty");

    const newSpent = this._spent.add(amount);
    if (!newSpent.ok) return err(newSpent.error);
    if (!newSpent.value.lessThanOrEqual(this._released)) {
      return err(
        `spent total ${newSpent.value.amountMajor} would exceed released ${this._released.amountMajor}`,
      );
    }

    const expenditure: Expenditure = {
      amount,
      description,
      spentAt: toIso(spentAt),
      ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    };
    this._spent = newSpent.value;
    this._expenditures.push(expenditure);
    return ok(expenditure);
  }

  /** Forward-only transition in_progress -> completed. */
  complete(): Result<ProjectStatus> {
    if (this._status !== "in_progress") {
      return err(`only an in_progress project can be completed (status: ${this._status})`);
    }
    this._status = "completed";
    return ok(this._status);
  }

  /** Forward-only transition completed -> verified (village verification). */
  verify(): Result<ProjectStatus> {
    if (this._status !== "completed") {
      return err(`only a completed project can be verified (status: ${this._status})`);
    }
    this._status = "verified";
    return ok(this._status);
  }

  /**
   * True when an equivalent anomaly is already recorded: same type, and for
   * duplicate_funding also the same details (i.e. the same village/category pair).
   */
  private hasRecordedAnomaly(finding: Anomaly): boolean {
    return this._anomalies.some(
      (existing) =>
        existing.type === finding.type &&
        (finding.type !== "duplicate_funding" || existing.details === finding.details),
    );
  }

  /**
   * Pure anomaly rules; appends only findings not already recorded to the
   * aggregate and returns just those newly added findings (idempotent on
   * repeat runs over unchanged state).
   */
  detectAnomalies(input: AnomalyDetectionInput, now: Date): Anomaly[] {
    const detectedAt = now.toISOString();
    const findings: Anomaly[] = [];

    // Rule: overspend_vs_comparable — skip with fewer than 3 comparables.
    if (input.comparableSpentMinor.length >= 3) {
      const med = median(input.comparableSpentMinor);
      const threshold = 1.5 * med;
      if (this._spent.amountMinor > threshold) {
        findings.push({
          type: "overspend_vs_comparable",
          detectedAt,
          details:
            `spent ${toMajorUnits(this._spent.amountMinor)} exceeds 1.5x median ` +
            `(${toMajorUnits(threshold)}) of ${input.comparableSpentMinor.length} comparable projects`,
        });
      }
    }

    // Rule: stalled — in_progress with no expenditure within stalledAfterDays of the last release.
    if (this._status === "in_progress" && this._lastReleasedAt !== null) {
      const lastReleasedMs = Date.parse(this._lastReleasedAt);
      const windowMs = input.stalledAfterDays * DAY_MS;
      const windowElapsed = now.getTime() - lastReleasedMs > windowMs;
      const activityInWindow = this._expenditures.some((e) => {
        const spentMs = Date.parse(e.spentAt);
        return spentMs >= lastReleasedMs && spentMs - lastReleasedMs <= windowMs;
      });
      if (windowElapsed && !activityInWindow) {
        findings.push({
          type: "stalled",
          detectedAt,
          details: `no expenditure recorded within ${input.stalledAfterDays} days of last release at ${this._lastReleasedAt}`,
        });
      }
    }

    // Rule: duplicate_funding — another active project with the same villageId + category.
    const duplicate = input.otherActiveProjects.find(
      (p) => p.villageId === this.villageId && p.category === this.category,
    );
    if (duplicate) {
      findings.push({
        type: "duplicate_funding",
        detectedAt,
        details: `another active ${this.category} project exists in village ${this.villageId}`,
      });
    }

    const newFindings = findings.filter((finding) => !this.hasRecordedAnomaly(finding));
    this._anomalies.push(...newFindings);
    return newFindings;
  }
}
