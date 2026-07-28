import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator } from "@afrip/shared-kernel";
import { ReportIssue, type ReportIssueInput } from "../src/application/report-issue.js";
import type { IssueRepository } from "../src/application/ports.js";

function buildRepository(overrides: Partial<IssueRepository> = {}): IssueRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listByVillage: vi.fn().mockResolvedValue([]),
    listByStatus: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function validInput(): ReportIssueInput {
  return {
    villageId: "village-1",
    category: "water",
    description: "Hand pump broken since the flood",
    photoRefs: ["photo-1.jpg"],
    gps: { lat: 25.6, lng: 85.1 },
  };
}

describe("ReportIssue", () => {
  it("saves the new issue as open and returns its generated id", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issueId).toBe("issue-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.id).toBe("issue-1");
    expect(saved.villageId).toBe("village-1");
    expect(saved.category).toBe("water");
    expect(saved.status).toBe("open");
    expect(saved.reportedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("publishes issue.reported.v1 with the correct payload", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["issue.reported.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "issue.reported.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { issueId: "issue-1", villageId: "village-1", category: "water" },
    });
  });

  it("does not save or publish when the description is empty", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({ ...validInput(), description: "   " });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("does not save or publish when gps is out of range", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({ ...validInput(), gps: { lat: 200, lng: 0 } });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects an invalid villageId without saving or publishing", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({ ...validInput(), villageId: "" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns a fresh id for each reported issue", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("issue");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ReportIssue({ repository, clock, idGenerator, eventPublisher });

    const first = await useCase.execute(validInput());
    const second = await useCase.execute(validInput());

    expect(first.ok && first.value.issueId).toBe("issue-1");
    expect(second.ok && second.value.issueId).toBe("issue-2");
  });
});
