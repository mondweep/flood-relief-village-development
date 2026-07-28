import { describe, expect, it } from "vitest";
import { unwrap } from "@afrip/shared-kernel";
import { KeywordSignalExtractor } from "../src/adapters/keyword-signal-extractor.js";
import type { Extracted } from "../src/domain/signal.js";

async function extract(text: string): Promise<Extracted> {
  const extractor = new KeywordSignalExtractor();
  return unwrap(await extractor.extract(text, "x"));
}

describe("KeywordSignalExtractor", () => {
  it("classifies text mentioning an orphan as orphan_identified", async () => {
    const extracted = await extract("An orphan was found near the river bank");
    expect(extracted.activityType).toBe("orphan_identified");
  });

  it("classifies text mentioning a medical camp as medical_camp", async () => {
    const extracted = await extract("Medical camp organised for flood victims");
    expect(extracted.activityType).toBe("medical_camp");
  });

  it("classifies text mentioning distributed goods as relief_distribution", async () => {
    const extracted = await extract("Blankets distributed to 200 families");
    expect(extracted.activityType).toBe("relief_distribution");
  });

  it("classifies text mentioning relief as relief_distribution", async () => {
    const extracted = await extract("Relief material reached the affected families");
    expect(extracted.activityType).toBe("relief_distribution");
  });

  it("classifies text mentioning a missing person as missing_person", async () => {
    const extracted = await extract("Two people missing after the embankment breach");
    expect(extracted.activityType).toBe("missing_person");
  });

  it("classifies text mentioning donations as donation", async () => {
    const extracted = await extract("Donation drive collected 5 lakh rupees");
    expect(extracted.activityType).toBe("donation");
  });

  it("classifies text mentioning damage as infrastructure_damage", async () => {
    const extracted = await extract("The bridge was damaged by the flood");
    expect(extracted.activityType).toBe("infrastructure_damage");
  });

  it("prefers orphan_identified over relief keywords", async () => {
    const extracted = await extract("Relief distributed; an orphan was identified at the camp");
    expect(extracted.activityType).toBe("orphan_identified");
  });

  it("prefers medical_camp over relief keywords", async () => {
    const extracted = await extract("Relief team set up a medical camp");
    expect(extracted.activityType).toBe("medical_camp");
  });

  it("leaves activityType undefined when no keyword matches", async () => {
    const extracted = await extract("Water levels continue to rise slowly");
    expect(extracted.activityType).toBeUndefined();
  });

  it("is case-insensitive", async () => {
    const extracted = await extract("MEDICAL CAMP announced");
    expect(extracted.activityType).toBe("medical_camp");
  });

  it("extracts needs keywords present in the text", async () => {
    const extracted = await extract("Families need food, clean water and medical attention");
    expect(extracted.needs).toEqual(["food", "water", "medical"]);
  });

  it("returns an empty needs list when no need keyword is present", async () => {
    const extracted = await extract("A quiet day in the district");
    expect(extracted.needs).toEqual([]);
  });

  it("extracts a village name following the word village", async () => {
    const extracted = await extract("Relief distributed in village Rampur today");
    expect(extracted.villageName).toBe("Rampur");
  });

  it("extracts a village name preceding the word village", async () => {
    const extracted = await extract("Medical camp held in Sonpur village");
    expect(extracted.villageName).toBe("Sonpur");
  });

  it("leaves villageName undefined when no village is mentioned", async () => {
    const extracted = await extract("Relief distributed to families");
    expect(extracted.villageName).toBeUndefined();
  });

  it("extracts an NGO name introduced with by", async () => {
    const extracted = await extract("Relief distributed by Goonj Foundation in village Rampur");
    expect(extracted.ngoName).toBe("Goonj Foundation");
  });

  it("leaves ngoName undefined when no NGO is mentioned", async () => {
    const extracted = await extract("Relief distributed in village Rampur");
    expect(extracted.ngoName).toBeUndefined();
  });

  it("produces Extracted output that satisfies the Signal invariants", async () => {
    const extracted = await extract("Relief distributed by Goonj Foundation in village Rampur");
    expect(Array.isArray(extracted.needs)).toBe(true);
  });
});
