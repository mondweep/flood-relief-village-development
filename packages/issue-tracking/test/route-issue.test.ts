import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, issueId, unwrap, villageId } from "@afrip/shared-kernel";
import { RouteIssue } from "../src/application/route-issue.js";
import type { AssignmentLookup, IssueRepository } from "../src/application/ports.js";
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

function buildAssignmentLookup(overrides: Partial<AssignmentLookup> = {}): AssignmentLookup {
  return {
    findLeadNgo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeOpenIssue(category: Issue["category"] = "infrastructure"): Issue {
  return unwrap(
    Issue.create({
      id: unwrap(issueId("issue-1")),
      villageId: unwrap(villageId("village-1")),
      category,
      description: "Something is broken",
      photoRefs: [],
      gps: { lat: 25.6, lng: 85.1 },
      reportedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

describe("RouteIssue", () => {
  it("returns an error when the issue does not exist", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(null) });
    const assignmentLookup = buildAssignmentLookup();
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "missing" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("routes a corruption issue to district_administration without consulting the lead NGO", async () => {
    const issue = makeOpenIssue("corruption");
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup({
      findLeadNgo: vi.fn().mockResolvedValue({ ngoId: "ngo-1", name: "Helping Hands" }),
    });
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.partyType).toBe("government_department");
      expect(result.value.party).toBe("district_administration");
    }
    expect(assignmentLookup.findLeadNgo).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledWith(issue);
    expect(issue.status).toBe("routed");
    expect(eventPublisher.eventNames()).toEqual(["issue.routed.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "issue.routed.v1",
      occurredAt: "2026-01-02T00:00:00.000Z",
      payload: { issueId: "issue-1", partyType: "government_department", party: "district_administration" },
    });
  });

  it("routes a health issue to health_department without consulting the lead NGO", async () => {
    const issue = makeOpenIssue("health");
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup();
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.partyType).toBe("government_department");
      expect(result.value.party).toBe("health_department");
    }
    expect(assignmentLookup.findLeadNgo).not.toHaveBeenCalled();
  });

  it("routes an infrastructure issue to the lead NGO returned by the AssignmentLookup port", async () => {
    const issue = makeOpenIssue("infrastructure");
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup({
      findLeadNgo: vi.fn().mockResolvedValue({ ngoId: "ngo-1", name: "Helping Hands" }),
    });
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.partyType).toBe("lead_ngo");
      expect(result.value.party).toBe("ngo-1");
    }
    expect(assignmentLookup.findLeadNgo).toHaveBeenCalledWith(issue.villageId);
  });

  it("falls back to district_administration when infrastructure has no lead NGO", async () => {
    const issue = makeOpenIssue("water");
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup({ findLeadNgo: vi.fn().mockResolvedValue(null) });
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.partyType).toBe("government_department");
      expect(result.value.party).toBe("district_administration");
    }
  });

  it("routes an other-category issue to district_administration without consulting the lead NGO", async () => {
    const issue = makeOpenIssue("other");
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup();
    const clock = new FixedClock(new Date("2026-01-02T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.party).toBe("district_administration");
    expect(assignmentLookup.findLeadNgo).not.toHaveBeenCalled();
  });

  it("does not save or publish when the issue is already routed", async () => {
    const issue = makeOpenIssue("health");
    unwrap(
      issue.route(
        { partyType: "government_department", party: "health_department" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(issue) });
    const assignmentLookup = buildAssignmentLookup();
    const clock = new FixedClock(new Date("2026-01-03T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RouteIssue({ repository, assignmentLookup, clock, eventPublisher });

    const result = await useCase.execute({ issueId: "issue-1" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
