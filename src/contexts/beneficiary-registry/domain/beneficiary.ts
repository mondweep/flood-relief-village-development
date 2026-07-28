import { type BeneficiaryId, type Result, type VillageId, err, ok } from '../../../shared/index.js';
import type { AidEvent } from './aid-event.js';
import { isSuspectedDuplicate } from './aid-event.js';
import { DEFAULT_FOLLOW_UP_INTERVAL_DAYS, isOverdue, scheduleNextFollowUp } from './follow-up.js';
import type { VulnerabilityCategory } from './vulnerability-category.js';

export const DEFAULT_SUSPICION_WINDOW_DAYS = 7;

interface BeneficiaryProps {
  readonly id: BeneficiaryId;
  readonly villageId: VillageId;
  readonly categories: readonly VulnerabilityCategory[];
  readonly aidHistory: readonly AidEvent[];
  readonly nextFollowUpAt: Date | undefined;
  readonly registeredAt: Date;
}

/** Result of appending an aid event: the new aggregate state plus an optional duplicate reference. */
export interface RecordAidResult {
  readonly beneficiary: Beneficiary;
  readonly duplicateOf: AidEvent | undefined;
}

/**
 * Aggregate root: Beneficiary (PRD §5 BC-3).
 * Immutable — every mutating method returns a new instance, leaving the receiver untouched.
 */
export class Beneficiary {
  private constructor(private readonly props: BeneficiaryProps) {}

  static register(input: {
    id: BeneficiaryId;
    villageId: VillageId;
    categories: readonly VulnerabilityCategory[];
    registeredAt: Date;
  }): Result<Beneficiary> {
    // FR-BR-1: registration requires >=1 vulnerability category and a villageId.
    if (input.categories.length === 0) {
      return err('BENEFICIARY_NO_CATEGORY', 'at least one vulnerability category is required');
    }

    return ok(
      new Beneficiary({
        id: input.id,
        villageId: input.villageId,
        categories: [...input.categories],
        aidHistory: [],
        nextFollowUpAt: scheduleNextFollowUp(input.categories, input.registeredAt),
        registeredAt: input.registeredAt,
      }),
    );
  }

  get id(): BeneficiaryId {
    return this.props.id;
  }

  get villageId(): VillageId {
    return this.props.villageId;
  }

  get categories(): readonly VulnerabilityCategory[] {
    return this.props.categories;
  }

  get aidHistory(): readonly AidEvent[] {
    return this.props.aidHistory;
  }

  get nextFollowUpAt(): Date | undefined {
    return this.props.nextFollowUpAt;
  }

  get registeredAt(): Date {
    return this.props.registeredAt;
  }

  /**
   * FR-BR-2: append-only aid history.
   * FR-BR-3: same-kind aid within the suspicion window keeps the record but flags a duplicate.
   */
  recordAid(aid: AidEvent, suspicionWindowDays: number = DEFAULT_SUSPICION_WINDOW_DAYS): RecordAidResult {
    const duplicateOf = this.props.aidHistory.find((existing) =>
      isSuspectedDuplicate(aid, existing, suspicionWindowDays),
    );

    return {
      beneficiary: new Beneficiary({ ...this.props, aidHistory: [...this.props.aidHistory, aid] }),
      duplicateOf,
    };
  }

  /** FR-BR-4: completing a follow-up reschedules the next one for mandatory categories. */
  completeFollowUp(
    completedAt: Date,
    intervalDays: number = DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
  ): Beneficiary {
    return new Beneficiary({
      ...this.props,
      nextFollowUpAt: scheduleNextFollowUp(this.props.categories, completedAt, intervalDays),
    });
  }

  /** FR-BR-4: whether this beneficiary's next follow-up date has passed, per the given clock time. */
  isFollowUpOverdue(now: Date): boolean {
    return isOverdue(this.props.nextFollowUpAt, now);
  }
}
