import { describe, expect, it, vi } from "vitest";
import {
  beneficiaryId,
  CapturingEventPublisher,
  FixedClock,
  unwrap,
  villageId,
} from "@afrip/shared-kernel";
import { RecordAid } from "../src/application/record-aid.js";
import type { BeneficiaryRepository } from "../src/application/ports.js";
import { Beneficiary } from "../src/domain/beneficiary.js";

function buildBeneficiary(): Beneficiary {
  return unwrap(
    Beneficiary.create({
      id: unwrap(beneficiaryId("ben-1")),
      villageId: unwrap(villageId("village-1")),
      name: "Sita Devi",
      category: "widow",
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

function setup(beneficiary: Beneficiary | null = buildBeneficiary(), windowDays?: number) {
  const repository = buildRepository({ findById: vi.fn().mockResolvedValue(beneficiary) });
  const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const eventPublisher = new CapturingEventPublisher();
  const useCase = new RecordAid({
    repository,
    clock,
    eventPublisher,
    ...(windowDays === undefined ? {} : { windowDays }),
  });
  return { repository, clock, eventPublisher, useCase };
}

const foodFromNgo1 = {
  beneficiaryId: "ben-1",
  aidType: "food",
  providerId: "ngo-1",
  providerType: "ngo",
} as const;

describe("RecordAid", () => {
  it("errs when the beneficiary does not exist, without saving or publishing", async () => {
    const { repository, eventPublisher, useCase } = setup(null);

    const result = await useCase.execute({ ...foodFromNgo1, beneficiaryId: "missing" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs on an invalid beneficiary id, aid type or provider type without saving or publishing", async () => {
    const { repository, eventPublisher, useCase } = setup();

    expect((await useCase.execute({ ...foodFromNgo1, beneficiaryId: " " })).ok).toBe(false);
    expect((await useCase.execute({ ...foodFromNgo1, aidType: "gold" as never })).ok).toBe(false);
    expect((await useCase.execute({ ...foodFromNgo1, providerType: "corp" as never })).ok).toBe(
      false,
    );
    expect((await useCase.execute({ ...foodFromNgo1, providerId: "" })).ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("records aid with deliveredAt from the clock and saves the beneficiary", async () => {
    const beneficiary = buildBeneficiary();
    const { repository, useCase } = setup(beneficiary);

    const result = await useCase.execute({ ...foodFromNgo1, notes: "50kg rice" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duplicate).toBe(false);
    expect(result.value.deliveredAt).toBe("2026-01-01T00:00:00.000Z");

    expect(repository.findById).toHaveBeenCalledWith("ben-1");
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(beneficiary);
    expect(beneficiary.aidRecords).toEqual([
      {
        aidType: "food",
        providerId: "ngo-1",
        providerType: "ngo",
        deliveredAt: "2026-01-01T00:00:00.000Z",
        notes: "50kg rice",
      },
    ]);
  });

  it("publishes only beneficiary.aid-recorded.v1 for a first delivery", async () => {
    const { eventPublisher, useCase } = setup();

    await useCase.execute(foodFromNgo1);

    expect(eventPublisher.eventNames()).toEqual(["beneficiary.aid-recorded.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "beneficiary.aid-recorded.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        beneficiaryId: "ben-1",
        aidType: "food",
        providerId: "ngo-1",
        providerType: "ngo",
        deliveredAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("records AND flags a duplicate when a different provider repeats the aid type 13 days later", async () => {
    const beneficiary = buildBeneficiary();
    const { clock, eventPublisher, useCase } = setup(beneficiary);

    await useCase.execute(foodFromNgo1);
    clock.advanceDays(13);
    const result = await useCase.execute({
      ...foodFromNgo1,
      providerId: "gov-1",
      providerType: "government",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duplicate).toBe(true);

    // aid is still recorded, never silently rejected
    expect(beneficiary.aidRecords).toHaveLength(2);
    expect(beneficiary.duplicateFlags).toEqual([
      {
        aidType: "food",
        providerIds: ["ngo-1", "gov-1"],
        flaggedAt: "2026-01-14T00:00:00.000Z",
      },
    ]);

    expect(eventPublisher.eventNames()).toEqual([
      "beneficiary.aid-recorded.v1",
      "beneficiary.aid-recorded.v1",
      "beneficiary.duplicate-aid-flagged.v1",
    ]);
    expect(eventPublisher.published[2]).toEqual({
      name: "beneficiary.duplicate-aid-flagged.v1",
      occurredAt: "2026-01-14T00:00:00.000Z",
      payload: {
        beneficiaryId: "ben-1",
        aidType: "food",
        providerIds: ["ngo-1", "gov-1"],
      },
    });
  });

  it("does not flag a different provider repeating the aid type 15 days later", async () => {
    const beneficiary = buildBeneficiary();
    const { clock, eventPublisher, useCase } = setup(beneficiary);

    await useCase.execute(foodFromNgo1);
    clock.advanceDays(15);
    const result = await useCase.execute({
      ...foodFromNgo1,
      providerId: "gov-1",
      providerType: "government",
    });

    expect(result.ok && result.value.duplicate).toBe(false);
    expect(beneficiary.aidRecords).toHaveLength(2);
    expect(beneficiary.duplicateFlags).toHaveLength(0);
    expect(eventPublisher.eventNames()).toEqual([
      "beneficiary.aid-recorded.v1",
      "beneficiary.aid-recorded.v1",
    ]);
  });

  it("does not flag the SAME provider repeating the aid type within the window", async () => {
    const beneficiary = buildBeneficiary();
    const { clock, eventPublisher, useCase } = setup(beneficiary);

    await useCase.execute(foodFromNgo1);
    clock.advanceDays(13);
    const result = await useCase.execute(foodFromNgo1);

    expect(result.ok && result.value.duplicate).toBe(false);
    expect(beneficiary.duplicateFlags).toHaveLength(0);
    expect(eventPublisher.eventNames()).toEqual([
      "beneficiary.aid-recorded.v1",
      "beneficiary.aid-recorded.v1",
    ]);
  });

  it("honours a configurable windowDays on the use case", async () => {
    const beneficiary = buildBeneficiary();
    const { clock, eventPublisher, useCase } = setup(beneficiary, 7);

    await useCase.execute(foodFromNgo1);
    clock.advanceDays(8); // outside a 7-day window
    const outside = await useCase.execute({
      ...foodFromNgo1,
      providerId: "gov-1",
      providerType: "government",
    });
    expect(outside.ok && outside.value.duplicate).toBe(false);

    clock.advanceDays(5); // 5 days after gov-1, inside the 7-day window
    const inside = await useCase.execute({
      ...foodFromNgo1,
      providerId: "donor-1",
      providerType: "donor",
    });
    expect(inside.ok && inside.value.duplicate).toBe(true);
    expect(beneficiary.duplicateFlags).toEqual([
      {
        aidType: "food",
        providerIds: ["gov-1", "donor-1"],
        flaggedAt: "2026-01-14T00:00:00.000Z",
      },
    ]);
    expect(
      eventPublisher.eventNames().filter((n) => n === "beneficiary.duplicate-aid-flagged.v1"),
    ).toHaveLength(1);
  });
});
