import { describe, it, expect } from "vitest";
import { Money } from "../src/money.js";
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
