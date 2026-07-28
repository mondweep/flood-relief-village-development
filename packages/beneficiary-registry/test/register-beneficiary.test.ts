import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator } from "@afrip/shared-kernel";
import {
  RegisterBeneficiary,
  type RegisterBeneficiaryInput,
} from "../src/application/register-beneficiary.js";
import type { BeneficiaryRepository } from "../src/application/ports.js";
import type { Beneficiary } from "../src/domain/beneficiary.js";

function buildRepository(overrides: Partial<BeneficiaryRepository> = {}): BeneficiaryRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listByVillage: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function validInput(): RegisterBeneficiaryInput {
  return { villageId: "village-1", name: "Sita Devi", category: "widow" };
}

function setup(repository = buildRepository()) {
  const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const idGenerator = new SequentialIdGenerator("beneficiary");
  const eventPublisher = new CapturingEventPublisher();
  const useCase = new RegisterBeneficiary({ repository, clock, idGenerator, eventPublisher });
  return { repository, clock, idGenerator, eventPublisher, useCase };
}

describe("RegisterBeneficiary", () => {
  it("saves the new beneficiary and returns its generated id", async () => {
    const { repository, useCase } = setup();

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.beneficiaryId).toBe("beneficiary-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Beneficiary;
    expect(saved.id).toBe("beneficiary-1");
    expect(saved.villageId).toBe("village-1");
    expect(saved.name).toBe("Sita Devi");
    expect(saved.category).toBe("widow");
    expect(saved.aidRecords).toHaveLength(0);
  });

  it("publishes beneficiary.registered.v1 with the correct payload", async () => {
    const { eventPublisher, useCase } = setup();

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["beneficiary.registered.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "beneficiary.registered.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        beneficiaryId: "beneficiary-1",
        villageId: "village-1",
        category: "widow",
      },
    });
  });

  it("errs on an empty village id without saving or publishing", async () => {
    const { repository, eventPublisher, useCase } = setup();

    const result = await useCase.execute({ ...validInput(), villageId: "  " });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs on an empty name without saving or publishing", async () => {
    const { repository, eventPublisher, useCase } = setup();

    const result = await useCase.execute({ ...validInput(), name: "" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs on an invalid category without saving or publishing", async () => {
    const { repository, eventPublisher, useCase } = setup();

    const result = await useCase.execute({ ...validInput(), category: "landlord" as never });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns a fresh id for each registered beneficiary", async () => {
    const { useCase } = setup();

    const first = await useCase.execute(validInput());
    const second = await useCase.execute({ ...validInput(), name: "Ram Kumar", category: "farmer" });

    expect(first.ok && first.value.beneficiaryId).toBe("beneficiary-1");
    expect(second.ok && second.value.beneficiaryId).toBe("beneficiary-2");
  });
});
