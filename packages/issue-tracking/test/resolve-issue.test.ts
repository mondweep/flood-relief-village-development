import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, issueId, unwrap, villageId } from "@afrip/shared-kernel";
import { ResolveIssue } from "../src/application/resolve-issue.js";
import type { IssueRepository } from "../src/application/ports.js";
import { Issue } from "../src/domain/issue.js";

function buildRepository(overrides: Partial<IssueRepository> = {}): IssueRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listByVillage: vi.fn().mockResolvedValue([]),
    listByStatus: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeInProgressIssue(): Issue {
  const issue = unwrap(
    Issue.create({
      id: unwrap(issueId("issue-1")),
      villageId: unwrap(villageId("village-1")),
      category: "water",
      description: "Hand pump broken",
      photoRefs: [],
      gps: { lat: 25.6, lng: 85.1 },
      reportedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  unwrap(
    issue.route(
      { partyType: "government_department", party: "district_administration" },
      "2026-01-02T00:00:00.000Z",
    ),
  );
  unwrap(issue.startProgress("2026-01-03T00:00:00.000Z"));
  return issue;
}

describe("ResolveIssue", () => {
  it("returns an error when the issue does not exist", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-04T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ResolveIssue({ repository, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "missing", resolutionNote: "Fixed the pump" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("resolves an in-progress issue, saves it, and publishes issue.resolved.v1", async () => {
    const issue = makeInProgressIssue();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const clock = new FixedClock(new Date("2026-01-04T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ResolveIssue({ repository, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1", resolutionNote: "Fixed the pump" });

    expect(result.ok).toBe(true);
    expect(issue.status).toBe("resolved");
    expect(issue.resolutionNote).toBe("Fixed the pump");
    expect(repository.save).toHaveBeenCalledWith(issue);
    expect(eventPublisher.eventNames()).toEqual(["issue.resolved.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "issue.resolved.v1",
      occurredAt: "2026-01-04T00:00:00.000Z",
      payload: { issueId: "issue-1", resolutionNote: "Fixed the pump" },
    });
  });

  it("does not save or publish when the resolution note is empty", async () => {
    const issue = makeInProgressIssue();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const clock = new FixedClock(new Date("2026-01-04T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ResolveIssue({ repository, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1", resolutionNote: "   " });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("does not save or publish when the issue is not in progress", async () => {
    const issue = unwrap(
      Issue.create({
        id: unwrap(issueId("issue-1")),
        villageId: unwrap(villageId("village-1")),
        category: "water",
        description: "Hand pump broken",
        photoRefs: [],
        gps: { lat: 25.6, lng: 85.1 },
        reportedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const clock = new FixedClock(new Date("2026-01-04T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new ResolveIssue({ repository, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1", resolutionNote: "Fixed the pump" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
