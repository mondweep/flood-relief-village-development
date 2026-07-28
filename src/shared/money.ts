import { type Result, ok, err } from './result.js';

/**
 * Money in integer minor units (e.g. paise) to avoid floating point drift.
 * Shared kernel value object used by Fund Monitoring and others.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export function money(amountMinor: number, currency = 'INR'): Result<Money> {
  if (!Number.isInteger(amountMinor)) return err('MONEY_NOT_INTEGER', 'amount must be integer minor units');
  if (amountMinor < 0) return err('MONEY_NEGATIVE', 'amount must be >= 0');
  if (!/^[A-Z]{3}$/.test(currency)) return err('MONEY_BAD_CURRENCY', `invalid currency: ${currency}`);
  return ok({ amountMinor, currency });
}

export function addMoney(a: Money, b: Money): Result<Money> {
  if (a.currency !== b.currency) return err('MONEY_CURRENCY_MISMATCH', `${a.currency} + ${b.currency}`);
  return ok({ amountMinor: a.amountMinor + b.amountMinor, currency: a.currency });
}

export const gte = (a: Money, b: Money): boolean => a.amountMinor >= b.amountMinor;
