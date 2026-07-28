import { describe, expect, it } from "vitest";
import { issueId, unwrap, villageId } from "@afrip/shared-kernel";
import {
  ISSUES_TABLE,
  SupabaseIssueRepository,
  fromRow,
  toRow,
  type IssueRow,
} from "../src/adapters/supabase-issue-repository.js";
import { Issue } from "../src/domain/issue.js";
import { createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeIssue(id = "issue-1", village = "village-1"): Issue {
  return unwrap(
    Issue.create({
      id: unwrap(issueId(id)),
      villageId: unwrap(villageId(village)),
      category: "water",
      description: "Handpump collapsed after the flood",
      photoRefs: ["photo-a", "photo-b"],
      gps: { lat: 25.6, lng: 85.1 },
      reportedAt: "2026-03-01T00:00:00.000Z",
    }),
  );
}

function resolved(issue: Issue): Issue {
  unwrap(issue.route({ partyType: "lead_ngo", party: "ngo-1" }, "2026-03-02T00:00:00.000Z"));
  unwrap(issue.startProgress("2026-03-03T00:00:00.000Z"));
  unwrap(issue.resolve("New handpump installed", "2026-03-10T00:00:00.000Z"));
  return issue;
}

const openRow: IssueRow = {
  id: "issue-1",
  village_id: "village-1",
  category: "water",
  description: "Handpump collapsed after the flood",
  photo_refs: ["photo-a", "photo-b"],
  lat: 25.6,
  lng: 85.1,
  status: "open",
  routed_party_type: null,
  routed_party: null,
  reported_at: "2026-03-01T00:00:00.000Z",
  resolved_at: null,
  resolution_note: null,
};

describe("SupabaseIssueRepository — schema contract", () => {
  it("writes exactly the columns of issue_tracking_issues", async () => {
    const fake = createFakeSupabase();
    await new SupabaseIssueRepository(fake.client).save(makeIssue());

    const upsert = fake.callTo(ISSUES_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "category",
      "description",
      "id",
      "lat",
      "lng",
      "photo_refs",
      "reported_at",
      "resolution_note",
      "routed_party",
      "routed_party_type",
      "status",
      "village_id",
      "resolved_at",
    ].sort());
    expect(upsert.payload).toEqual(openRow);
  });

  it("splits the routing decision across routed_party_type and routed_party", async () => {
    const fake = createFakeSupabase();
    await new SupabaseIssueRepository(fake.client).save(resolved(makeIssue()));

    expect(fake.callTo(ISSUES_TABLE, "upsert").payload).toEqual({
      ...openRow,
      status: "resolved",
      routed_party_type: "lead_ngo",
      routed_party: "ngo-1",
      resolved_at: "2026-03-10T00:00:00.000Z",
      resolution_note: "New handpump installed",
    });
  });

  it("writes an unset routing decision and resolution as SQL NULL", async () => {
    const fake = createFakeSupabase();
    await new SupabaseIssueRepository(fake.client).save(makeIssue());
    const payload = fake.callTo(ISSUES_TABLE, "upsert").payload as FakeRow;
    expect(payload["routed_party_type"]).toBeNull();
    expect(payload["routed_party"]).toBeNull();
    expect(payload["resolved_at"]).toBeNull();
    expect(payload["resolution_note"]).toBeNull();
  });

  it("copies photo refs rather than aliasing the aggregate's array", () => {
    const issue = makeIssue();
    toRow(issue).photo_refs.push("mutated");
    expect(issue.photoRefs).toEqual(["photo-a", "photo-b"]);
  });
});

describe("SupabaseIssueRepository — round trip", () => {
  it("preserves every persisted field of an open issue", async () => {
    const original = makeIssue();
    const fake = createFakeSupabase({
      tables: { [ISSUES_TABLE]: [toRow(original) as unknown as FakeRow] },
    });

    const found = await new SupabaseIssueRepository(fake.client).findById(original.id);

    expect(found?.id).toBe(original.id);
    expect(found?.villageId).toBe(original.villageId);
    expect(found?.category).toBe(original.category);
    expect(found?.description).toBe(original.description);
    expect(found?.photoRefs).toEqual(original.photoRefs);
    expect(found?.gps).toEqual(original.gps);
    expect(found?.reportedAt).toBe(original.reportedAt);
    expect(found?.status).toBe("open");
    expect(found?.routedTo).toBeUndefined();
  });

  it("preserves the lifecycle of a resolved issue", async () => {
    const original = resolved(makeIssue());
    const fake = createFakeSupabase({
      tables: { [ISSUES_TABLE]: [toRow(original) as unknown as FakeRow] },
    });

    const found = await new SupabaseIssueRepository(fake.client).findById(original.id);

    expect(found?.status).toBe("resolved");
    expect(found?.routedTo).toEqual({ partyType: "lead_ngo", party: "ngo-1" });
    expect(found?.resolvedAt).toBe(original.resolvedAt);
    expect(found?.resolutionNote).toBe(original.resolutionNote);
  });

  it("keeps a rehydrated issue usable: only the next legal transition is allowed", () => {
    const rebuilt = fromRow(toRow(resolved(makeIssue())));
    expect(rebuilt.startProgress("2026-03-11T00:00:00.000Z").ok).toBe(false);
    expect(rebuilt.verify("2026-03-11T00:00:00.000Z").ok).toBe(true);
    expect(rebuilt.status).toBe("verified");
  });

  it("returns null for an unknown id", async () => {
    const fake = createFakeSupabase({ tables: { [ISSUES_TABLE]: [] } });
    expect(
      await new SupabaseIssueRepository(fake.client).findById(unwrap(issueId("missing"))),
    ).toBeNull();
  });
});

