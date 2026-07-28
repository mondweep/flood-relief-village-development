import { describe, expect, it } from "vitest";
import { unwrap, villageId, issueId } from "@afrip/shared-kernel";
import { Issue, type IssueCreateProps } from "../src/domain/issue.js";

function baseProps(): IssueCreateProps {
  return {
    id: unwrap(issueId("issue-1")),
    villageId: unwrap(villageId("village-1")),
    category: "infrastructure",
    description: "Bridge collapsed near the school",
    photoRefs: ["photo-1.jpg"],
    gps: { lat: 25.6, lng: 85.1 },
    reportedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Issue.create", () => {
  it("creates an open issue with the given props and no routing yet", () => {
    const result = Issue.create(baseProps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("open");
    expect(result.value.category).toBe("infrastructure");
    expect(result.value.description).toBe("Bridge collapsed near the school");
    expect(result.value.photoRefs).toEqual(["photo-1.jpg"]);
    expect(result.value.gps).toEqual({ lat: 25.6, lng: 85.1 });
    expect(result.value.reportedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.value.routedTo).toBeUndefined();
  });

  it("accepts an empty photoRefs array", () => {
    const result = Issue.create({ ...baseProps(), photoRefs: [] });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty description", () => {
    const result = Issue.create({ ...baseProps(), description: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid category", () => {
    const result = Issue.create({ ...baseProps(), category: "flooding" as never });
    expect(result.ok).toBe(false);
  });

  it("rejects latitude below -90", () => {
    const result = Issue.create({ ...baseProps(), gps: { lat: -91, lng: 0 } });
    expect(result.ok).toBe(false);
  });

  it("rejects latitude above 90", () => {
    const result = Issue.create({ ...baseProps(), gps: { lat: 91, lng: 0 } });
    expect(result.ok).toBe(false);
  });

  it("rejects longitude below -180", () => {
    const result = Issue.create({ ...baseProps(), gps: { lat: 0, lng: -181 } });
    expect(result.ok).toBe(false);
  });

  it("rejects longitude above 180", () => {
    const result = Issue.create({ ...baseProps(), gps: { lat: 0, lng: 181 } });
    expect(result.ok).toBe(false);
  });

  it("accepts boundary gps values", () => {
    const result = Issue.create({ ...baseProps(), gps: { lat: -90, lng: 180 } });
    expect(result.ok).toBe(true);
  });
});

describe("Issue status machine", () => {
  function open(): Issue {
    return unwrap(Issue.create(baseProps()));
  }

  it("routes an open issue and records the routing timestamp", () => {
    const issue = open();
    const result = issue.route(
      { partyType: "government_department", party: "district_administration" },
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    expect(issue.status).toBe("routed");
    expect(issue.routedTo).toEqual({ partyType: "government_department", party: "district_administration" });
    expect(issue.routedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects routing an issue that is not open", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    const result = issue.route(
      { partyType: "government_department", party: "district_administration" },
      "2026-01-03T00:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    expect(issue.routedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("starts progress on a routed issue", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    const result = issue.startProgress("2026-01-03T00:00:00.000Z");
    expect(result.ok).toBe(true);
    expect(issue.status).toBe("in_progress");
    expect(issue.progressStartedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("rejects starting progress on an open issue (no skipping routed)", () => {
    const issue = open();
    const result = issue.startProgress("2026-01-02T00:00:00.000Z");
    expect(result.ok).toBe(false);
    expect(issue.status).toBe("open");
  });

  it("resolves an in-progress issue with a resolution note", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    unwrap(issue.startProgress("2026-01-03T00:00:00.000Z"));
    const result = issue.resolve("Bridge repaired", "2026-01-04T00:00:00.000Z");
    expect(result.ok).toBe(true);
    expect(issue.status).toBe("resolved");
    expect(issue.resolutionNote).toBe("Bridge repaired");
    expect(issue.resolvedAt).toBe("2026-01-04T00:00:00.000Z");
  });

  it("rejects an empty resolution note", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    unwrap(issue.startProgress("2026-01-03T00:00:00.000Z"));
    const result = issue.resolve("  ", "2026-01-04T00:00:00.000Z");
    expect(result.ok).toBe(false);
    expect(issue.status).toBe("in_progress");
  });

  it("rejects resolving an issue that is not in progress (no skipping)", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    const result = issue.resolve("Bridge repaired", "2026-01-04T00:00:00.000Z");
    expect(result.ok).toBe(false);
    expect(issue.status).toBe("routed");
  });

  it("verifies a resolved issue", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    unwrap(issue.startProgress("2026-01-03T00:00:00.000Z"));
    unwrap(issue.resolve("Bridge repaired", "2026-01-04T00:00:00.000Z"));
    const result = issue.verify("2026-01-05T00:00:00.000Z");
    expect(result.ok).toBe(true);
    expect(issue.status).toBe("verified");
    expect(issue.verifiedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("rejects verifying an issue that is not resolved", () => {
    const issue = open();
    const result = issue.verify("2026-01-05T00:00:00.000Z");
    expect(result.ok).toBe(false);
    expect(issue.status).toBe("open");
  });

  it("rejects going backwards once verified", () => {
    const issue = open();
    unwrap(
      issue.route(
        { partyType: "government_department", party: "district_administration" },
        "2026-01-02T00:00:00.000Z",
      ),
    );
    unwrap(issue.startProgress("2026-01-03T00:00:00.000Z"));
    unwrap(issue.resolve("Bridge repaired", "2026-01-04T00:00:00.000Z"));
    unwrap(issue.verify("2026-01-05T00:00:00.000Z"));

    const reRoute = issue.route(
      { partyType: "government_department", party: "district_administration" },
      "2026-01-06T00:00:00.000Z",
    );
    expect(reRoute.ok).toBe(false);
    expect(issue.status).toBe("verified");
  });
});
