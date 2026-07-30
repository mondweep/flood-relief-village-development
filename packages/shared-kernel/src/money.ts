import { err, ok, type Result } from "./result.js";

export type CurrencyCode = "INR" | "USD" | "EUR" | "GBP";

/**
 * Money is stored and calculated in INTEGER MINOR UNITS (paise for INR) and
 * that is not negotiable: this platform tracks public relief money under the
 * enforced invariant `spent <= released <= sanctioned`, and floating-point
 * rupees would let that ladder drift by fractions no audit could reconcile.
 *
 * What major units (rupees) are for is the BOUNDARY. A caller should be able to
 * say ₹50,000 as `50000`, not as `5000000`, so `fromMajor` / `amountMajor`
 * convert at the edge while the interior stays integral. Nothing here ever
 * returns a float to the domain.
 */

/** Minor units in one major unit. Every currency this platform mints uses 100. */
export const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Largest major-unit amount we will convert. Above this, `x * 100` exceeds
 * `Number.MAX_SAFE_INTEGER` and the resulting paise count is no longer an exact
 * integer — the arithmetic would silently start losing whole paise. A relief
 * budget in crores (1 crore = 10,000,000) is seven orders of magnitude below
 * this, so nothing legitimate is refused; what is refused is an absurd number,
 * and a rejected absurd number beats a silently wrong one.
 */
export const MAX_MAJOR_AMOUNT = Number.MAX_SAFE_INTEGER / MINOR_UNITS_PER_MAJOR;

/**
 * How far `amountMajor * 100` may sit from a whole number and still count as a
 * clean two-decimal figure.
 *
 * A tolerance is unavoidable, not sloppiness. `19.99 * 100` is
 * `1998.9999999999998` in IEEE754 and `0.1 + 0.2` is `0.30000000000000004`;
 * both are two-decimal amounts a caller legitimately means, and an exact
 * `Number.isInteger(x * 100)` test would reject them. So we allow a few ULPs of
 * representation noise, scaled to the magnitude of the number (absolute
 * epsilons are meaningless at 1e8).
 *
 * The cap is what keeps the tolerance honest. A genuine third decimal moves
 * `x * 100` at least 0.1 away from a whole number (`x.001` -> `.1`), so
 * tolerating at most half of that means excess precision can never slip through
 * — not even at magnitudes near `MAX_MAJOR_AMOUNT`, where the ULP term alone
 * would grow larger than a whole paisa.
 */
const SCALING_SLACK_ULPS = 8;
const MAX_SCALING_SLACK = 0.05;

function scalingTolerance(scaled: number): number {
  const ulpSlack = Number.EPSILON * Math.abs(scaled) * SCALING_SLACK_ULPS;
  return Math.min(Math.max(ulpSlack, Number.EPSILON), MAX_SCALING_SLACK);
}

/**
 * Minor units -> major units, for presentation of an already-summed integer
 * total. Division by 100 is correctly rounded in IEEE754, so this yields the
 * closest double to the true rupee value (1999 -> 19.99 exactly as printed).
 */
export function toMajorUnits(amountMinor: number): number {
  return amountMinor / MINOR_UNITS_PER_MAJOR;
}

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

  /**
   * Builds from major units (rupees). Deliberately a `Result`, not a coercion:
   * `Math.round(x * 100)` on its own turns `0.145` into 14 paise and `1.005`
   * into 100 paise without a word, and a caller who typed a third decimal has
   * made a mistake they need to be told about rather than have rounded away.
   */
  static fromMajor(amountMajor: number, currency: CurrencyCode = "INR"): Result<Money> {
    if (typeof amountMajor !== "number" || !Number.isFinite(amountMajor)) {
      return err("Money amount must be a finite number");
    }
    if (amountMajor < 0) return err("Money amount cannot be negative");
    if (amountMajor > MAX_MAJOR_AMOUNT) {
      return err(`Money amount cannot exceed ${MAX_MAJOR_AMOUNT} major units`);
    }

    const scaled = amountMajor * MINOR_UNITS_PER_MAJOR;
    const amountMinor = Math.round(scaled);
    if (Math.abs(scaled - amountMinor) > scalingTolerance(scaled)) {
      return err("Money amount cannot have more than 2 decimal places");
    }

    return Money.of(amountMinor, currency);
  }

  static zero(currency: CurrencyCode = "INR"): Money {
    return new Money(0, currency);
  }

  /** The amount in major units (rupees), for the HTTP boundary and displays. */
  get amountMajor(): number {
    return toMajorUnits(this.amountMinor);
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
