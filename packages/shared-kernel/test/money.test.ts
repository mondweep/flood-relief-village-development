import { describe, it, expect } from "vitest";
import { MAX_MAJOR_AMOUNT, Money, toMajorUnits } from "../src/money.js";
import { isErr, isOk, unwrap } from "../src/result.js";

describe("Money", () => {
  it("creates from minor units with default INR currency", () => {
    const m = unwrap(Money.of(50_000));
    expect(m.amountMinor).toBe(50_000);
    expect(m.currency).toBe("INR");
  });

  it("rejects negative amounts", () => {
    expect(isErr(Money.of(-1))).toBe(true);
  });

  it("rejects non-integer minor units", () => {
    expect(isErr(Money.of(10.5))).toBe(true);
  });

  it("adds amounts of the same currency", () => {
    const a = unwrap(Money.of(100));
    const b = unwrap(Money.of(250));
    expect(unwrap(a.add(b)).amountMinor).toBe(350);
  });

  it("refuses arithmetic across currencies", () => {
    const a = unwrap(Money.of(100, "INR"));
    const b = unwrap(Money.of(100, "USD"));
    expect(isErr(a.add(b))).toBe(true);
    expect(isErr(a.subtract(b))).toBe(true);
  });

  it("subtract cannot go below zero", () => {
    const a = unwrap(Money.of(100));
    const b = unwrap(Money.of(250));
    expect(isErr(a.subtract(b))).toBe(true);
    expect(isOk(b.subtract(a))).toBe(true);
  });

  it("compares with lessThanOrEqual", () => {
    const a = unwrap(Money.of(100));
    const b = unwrap(Money.of(250));
    expect(a.lessThanOrEqual(b)).toBe(true);
    expect(b.lessThanOrEqual(a)).toBe(false);
    expect(a.lessThanOrEqual(a)).toBe(true);
  });
});

describe("Money.fromMajor", () => {
  it("converts whole rupees to paise", () => {
    const m = unwrap(Money.fromMajor(50_000));
    expect(m.amountMinor).toBe(5_000_000);
    expect(m.currency).toBe("INR");
  });

  it("converts zero", () => {
    expect(unwrap(Money.fromMajor(0)).amountMinor).toBe(0);
  });

  it("carries a non-default currency through", () => {
    expect(unwrap(Money.fromMajor(10, "USD")).currency).toBe("USD");
  });

  /**
   * The whole reason this is a `Result` and not `Math.round(x * 100)`.
   *
   * Every one of these is a value where the naive conversion is WRONG rather
   * than merely imprecise: `19.99 * 100` is `1998.9999999999998`, so a bare
   * `Math.trunc` loses a paisa; `0.1 + 0.2` is `0.30000000000000004`, which an
   * exact `Number.isInteger(x * 100)` guard would reject outright. A money test
   * suite that omits these is not testing the risk.
   */
  it.each([
    [19.99, 1999],
    [0.1 + 0.2, 30],
    [1_234_567.89, 123_456_789],
    [0.01, 1],
    [0.1, 10],
    [0.07, 7],
    [8.16, 816],
    [2.675, undefined], // classic: 2.675 is really 2.67499999999999982…
    [12_345_678.99, 1_234_567_899],
    [99_999.95, 9_999_995],
  ] as const)("converts %p to exactly %p paise", (major, paise) => {
    if (paise === undefined) {
      expect(isErr(Money.fromMajor(major))).toBe(true);
      return;
    }
    const m = unwrap(Money.fromMajor(major));
    expect(m.amountMinor).toBe(paise);
    expect(Number.isInteger(m.amountMinor)).toBe(true);
  });

  it("rejects more than 2 decimal places instead of silently rounding", () => {
    // Bare Math.round(0.145 * 100) is 14 — a paisa vanishes with no complaint.
    const tooPrecise = Money.fromMajor(0.145);
    expect(isErr(tooPrecise)).toBe(true);
    if (!tooPrecise.ok) {
      expect(tooPrecise.error).toBe("Money amount cannot have more than 2 decimal places");
    }

    expect(isErr(Money.fromMajor(1234.567))).toBe(true);
    expect(isErr(Money.fromMajor(1.005))).toBe(true);
    expect(isErr(Money.fromMajor(0.001))).toBe(true);
    expect(isErr(Money.fromMajor(50_000.125))).toBe(true);
    // Four and six decimals are no more acceptable than three.
    expect(isErr(Money.fromMajor(10.1234))).toBe(true);
    expect(isErr(Money.fromMajor(10.123456))).toBe(true);
  });

  it("rejects non-finite input", () => {
    expect(isErr(Money.fromMajor(Number.NaN))).toBe(true);
    expect(isErr(Money.fromMajor(Number.POSITIVE_INFINITY))).toBe(true);
    expect(isErr(Money.fromMajor(Number.NEGATIVE_INFINITY))).toBe(true);
  });

  it("rejects negatives", () => {
    expect(isErr(Money.fromMajor(-1))).toBe(true);
    expect(isErr(Money.fromMajor(-0.01))).toBe(true);
  });

  it("rejects amounts that would lose integer precision once scaled to paise", () => {
    expect(isOk(Money.fromMajor(MAX_MAJOR_AMOUNT))).toBe(true);
    // One rupee past the limit, x * 100 is no longer an exact integer.
    const tooLarge = Money.fromMajor(MAX_MAJOR_AMOUNT + 1);
    expect(isErr(tooLarge)).toBe(true);
    expect(isErr(Money.fromMajor(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(isErr(Money.fromMajor(1e300))).toBe(true);
    // A relief budget in crores is nowhere near the limit and must pass:
    // 500 crore rupees is 5e9 major units, 5e11 paise.
    expect(unwrap(Money.fromMajor(500_00_00_000)).amountMinor).toBe(500_000_000_000);
  });

  it("round-trips through amountMajor", () => {
    for (const major of [0, 0.01, 19.99, 50_000, 1_234_567.89]) {
      expect(unwrap(Money.fromMajor(major)).amountMajor).toBe(major);
    }
  });
});

describe("amountMajor", () => {
  it("reports minor units as major units", () => {
    expect(unwrap(Money.of(5_000_000)).amountMajor).toBe(50_000);
    expect(unwrap(Money.of(1999)).amountMajor).toBe(19.99);
    expect(unwrap(Money.of(1)).amountMajor).toBe(0.01);
    expect(Money.zero().amountMajor).toBe(0);
  });

  it("keeps arithmetic in integer minor units — floats never enter the ladder", () => {
    // 0.07 + 0.02 + 0.01 in floats is 0.10000000000000002. In paise it is 10.
    const total = unwrap(
      unwrap(unwrap(Money.fromMajor(0.07)).add(unwrap(Money.fromMajor(0.02)))).add(
        unwrap(Money.fromMajor(0.01)),
      ),
    );
    expect(total.amountMinor).toBe(10);
    expect(total.amountMajor).toBe(0.1);
  });

  it("exposes the same conversion as a free function for summed totals", () => {
    expect(toMajorUnits(123_456_789)).toBe(1_234_567.89);
    expect(toMajorUnits(0)).toBe(0);
  });
});