describe("SupabaseIssueRepository — filters", () => {
  it("filters listByVillage on village_id, oldest first", async () => {
    const fake = createFakeSupabase({
      tables: {
        [ISSUES_TABLE]: [
          { ...openRow, id: "issue-2", reported_at: "2026-03-05T00:00:00.000Z" },
          openRow as unknown as FakeRow,
          { ...openRow, id: "issue-3", village_id: "village-2" },
        ],
      },
    });

    const found = await new SupabaseIssueRepository(fake.client).listByVillage(
      unwrap(villageId("village-1")),
    );

    expect(found.map((i) => i.id)).toEqual(["issue-1", "issue-2"]);
    const select = fake.callTo(ISSUES_TABLE, "select");
    expect(select.filters).toEqual([{ type: "eq", column: "village_id", value: "village-1" }]);
    expect(select.orders).toEqual([{ column: "reported_at", ascending: true }]);
  });

  it("filters listByStatus on status", async () => {
    const fake = createFakeSupabase({
      tables: {
        [ISSUES_TABLE]: [
          openRow as unknown as FakeRow,
          {
            ...openRow,
            id: "issue-2",
            status: "verified",
            routed_party_type: "government_department",
            routed_party: "PHED",
            resolved_at: "2026-03-10T00:00:00.000Z",
            resolution_note: "done",
          },
        ],
      },
    });

    const found = await new SupabaseIssueRepository(fake.client).listByStatus("verified");

    expect(found.map((i) => i.id)).toEqual(["issue-2"]);
    expect(fake.callTo(ISSUES_TABLE, "select").filters).toEqual([
      { type: "eq", column: "status", value: "verified" },
    ]);
  });
});

describe("SupabaseIssueRepository — error surfacing", () => {
  it("throws naming the table when the select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: ISSUES_TABLE, operation: "select", message: "row level security" },
    });
    await expect(
      new SupabaseIssueRepository(fake.client).findById(unwrap(issueId("issue-1"))),
    ).rejects.toThrow(/select on issue_tracking_issues failed: row level security/);
  });

  it("throws naming the table when listByStatus fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: ISSUES_TABLE, operation: "select" } });
    await expect(new SupabaseIssueRepository(fake.client).listByStatus("open")).rejects.toThrow(
      /issue_tracking_issues/,
    );
  });

  it("throws naming the table when the upsert fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: ISSUES_TABLE, operation: "upsert" } });
    await expect(new SupabaseIssueRepository(fake.client).save(makeIssue())).rejects.toThrow(
      /upsert on issue_tracking_issues failed/,
    );
  });
});

describe("SupabaseIssueRepository — corrupt rows", () => {
  it("throws on an unknown category", () => {
    expect(() => fromRow({ ...openRow, category: "vibes" })).toThrow(
      /corrupt row in issue_tracking_issues \(id=issue-1\).*category/s,
    );
  });

  it("throws on an out-of-range latitude", () => {
    expect(() => fromRow({ ...openRow, lat: 120 })).toThrow(
      /corrupt row in issue_tracking_issues \(id=issue-1\).*lat/s,
    );
  });

  it("throws on an unknown status", () => {
    expect(() =>
      fromRow({ ...openRow, status: "escalated", routed_party_type: "lead_ngo", routed_party: "n" }),
    ).toThrow(/corrupt row in issue_tracking_issues \(id=issue-1\).*status/s);
  });

  it("throws when a routed issue has no routing decision", () => {
    expect(() => fromRow({ ...openRow, status: "routed" })).toThrow(
      /corrupt row in issue_tracking_issues.*routing decision/s,
    );
  });

  it("throws when an open issue carries a routing decision", () => {
    expect(() =>
      fromRow({ ...openRow, routed_party_type: "lead_ngo", routed_party: "ngo-1" }),
    ).toThrow(/corrupt row in issue_tracking_issues.*must not have a routing decision/s);
  });

  it("throws when only one half of the routing pair is set", () => {
    expect(() => fromRow({ ...openRow, routed_party_type: "lead_ngo" })).toThrow(
      /routed_party_type and routed_party must both be set or both be null/,
    );
  });

  it("throws when a resolved issue has no resolution note", () => {
    expect(() =>
      fromRow({
        ...openRow,
        status: "resolved",
        routed_party_type: "lead_ngo",
        routed_party: "ngo-1",
        resolved_at: "2026-03-10T00:00:00.000Z",
      }),
    ).toThrow(/corrupt row in issue_tracking_issues.*resolutionNote/s);
  });

  it("throws when a non-resolved issue carries a resolution", () => {
    expect(() =>
      fromRow({
        ...openRow,
        status: "in_progress",
        routed_party_type: "lead_ngo",
        routed_party: "ngo-1",
        resolved_at: "2026-03-10T00:00:00.000Z",
        resolution_note: "done",
      }),
    ).toThrow(/corrupt row in issue_tracking_issues.*must not have a resolvedAt/s);
  });

  it("surfaces a corrupt row through listByStatus", async () => {
    const fake = createFakeSupabase({
      tables: { [ISSUES_TABLE]: [{ ...openRow, description: "   " } as FakeRow] },
    });
    await expect(new SupabaseIssueRepository(fake.client).listByStatus("open")).rejects.toThrow(
      /corrupt row in issue_tracking_issues \(id=issue-1\)/,
    );
  });
});
