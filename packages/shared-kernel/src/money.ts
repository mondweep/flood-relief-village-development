import { err, ok, type Result } from "./result.js";

export type CurrencyCode = "INR" | "USD" | "EUR" | "GBP";

export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: CurrencyCode,
  ) {}

  static of(amountMinor: number, currency: CurrencyCode = "INR"): Result<Money> {
    if (!Number.isInteger(amountMinor)) return err("Money amount must be integer minor units");
    if (amountMinor < 0) return err("Money amount cannot be negative");
    return ok(new Money(amountMinor, currency));
  }

  static zero(currency: CurrencyCode = "INR"): Money {
    return new Money(0, currency);
  }

  add(other: Money): Result<Money> {
    if (other.currency !== this.currency) return err("Cannot add money in different currencies");
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Result<Money> {
    if (other.currency !== this.currency) return err("Cannot subtract money in different currencies");
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  lessThanOrEqual(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor <= other.amountMinor;
  }
}
