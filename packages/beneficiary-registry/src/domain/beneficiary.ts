import { err, ok, type BeneficiaryId, type Result, type VillageId } from "@afrip/shared-kernel";

export type BeneficiaryCategory =
  | "widow"
  | "orphan"
  | "senior_citizen"
  | "disabled"
  | "pregnant_woman"
  | "farmer"
  | "small_business"
  | "daily_wage_worker"
  | "student";

const CATEGORIES: readonly BeneficiaryCategory[] = [
  "widow",
  "orphan",
  "senior_citizen",
  "disabled",
  "pregnant_woman",
  "farmer",
  "small_business",
  "daily_wage_worker",
  "student",
];

export function isBeneficiaryCategory(value: string): value is BeneficiaryCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

export type AidType = "food" | "shelter" | "medical" | "cash" | "livelihood" | "education";

const AID_TYPES: readonly AidType[] = [
  "food",
  "shelter",
  "medical",
  "cash",
  "livelihood",
  "education",
];

export function isAidType(value: string): value is AidType {
  return (AID_TYPES as readonly string[]).includes(value);
}

export type ProviderType = "ngo" | "government" | "donor";

const PROVIDER_TYPES: readonly ProviderType[] = ["ngo", "government", "donor"];

export function isProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

export interface AidRecord {
  readonly aidType: AidType;
  readonly providerId: string;
  readonly providerType: ProviderType;
  readonly deliveredAt: string;
  readonly notes?: string;
}

export interface FollowUp {
  readonly id: string;
  readonly dueAt: string;
  readonly completedAt?: string;
}

export interface DuplicateFlag {
  readonly aidType: AidType;
  readonly providerIds: readonly string[];
  readonly flaggedAt: string;
}

export interface BeneficiaryCreateProps {
  id: BeneficiaryId;
  villageId: VillageId;
  name: string;
  category: BeneficiaryCategory;
}

export const DEFAULT_DUPLICATE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordAidInput {
  aidType: AidType;
  providerId: string;
  providerType: ProviderType;
  deliveredAt: string;
  notes?: string;
  /** Duplicate-detection window in days; defaults to 14. */
  windowDays?: number;
}

export interface RecordAidOutcome {
  record: AidRecord;
  /** Non-null when the same aid type was delivered by a different provider within the window. */
  duplicateFlag: DuplicateFlag | null;
}

function parseInstant(value: string, field: string): Result<number> {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return err(`${field} must be a valid ISO-8601 timestamp`);
  return ok(ms);
}

/** State needed to rebuild a Beneficiary from storage — see Beneficiary.restore. */
export interface BeneficiaryRestoreProps extends BeneficiaryCreateProps {
  aidRecords: readonly AidRecord[];
  followUps: readonly FollowUp[];
  duplicateFlags: readonly DuplicateFlag[];
}

function validateAidRecord(record: AidRecord): string | null {
  if (!isAidType(record.aidType)) return `invalid aidType: ${String(record.aidType)}`;
  if (!isProviderType(record.providerType)) {
    return `invalid providerType: ${String(record.providerType)}`;
  }
  if (record.providerId.trim().length === 0) return "providerId must not be empty";
  const delivered = parseInstant(record.deliveredAt, "deliveredAt");
  return delivered.ok ? null : delivered.error;
}

function validateFollowUp(followUp: FollowUp): string | null {
  if (followUp.id.trim().length === 0) return "follow-up id must not be empty";
  const due = parseInstant(followUp.dueAt, "dueAt");
  if (!due.ok) return due.error;
  if (followUp.completedAt !== undefined) {
    const completed = parseInstant(followUp.completedAt, "completedAt");
    if (!completed.ok) return completed.error;
  }
  return null;
}

function validateDuplicateFlag(flag: DuplicateFlag): string | null {
  if (!isAidType(flag.aidType)) return `invalid aidType: ${String(flag.aidType)}`;
  if (flag.providerIds.length === 0) return "duplicate flag must name at least one providerId";
  if (flag.providerIds.some((id) => id.trim().length === 0)) {
    return "duplicate flag providerIds must not contain empty ids";
  }
  const flagged = parseInstant(flag.flaggedAt, "flaggedAt");
  return flagged.ok ? null : flagged.error;
}

export class Beneficiary {
  readonly id: BeneficiaryId;
  readonly villageId: VillageId;
  name: string;
  category: BeneficiaryCategory;
  private readonly _aidRecords: AidRecord[];
  private readonly _followUps: FollowUp[];
  private readonly _duplicateFlags: DuplicateFlag[];

  private constructor(props: BeneficiaryCreateProps) {
    this.id = props.id;
    this.villageId = props.villageId;
    this.name = props.name;
    this.category = props.category;
    this._aidRecords = [];
    this._followUps = [];
    this._duplicateFlags = [];
  }

  static create(props: BeneficiaryCreateProps): Result<Beneficiary> {
    if (props.name.trim().length === 0) return err("name must not be empty");
    if (!isBeneficiaryCategory(props.category)) {
      return err(`invalid category: ${String(props.category)}`);
    }
    return ok(new Beneficiary(props));
  }

