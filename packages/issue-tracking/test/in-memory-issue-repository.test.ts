import { describe, expect, it } from "vitest";
import { issueId, unwrap, villageId } from "@afrip/shared-kernel";
import { InMemoryIssueRepository } from "../src/adapters/in-memory-issue-repository.js";
import { Issue } from "../src/domain/issue.js";

function makeIssue(id: string, village: string, category: Issue["category"] = "water"): Issue {
  return unwrap(
    Issue.create({
      id: unwrap(issueId(id)),
      villageId: unwrap(villageId(village)),
      category,
      description: "Hand pump broken",
      photoRefs: [],
      gps: { lat: 25.6, lng: 85.1 },
      reportedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

describe("InMemoryIssueRepository", () => {
  it("returns null when an issue id is not found", async () => {
    const repository = new InMemoryIssueRepository();
    const result = await repository.findById(unwrap(issueId("missing")));
    expect(result).toBeNull();
  });

  it("saves and finds an issue by id", async () => {
    const repository = new InMemoryIssueRepository();
    const issue = makeIssue("issue-1", "village-1");

    await repository.save(issue);
    const found = await repository.findById(issue.id);

    expect(found).toBe(issue);
  });

  it("overwrites the existing entry when saving an issue with the same id", async () => {
    const repository = new InMemoryIssueRepository();
    const issue = makeIssue("issue-1", "village-1");
    await repository.save(issue);

    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    await repository.save(issue);

    const found = await repository.findById(issue.id);
    expect(found?.status).toBe("routed");
  });

  it("lists issues by village", async () => {
    const repository = new InMemoryIssueRepository();
    const first = makeIssue("issue-1", "village-1");
    const second = makeIssue("issue-2", "village-2");
    const third = makeIssue("issue-3", "village-1");
    await repository.save(first);
    await repository.save(second);
    await repository.save(third);

    const forVillage1 = await repository.listByVillage(first.villageId);
    expect(forVillage1).toHaveLength(2);
    expect(forVillage1).toEqual(expect.arrayContaining([first, third]));
  });

  it("lists issues by status", async () => {
    const repository = new InMemoryIssueRepository();
    const open = makeIssue("issue-1", "village-1");
    const routed = makeIssue("issue-2", "village-1");
    unwrap(
      routed.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    await repository.save(open);
    await repository.save(routed);

    const openIssues = await repository.listByStatus("open");
    const routedIssues = await repository.listByStatus("routed");

    expect(openIssues).toEqual([open]);
    expect(routedIssues).toEqual([routed]);
  });
});
