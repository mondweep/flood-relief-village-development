import { describe, expect, it } from "vitest";
import { issueId, unwrap, villageId } from "@afrip/shared-kernel";
import { Issue, type IssueRestoreProps } from "../src/domain/issue.js";

function restoreProps(overrides: Partial<IssueRestoreProps> = {}): IssueRestoreProps {
  return {
    id: unwrap(issueId("issue-1")),
    villageId: unwrap(villageId("village-1")),
    category: "infrastructure",
    description: "Bridge collapsed near the school",
    photoRefs: ["photo-1.jpg"],
    gps: { lat: 25.6, lng: 85.1 },
    reportedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

const routed: Partial<IssueRestoreProps> = {
  status: "routed",
  routedTo: { partyType: "lead_ngo", party: "ngo-1" },
};

const done: Partial<IssueRestoreProps> = {
  status: "resolved",
  routedTo: { partyType: "lead_ngo", party: "ngo-1" },
  resolvedAt: "2026-01-10T00:00:00.000Z",
  resolutionNote: "Temporary bridge in place",
};

describe("Issue.restore", () => {
  it("rebuilds an open issue", () => {
    const issue = unwrap(Issue.restore(restoreProps()));
    expect(issue.id).toBe("issue-1");
    expect(issue.status).toBe("open");
    expect(issue.routedTo).toBeUndefined();
    expect(issue.photoRefs).toEqual(["photo-1.jpg"]);
  });

  it("rebuilds an issue mid-lifecycle with its routing decision", () => {
    const issue = unwrap(Issue.restore(restoreProps(routed)));
    expect(issue.status).toBe("routed");
    expect(issue.routedTo).toEqual({ partyType: "lead_ngo", party: "ngo-1" });
  });

  it("rebuilds a resolved issue with its resolution", () => {
    const issue = unwrap(Issue.restore(restoreProps(done)));
    expect(issue.status).toBe("resolved");
    expect(issue.resolvedAt).toBe("2026-01-10T00:00:00.000Z");
    expect(issue.resolutionNote).toBe("Temporary bridge in place");
  });

  it("restores the optional in-memory timestamps when they are supplied", () => {
    const issue = unwrap(
      Issue.restore(
        restoreProps({
          ...done,
          status: "verified",
          routedAt: "2026-01-02T00:00:00.000Z",
          progressStartedAt: "2026-01-03T00:00:00.000Z",
          verifiedAt: "2026-01-11T00:00:00.000Z",
        }),
      ),
    );
    expect(issue.routedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(issue.progressStartedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(issue.verifiedAt).toBe("2026-01-11T00:00:00.000Z");
  });

  it("still enforces the create() invariants", () => {
    expect(Issue.restore(restoreProps({ description: "  " })).ok).toBe(false);
    expect(Issue.restore(restoreProps({ category: "vibes" as never })).ok).toBe(false);
    expect(Issue.restore(restoreProps({ gps: { lat: 120, lng: 0 } })).ok).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = Issue.restore(restoreProps({ ...routed, status: "escalated" as never }));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/invalid status: escalated/);
  });

  it("rejects a non-open status with no routing decision", () => {
    for (const status of ["routed", "in_progress", "resolved", "verified"] as const) {
      const result = Issue.restore(restoreProps({ status }));
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toMatch(/must have a routing decision/);
    }
  });

  it("rejects an open issue that carries a routing decision", () => {
    const result = Issue.restore(
      restoreProps({ routedTo: { partyType: "lead_ngo", party: "ngo-1" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/must not have a routing decision/);
  });

  it("rejects an invalid or empty routed party", () => {
    expect(
      Issue.restore(
        restoreProps({ status: "routed", routedTo: { partyType: "mayor" as never, party: "x" } }),
      ).ok,
    ).toBe(false);
    expect(
      Issue.restore(
        restoreProps({ status: "routed", routedTo: { partyType: "lead_ngo", party: " " } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a resolved issue missing its resolvedAt or resolutionNote", () => {
    const withoutNote = Issue.restore(restoreProps({ ...done, resolutionNote: undefined }));
    expect(withoutNote.ok).toBe(false);
    expect(withoutNote.ok ? "" : withoutNote.error).toMatch(/resolutionNote/);

    const withoutAt = Issue.restore(restoreProps({ ...done, resolvedAt: undefined }));
    expect(withoutAt.ok).toBe(false);
    expect(withoutAt.ok ? "" : withoutAt.error).toMatch(/resolvedAt/);

    expect(Issue.restore(restoreProps({ ...done, resolutionNote: "   " })).ok).toBe(false);
  });

  it("rejects an unresolved issue that carries a resolution", () => {
    const result = Issue.restore(
      restoreProps({ ...routed, resolvedAt: "2026-01-10T00:00:00.000Z" }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/must not have a resolvedAt/);
  });

  it("returns a live aggregate whose transitions continue from the restored status", () => {
    const issue = unwrap(Issue.restore(restoreProps(routed)));
    expect(issue.route({ partyType: "lead_ngo", party: "ngo-2" }, "x").ok).toBe(false);
    expect(issue.resolve("done", "2026-01-05T00:00:00.000Z").ok).toBe(false);
    expect(issue.startProgress("2026-01-05T00:00:00.000Z").ok).toBe(true);
    expect(issue.status).toBe("in_progress");
  });

  it("copies photo refs so later mutation of the caller's array cannot leak in", () => {
    const props = restoreProps();
    const issue = unwrap(Issue.restore(props));
    props.photoRefs.push("sneaky.jpg");
    expect(issue.photoRefs).toEqual(["photo-1.jpg"]);
  });
});
