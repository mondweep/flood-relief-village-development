import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, unwrap, type Result } from "../src/result.js";

describe("Result", () => {
  it("ok carries a value and reports isOk", () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(unwrap(r)).toBe(42);
  });

  it("err carries an error and reports isErr", () => {
    const r: Result<number, string> = err("boom");
    expect(isOk(r)).toBe(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe("boom");
  });

  it("unwrap throws on err", () => {
    expect(() => unwrap(err("nope"))).toThrow(/nope/);
  });
});
