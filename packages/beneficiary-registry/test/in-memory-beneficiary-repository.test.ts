import { describe, expect, it } from "vitest";
import { beneficiaryId, unwrap, villageId } from "@afrip/shared-kernel";
import { InMemoryBeneficiaryRepository } from "../src/adapters/in-memory-beneficiary-repository.js";
import { Beneficiary } from "../src/domain/beneficiary.js";

function buildBeneficiary(id: string, village: string): Beneficiary {
  return unwrap(
    Beneficiary.create({
      id: unwrap(beneficiaryId(id)),
      villageId: unwrap(villageId(village)),
      name: `Beneficiary ${id}`,
      category: "widow",
    }),
  );
}

describe("InMemoryBeneficiaryRepository", () => {
  it("returns null for an unknown id", async () => {
    const repo = new InMemoryBeneficiaryRepository();
    expect(await repo.findById(unwrap(beneficiaryId("missing")))).toBeNull();
  });

  it("saves and finds a beneficiary by id, upserting on repeat saves", async () => {
    const repo = new InMemoryBeneficiaryRepository();
    const b = buildBeneficiary("ben-1", "village-1");

    await repo.save(b);
    await repo.save(b);

    expect(await repo.findById(unwrap(beneficiaryId("ben-1")))).toBe(b);
    expect(await repo.listAll()).toHaveLength(1);
  });

  it("lists beneficiaries by village", async () => {
    const repo = new InMemoryBeneficiaryRepository();
    const a = buildBeneficiary("ben-1", "village-1");
    const b = buildBeneficiary("ben-2", "village-2");
    const c = buildBeneficiary("ben-3", "village-1");
    await repo.save(a);
    await repo.save(b);
    await repo.save(c);

    const inVillage1 = await repo.listByVillage(unwrap(villageId("village-1")));

    expect(inVillage1.map((x) => x.id)).toEqual(["ben-1", "ben-3"]);
    expect(await repo.listAll()).toHaveLength(3);
  });
});
