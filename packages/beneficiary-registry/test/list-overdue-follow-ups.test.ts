import { describe, expect, it, vi } from "vitest";
import { beneficiaryId, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import { ListOverdueFollowUps } from "../src/application/list-overdue-follow-ups.js";
import type { BeneficiaryRepository } from "../src/application/ports.js";
import { Beneficiary, type BeneficiaryCategory } from "../src/domain/beneficiary.js";

function buildBeneficiary(
  id: string,
  name: string,
  village: string,
  category: BeneficiaryCategory = "widow",
): Beneficiary {
  return unwrap(
    Beneficiary.create({
      id: unwrap(beneficiaryId(id)),
      villageId: unwrap(villageId(village)),
      name,
      category,
    }),
  );
}

function buildRepository(overrides: Partial<BeneficiaryRepository> = {}): BeneficiaryRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listByVillage: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("ListOverdueFollowUps", () => {
  it("returns overdue, uncompleted follow-ups across all beneficiaries", async () => {
    const sita = buildBeneficiary("ben-1", "Sita Devi", "village-1");
    sita.scheduleFollowUp("fu-1", "2026-01-10T00:00:00.000Z"); // overdue
    sita.scheduleFollowUp("fu-2", "2026-03-01T00:00:00.000Z"); // future
    const ram = buildBeneficiary("ben-2", "Ram Kumar", "village-2", "farmer");
    ram.scheduleFollowUp("fu-3", "2026-01-05T00:00:00.000Z"); // overdue but completed
    ram.completeFollowUp("fu-3", "2026-01-06T00:00:00.000Z");
    ram.scheduleFollowUp("fu-4", "2026-01-20T00:00:00.000Z"); // overdue

    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([sita, ram]) });
    const clock = new FixedClock(new Date("2026-02-01T00:00:00.000Z"));
    const useCase = new ListOverdueFollowUps({ repository, clock });

    const result = await useCase.execute();

    expect(repository.listAll).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        beneficiaryId: "ben-1",
        name: "Sita Devi",
        villageId: "village-1",
        followUpId: "fu-1",
        dueAt: "2026-01-10T00:00:00.000Z",
      },
      {
        beneficiaryId: "ben-2",
        name: "Ram Kumar",
        villageId: "village-2",
        followUpId: "fu-4",
        dueAt: "2026-01-20T00:00:00.000Z",
      },
    ]);
  });

  it("excludes follow-ups due exactly now", async () => {
    const sita = buildBeneficiary("ben-1", "Sita Devi", "village-1");
    sita.scheduleFollowUp("fu-1", "2026-02-01T00:00:00.000Z");

    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([sita]) });
    const clock = new FixedClock(new Date("2026-02-01T00:00:00.000Z"));
    const useCase = new ListOverdueFollowUps({ repository, clock });

    const result = await useCase.execute();

    expect(result.ok && result.value).toEqual([]);
  });

  it("becomes overdue once the clock advances past dueAt", async () => {
    const sita = buildBeneficiary("ben-1", "Sita Devi", "village-1");
    sita.scheduleFollowUp("fu-1", "2026-02-01T00:00:00.000Z");

    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([sita]) });
    const clock = new FixedClock(new Date("2026-02-01T00:00:00.000Z"));
    const useCase = new ListOverdueFollowUps({ repository, clock });
    clock.advanceDays(1);

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.followUpId)).toEqual(["fu-1"]);
  });

  it("returns an empty list when no beneficiaries exist", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-02-01T00:00:00.000Z"));
    const useCase = new ListOverdueFollowUps({ repository, clock });

    const result = await useCase.execute();

    expect(result.ok && result.value).toEqual([]);
  });
});
