import { describe, expect, it } from "vitest";
import { isErr, unwrap, type NgoId } from "@afrip/shared-kernel";
import { Ngo } from "../src/domain/ngo.js";

describe("Ngo aggregate", () => {
  it("creates a valid Ngo with the given props", () => {
    const result = Ngo.create({
      id: "ngo-1" as NgoId,
      name: "Helping Hands",
      focusAreas: ["shelter", "water"],
      capacity: 2,
    });

    const ngo = unwrap(result);
    expect(ngo.id).toBe("ngo-1");
    expect(ngo.name).toBe("Helping Hands");
    expect(ngo.focusAreas).toEqual(["shelter", "water"]);
    expect(ngo.capacity).toBe(2);
  });

  it("rejects a blank name", () => {
    const result = Ngo.create({ id: "ngo-1" as NgoId, name: "   ", focusAreas: [], capacity: 1 });
    expect(isErr(result)).toBe(true);
  });

  it.each([0, -1, 1.5, -3.2])("rejects an invalid capacity (%s)", (capacity) => {
    const result = Ngo.create({ id: "ngo-1" as NgoId, name: "Helping Hands", focusAreas: [], capacity });
    expect(isErr(result)).toBe(true);
  });

  it("accepts the minimum valid capacity of 1", () => {
    const result = Ngo.create({ id: "ngo-1" as NgoId, name: "Helping Hands", focusAreas: [], capacity: 1 });
    expect(unwrap(result).capacity).toBe(1);
  });

  it("defensively copies focusAreas so external mutation cannot change the aggregate", () => {
    const areas = ["shelter"];
    const ngo = unwrap(Ngo.create({ id: "ngo-1" as NgoId, name: "Helping Hands", focusAreas: areas, capacity: 1 }));

    areas.push("water");

    expect(ngo.focusAreas).toEqual(["shelter"]);
  });
});
