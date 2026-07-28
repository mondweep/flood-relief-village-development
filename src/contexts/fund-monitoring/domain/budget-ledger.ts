/**
 * BudgetLedger (PRD §5 BC-4, FR-FM-2): sanctioned >= released >= spent.
 * Pure value object — append-only entries, every mutation returns a new ledger.
 */
import { type Money, type Result, addMoney, err, gte, ok } from '../../../shared/index.js';

export interface ReleaseEntry {
  readonly amount: Money;
  readonly at: Date;
}

export interface ExpenditureEntry {
  readonly amount: Money;
  readonly at: Date;
  readonly description: string;
}

export interface BudgetLedger {
  readonly sanctioned: Money;
  readonly releases: readonly ReleaseEntry[];
  readonly expenditures: readonly ExpenditureEntry[];
}

export function createBudgetLedger(sanctioned: Money): Result<BudgetLedger> {
  if (sanctioned.amountMinor <= 0) {
    return err('SANCTIONED_NOT_POSITIVE', 'sanctioned budget must be greater than zero');
  }
  return ok({ sanctioned, releases: [], expenditures: [] });
}

const sum = (amounts: readonly Money[], currency: string): Money => ({
  amountMinor: amounts.reduce((acc, m) => acc + m.amountMinor, 0),
  currency,
});

export const totalReleased = (ledger: BudgetLedger): Money =>
  sum(
    ledger.releases.map((r) => r.amount),
    ledger.sanctioned.currency,
  );

export const totalSpent = (ledger: BudgetLedger): Money =>
  sum(
    ledger.expenditures.map((e) => e.amount),
    ledger.sanctioned.currency,
  );

export const unspentBalance = (ledger: BudgetLedger): Money => ({
  amountMinor: totalReleased(ledger).amountMinor - totalSpent(ledger).amountMinor,
  currency: ledger.sanctioned.currency,
});

function guardAmount(ledger: BudgetLedger, amount: Money): Result<true> {
  if (amount.currency !== ledger.sanctioned.currency) {
    return err(
      'CURRENCY_MISMATCH',
      `ledger is in ${ledger.sanctioned.currency}, amount is in ${amount.currency}`,
    );
  }
  if (amount.amountMinor <= 0) {
    return err('AMOUNT_NOT_POSITIVE', 'amount must be greater than zero minor units');
  }
  return ok(true);
}

/** FR-FM-2: cumulative released must never exceed the sanctioned budget. */
export function recordRelease(ledger: BudgetLedger, amount: Money, at: Date): Result<BudgetLedger> {
  const guard = guardAmount(ledger, amount);
  if (!guard.ok) return guard;

  const cumulative = addMoney(totalReleased(ledger), amount);
  if (!cumulative.ok) return cumulative;
  if (!gte(ledger.sanctioned, cumulative.value)) {
    return err(
      'RELEASE_EXCEEDS_SANCTIONED',
      `cumulative release ${cumulative.value.amountMinor} exceeds sanctioned ${ledger.sanctioned.amountMinor}`,
    );
  }

  return ok({ ...ledger, releases: [...ledger.releases, { amount, at }] });
}

/** FR-FM-2: cumulative spend must never exceed the funds actually released. */
export function recordSpend(
  ledger: BudgetLedger,
  amount: Money,
  description: string,
  at: Date,
): Result<BudgetLedger> {
  const guard = guardAmount(ledger, amount);
  if (!guard.ok) return guard;

  const trimmed = description.trim();
  if (trimmed === '') {
    return err('EXPENDITURE_NEEDS_DESCRIPTION', 'every expenditure needs a description');
  }

  const cumulative = addMoney(totalSpent(ledger), amount);
  if (!cumulative.ok) return cumulative;
  const released = totalReleased(ledger);
  if (!gte(released, cumulative.value)) {
    return err(
      'SPEND_EXCEEDS_RELEASED',
      `cumulative spend ${cumulative.value.amountMinor} exceeds released ${released.amountMinor}`,
    );
  }

  return ok({
    ...ledger,
    expenditures: [...ledger.expenditures, { amount, at, description: trimmed }],
  });
}
