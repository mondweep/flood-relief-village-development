import { describe, expect, it, vi } from "vitest";
import {
  beneficiaryId,
  CapturingEventPublisher,
  FixedClock,
  SequentialIdGenerator,
  unwrap,
  villageId,
} from "@afrip/shared-kernel";
import { ScheduleFollowUp } from "../src/application/schedule-follow-up.js";
import { CompleteFollowUp } from "../src/application/complete-follow-up.js";
import type { BeneficiaryRepository } from "../src/application/ports.js";
import { Beneficiary } from "../src/domain/beneficiary.js";

function buildBeneficiary(id = "ben-1"): Beneficiary {
  return unwrap(
    Beneficiary.create({
      id: unwrap(beneficiaryId(id)),
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

function setup(beneficiary: Beneficiary | null = buildBeneficiary()) {
  const repository = buildRepository({ findById: vi.fn().mockResolvedValue(beneficiary) });
  const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const idGenerator = new SequentialIdGenerator("followup");
  const eventPublisher = new CapturingEventPublisher();
  const schedule = new ScheduleFollowUp({ repository, clock, idGenerator, eventPublisher });
  const complete = new CompleteFollowUp({ repository, clock, eventPublisher });
  return { repository, clock, eventPublisher, schedule, complete };
}

describe("ScheduleFollowUp", () => {
  it("errs when the beneficiary does not exist, without saving or publishing", async () => {
    const { repository, eventPublisher, schedule } = setup(null);

    const result = await schedule.execute({
      beneficiaryId: "missing",
      dueAt: "2026-02-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs on an invalid dueAt without saving or publishing", async () => {
    const { repository, eventPublisher, schedule } = setup();

    const result = await schedule.execute({ beneficiaryId: "ben-1", dueAt: "not-a-date" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("schedules a follow-up, saves the beneficiary and publishes the event", async () => {
    const beneficiary = buildBeneficiary();
    const { repository, eventPublisher, schedule } = setup(beneficiary);

    const result = await schedule.execute({
      beneficiaryId: "ben-1",
      dueAt: "2026-02-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.followUpId).toBe("followup-1");

    expect(repository.findById).toHaveBeenCalledWith("ben-1");
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(beneficiary);
    expect(beneficiary.followUps).toEqual([
      { id: "followup-1", dueAt: "2026-02-01T00:00:00.000Z" },
    ]);

    expect(eventPublisher.published).toEqual([
      {
        name: "beneficiary.follow-up-scheduled.v1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {
          beneficiaryId: "ben-1",
          followUpId: "followup-1",
          dueAt: "2026-02-01T00:00:00.000Z",
        },
      },
    ]);
  });
});

describe("CompleteFollowUp", () => {
  it("errs when the beneficiary does not exist", async () => {
    const { repository, eventPublisher, complete } = setup(null);

    const result = await complete.execute({ beneficiaryId: "missing", followUpId: "followup-1" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs when the follow-up does not exist on the beneficiary", async () => {
    const { repository, eventPublisher, complete } = setup();

    const result = await complete.execute({ beneficiaryId: "ben-1", followUpId: "missing" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("completes the follow-up with completedAt from the clock, saves and publishes", async () => {
    const beneficiary = buildBeneficiary();
    beneficiary.scheduleFollowUp("followup-1", "2026-01-15T00:00:00.000Z");
    const { repository, clock, eventPublisher, complete } = setup(beneficiary);
    clock.advanceDays(20);

    const result = await complete.execute({ beneficiaryId: "ben-1", followUpId: "followup-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.completedAt).toBe("2026-01-21T00:00:00.000Z");
    expect(beneficiary.followUps[0]?.completedAt).toBe("2026-01-21T00:00:00.000Z");

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(beneficiary);
    expect(eventPublisher.published).toEqual([
      {
        name: "beneficiary.follow-up-completed.v1",
        occurredAt: "2026-01-21T00:00:00.000Z",
        payload: {
          beneficiaryId: "ben-1",
          followUpId: "followup-1",
          completedAt: "2026-01-21T00:00:00.000Z",
        },
      },
    ]);
  });

  it("errs when the follow-up is already completed, without saving or publishing again", async () => {
    const beneficiary = buildBeneficiary();
    beneficiary.scheduleFollowUp("followup-1", "2026-01-15T00:00:00.000Z");
    const { repository, eventPublisher, complete } = setup(beneficiary);

    const first = await complete.execute({ beneficiaryId: "ben-1", followUpId: "followup-1" });
    const second = await complete.execute({ beneficiaryId: "ben-1", followUpId: "followup-1" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(eventPublisher.published).toHaveLength(1);
  });
});
