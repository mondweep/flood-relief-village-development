import { describe, it, expect } from "vitest";
import { villageId, ngoId, beneficiaryId } from "../src/ids.js";
import { isErr, unwrap } from "../src/result.js";

describe("branded identifiers", () => {
  it("accepts a non-empty id and preserves its value", () => {
    const id = unwrap(villageId("vil-001"));
    expect(id).toBe("vil-001");
  });

  it("rejects empty and whitespace-only ids", () => {
    expect(isErr(villageId(""))).toBe(true);
    expect(isErr(ngoId("   "))).toBe(true);
  });

  it("brands are distinct at the type level but share runtime shape", () => {
    const v = unwrap(villageId("x-1"));
    const b = unwrap(beneficiaryId("x-1"));
    expect(v).toBe(b as string);
  });
});
