import { describe, expect, it } from "vitest";
import { determineRouting } from "../src/domain/routing-policy.js";

describe("determineRouting", () => {
  it("always routes corruption to district_administration, never the lead NGO", () => {
    const withNgo = determineRouting("corruption", { ngoId: "ngo-1", name: "Helping Hands" });
    const withoutNgo = determineRouting("corruption", null);

    expect(withNgo).toEqual({ partyType: "government_department", party: "district_administration" });
    expect(withoutNgo).toEqual({ partyType: "government_department", party: "district_administration" });
  });

  it("routes health issues to health_department, never the lead NGO", () => {
    const withNgo = determineRouting("health", { ngoId: "ngo-1", name: "Helping Hands" });
    const withoutNgo = determineRouting("health", null);

    expect(withNgo).toEqual({ partyType: "government_department", party: "health_department" });
    expect(withoutNgo).toEqual({ partyType: "government_department", party: "health_department" });
  });

  for (const category of ["infrastructure", "water", "food", "education"] as const) {
    it(`routes ${category} issues to the lead NGO when one exists`, () => {
      const decision = determineRouting(category, { ngoId: "ngo-1", name: "Helping Hands" });
      expect(decision).toEqual({ partyType: "lead_ngo", party: "ngo-1" });
    });

    it(`routes ${category} issues to district_administration when there is no lead NGO`, () => {
      const decision = determineRouting(category, null);
      expect(decision).toEqual({ partyType: "government_department", party: "district_administration" });
    });
  }

  it("routes other issues to district_administration regardless of a lead NGO", () => {
    const withNgo = determineRouting("other", { ngoId: "ngo-1", name: "Helping Hands" });
    const withoutNgo = determineRouting("other", null);

    expect(withNgo).toEqual({ partyType: "government_department", party: "district_administration" });
    expect(withoutNgo).toEqual({ partyType: "government_department", party: "district_administration" });
  });
});