  /**
   * Rebuilds a Beneficiary from persisted state. Intended for repository
   * adapters only — application code creates beneficiaries via create().
   *
   * Replaying recordAid() is NOT a valid substitute: it re-derives duplicate
   * flags from the window heuristic, which would duplicate (or contradict) the
   * flags already stored. restore() therefore takes the stored collections
   * verbatim, but re-runs every invariant create()/recordAid()/scheduleFollowUp()
   * would have enforced so a corrupt row can never become a live aggregate.
   */
  static restore(props: BeneficiaryRestoreProps): Result<Beneficiary> {
    const base = Beneficiary.create(props);
    if (!base.ok) return base;
    const beneficiary = base.value;

    for (const record of props.aidRecords) {
      const error = validateAidRecord(record);
      if (error) return err(error);
      beneficiary._aidRecords.push({ ...record });
    }

    const seenFollowUpIds = new Set<string>();
    for (const followUp of props.followUps) {
      const error = validateFollowUp(followUp);
      if (error) return err(error);
      if (seenFollowUpIds.has(followUp.id)) {
        return err(`duplicate follow-up id: ${followUp.id}`);
      }
      seenFollowUpIds.add(followUp.id);
      beneficiary._followUps.push({ ...followUp });
    }

    for (const flag of props.duplicateFlags) {
      const error = validateDuplicateFlag(flag);
      if (error) return err(error);
      beneficiary._duplicateFlags.push({ ...flag, providerIds: [...flag.providerIds] });
    }

    return ok(beneficiary);
  }

  /** Append-only history of aid deliveries. Returns copies — safe to mutate. */
  get aidRecords(): readonly AidRecord[] {
    return this._aidRecords.map((record) => ({ ...record }));
  }

  /** Copies — mutating the returned array or its elements does not affect the aggregate. */
  get followUps(): readonly FollowUp[] {
    return this._followUps.map((followUp) => ({ ...followUp }));
  }

  /** Copies — mutating the returned array or its elements does not affect the aggregate. */
  get duplicateFlags(): readonly DuplicateFlag[] {
    return this._duplicateFlags.map((flag) => ({ ...flag, providerIds: [...flag.providerIds] }));
  }

  /**
   * Records an aid delivery. Aid is ALWAYS recorded — never silently rejected.
   * If the same aid type was delivered by a different provider within the
   * window (default 14 days, inclusive), a duplicate flag is also appended.
   */
  recordAid(input: RecordAidInput): Result<RecordAidOutcome> {
    if (!isAidType(input.aidType)) return err(`invalid aidType: ${String(input.aidType)}`);
    if (!isProviderType(input.providerType)) {
      return err(`invalid providerType: ${String(input.providerType)}`);
    }
    if (input.providerId.trim().length === 0) return err("providerId must not be empty");
    const windowDays = input.windowDays ?? DEFAULT_DUPLICATE_WINDOW_DAYS;
    if (!Number.isFinite(windowDays) || windowDays < 0) {
      return err("windowDays must be a non-negative number");
    }
    const deliveredMsResult = parseInstant(input.deliveredAt, "deliveredAt");
    if (!deliveredMsResult.ok) return deliveredMsResult;
    const deliveredMs = deliveredMsResult.value;

    const otherProviders: string[] = [];
    for (const prior of this._aidRecords) {
      if (prior.aidType !== input.aidType) continue;
      if (prior.providerId === input.providerId) continue;
      if (otherProviders.includes(prior.providerId)) continue;
      const elapsed = deliveredMs - Date.parse(prior.deliveredAt);
      if (elapsed >= 0 && elapsed <= windowDays * DAY_MS) {
        otherProviders.push(prior.providerId);
      }
    }

    const record: AidRecord = {
      aidType: input.aidType,
      providerId: input.providerId,
      providerType: input.providerType,
      deliveredAt: input.deliveredAt,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
    this._aidRecords.push(record);

    let duplicateFlag: DuplicateFlag | null = null;
    if (otherProviders.length > 0) {
      duplicateFlag = {
        aidType: input.aidType,
        providerIds: [...otherProviders, input.providerId],
        flaggedAt: input.deliveredAt,
      };
      this._duplicateFlags.push(duplicateFlag);
    }

    return ok({
      record: { ...record },
      duplicateFlag: duplicateFlag
        ? { ...duplicateFlag, providerIds: [...duplicateFlag.providerIds] }
        : null,
    });
  }

  scheduleFollowUp(id: string, dueAt: string): Result<FollowUp> {
    if (id.trim().length === 0) return err("follow-up id must not be empty");
    const dueMs = parseInstant(dueAt, "dueAt");
    if (!dueMs.ok) return err(dueMs.error);
    const followUp: FollowUp = { id, dueAt };
    this._followUps.push(followUp);
    return ok({ ...followUp });
  }

  completeFollowUp(followUpId: string, completedAt: string): Result<FollowUp> {
    const index = this._followUps.findIndex((f) => f.id === followUpId);
    if (index === -1) return err(`follow-up not found: ${followUpId}`);
    const followUp = this._followUps[index]!;
    if (followUp.completedAt !== undefined) {
      return err(`follow-up already completed: ${followUpId}`);
    }
    const completedMs = parseInstant(completedAt, "completedAt");
    if (!completedMs.ok) return err(completedMs.error);
    const completed: FollowUp = { ...followUp, completedAt };
    this._followUps[index] = completed;
    return ok({ ...completed });
  }

  /** Follow-ups strictly past due and not yet completed. Returns copies. */
  overdueFollowUps(now: Date): FollowUp[] {
    const nowMs = now.getTime();
    return this._followUps
      .filter((f) => f.completedAt === undefined && Date.parse(f.dueAt) < nowMs)
      .map((f) => ({ ...f }));
  }
}
