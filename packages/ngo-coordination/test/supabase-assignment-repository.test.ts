import { describe, expect, it } from "vitest";
import { assignmentId, ngoId, unwrap, villageId } from "@afrip/shared-kernel";
import {
  ASSIGNMENTS_TABLE,
  COMMITTEE_MEMBERS_TABLE,
  SupabaseAssignmentRepository,
  fromRow,
  toCommitteeMemberRows,
  toRow,
  type AssignmentRow,
} from "../src/adapters/supabase-assignment-repository.js";
import { VillageAssignment } from "../src/domain/village-assignment.js";
import { createFakeSupabase, type FakeRow } from "./fake-supabase-client.js";

function makeAssignment(id = "assignment-1", village = "village-1", ngo = "ngo-1"): VillageAssignment {
  return VillageAssignment.create({
    id: unwrap(assignmentId(id)),
    villageId: unwrap(villageId(village)),
    ngoId: unwrap(ngoId(ngo)),
    assignedAt: "2026-03-01T00:00:00.000Z",
  });
}

function withCommittee(assignment: VillageAssignment): VillageAssignment {
  unwrap(assignment.addCommitteeMember({ role: "leader", name: "Asha", contact: "+91-99" }));
  unwrap(assignment.addCommitteeMember({ role: "engineer", name: "Ravi" }));
  return assignment;
}

const validRow: AssignmentRow = {
  id: "assignment-1",
  village_id: "village-1",
  ngo_id: "ngo-1",
  status: "active",
  assigned_at: "2026-03-01T00:00:00.000Z",
  retired_at: null,
};

describe("SupabaseAssignmentRepository — schema contract", () => {
  it("writes exactly the columns of ngo_coordination_assignments", async () => {
    const fake = createFakeSupabase();
    await new SupabaseAssignmentRepository(fake.client).save(makeAssignment());

    const upsert = fake.callTo(ASSIGNMENTS_TABLE, "upsert");
    expect(Object.keys(upsert.payload as FakeRow).sort()).toEqual([
      "assigned_at",
      "id",
      "ngo_id",
      "retired_at",
      "status",
      "village_id",
    ]);
    expect(upsert.payload).toEqual(validRow);
  });

  it("writes exactly the columns of ngo_coordination_committee_members", async () => {
    const fake = createFakeSupabase();
    await new SupabaseAssignmentRepository(fake.client).save(withCommittee(makeAssignment()));

    const insert = fake.callTo(COMMITTEE_MEMBERS_TABLE, "insert");
    const rows = insert.payload as FakeRow[];
    expect(Object.keys(rows[0] as FakeRow).sort()).toEqual([
      "assignment_id",
      "contact",
      "name",
      "role",
    ]);
    expect(rows).toEqual([
      { assignment_id: "assignment-1", role: "leader", name: "Asha", contact: "+91-99" },
      { assignment_id: "assignment-1", role: "engineer", name: "Ravi", contact: null },
    ]);
  });

  it("persists a retired assignment with status 'retired'", async () => {
    const assignment = makeAssignment();
    unwrap(assignment.retire());
    const fake = createFakeSupabase();
    await new SupabaseAssignmentRepository(fake.client).save(assignment);
    expect((fake.callTo(ASSIGNMENTS_TABLE, "upsert").payload as FakeRow)["status"]).toBe("retired");
  });

  it("reconciles the committee by clearing it before re-inserting", async () => {
    const fake = createFakeSupabase();
    await new SupabaseAssignmentRepository(fake.client).save(withCommittee(makeAssignment()));

    expect(fake.callTo(COMMITTEE_MEMBERS_TABLE, "delete").filters).toEqual([
      { type: "eq", column: "assignment_id", value: "assignment-1" },
    ]);
    expect(fake.calls.map((c) => `${c.operation} ${c.table}`)).toEqual([
      `upsert ${ASSIGNMENTS_TABLE}`,
      `delete ${COMMITTEE_MEMBERS_TABLE}`,
      `insert ${COMMITTEE_MEMBERS_TABLE}`,
    ]);
  });
});

describe("SupabaseAssignmentRepository — active filtering", () => {
  it("filters findActiveByVillage on village_id AND status='active'", async () => {
    const fake = createFakeSupabase({ tables: { [ASSIGNMENTS_TABLE]: [validRow as unknown as FakeRow] } });
    await new SupabaseAssignmentRepository(fake.client).findActiveByVillage(
      unwrap(villageId("village-1")),
    );

    expect(fake.callTo(ASSIGNMENTS_TABLE, "select").filters).toEqual([
      { type: "eq", column: "village_id", value: "village-1" },
      { type: "eq", column: "status", value: "active" },
    ]);
  });

  it("filters findActiveByNgo on ngo_id AND status='active'", async () => {
    const fake = createFakeSupabase({ tables: { [ASSIGNMENTS_TABLE]: [validRow as unknown as FakeRow] } });
    await new SupabaseAssignmentRepository(fake.client).findActiveByNgo(unwrap(ngoId("ngo-1")));

    expect(fake.callTo(ASSIGNMENTS_TABLE, "select").filters).toEqual([
      { type: "eq", column: "ngo_id", value: "ngo-1" },
      { type: "eq", column: "status", value: "active" },
    ]);
  });

  it("does not return a retired assignment for a village", async () => {
    const fake = createFakeSupabase({
      tables: { [ASSIGNMENTS_TABLE]: [{ ...validRow, status: "retired" } as FakeRow] },
    });
    const found = await new SupabaseAssignmentRepository(fake.client).findActiveByVillage(
      unwrap(villageId("village-1")),
    );
    expect(found).toBeUndefined();
  });

  it("returns only the active assignments of an NGO", async () => {
    const fake = createFakeSupabase({
      tables: {
        [ASSIGNMENTS_TABLE]: [
          validRow as unknown as FakeRow,
          { ...validRow, id: "assignment-2", village_id: "village-2" } as FakeRow,
          { ...validRow, id: "assignment-3", village_id: "village-3", status: "retired" } as FakeRow,
        ],
      },
    });
    const found = await new SupabaseAssignmentRepository(fake.client).findActiveByNgo(
      unwrap(ngoId("ngo-1")),
    );
    expect(found.map((a) => a.id)).toEqual(["assignment-1", "assignment-2"]);
  });

  it("skips the committee read when no assignment matches", async () => {
    const fake = createFakeSupabase({ tables: { [ASSIGNMENTS_TABLE]: [] } });
    expect(
      await new SupabaseAssignmentRepository(fake.client).findActiveByNgo(unwrap(ngoId("ngo-1"))),
    ).toEqual([]);
    expect(fake.callsTo(COMMITTEE_MEMBERS_TABLE)).toHaveLength(0);
  });
});

describe("SupabaseAssignmentRepository — round trip", () => {
  it("preserves every field and the committee", async () => {
    const original = withCommittee(makeAssignment());
    const fake = createFakeSupabase({
      tables: {
        [ASSIGNMENTS_TABLE]: [toRow(original) as unknown as FakeRow],
        [COMMITTEE_MEMBERS_TABLE]: toCommitteeMemberRows(original).map((row, index) => ({
          ...row,
          id: index + 1,
        })) as unknown as FakeRow[],
      },
    });

    const found = await new SupabaseAssignmentRepository(fake.client).findActiveByVillage(
      original.villageId,
    );

    expect(found?.id).toBe(original.id);
    expect(found?.villageId).toBe(original.villageId);
    expect(found?.ngoId).toBe(original.ngoId);
    expect(found?.assignedAt).toBe(original.assignedAt);
    expect(found?.status).toBe("active");
    expect(found?.committee).toEqual(original.committee);
  });

  it("rehydrates a retired assignment with its committee intact", () => {
    const retired = withCommittee(makeAssignment());
    unwrap(retired.retire());

    const rebuilt = fromRow(toRow(retired), toCommitteeMemberRows(retired));

    expect(rebuilt.status).toBe("retired");
    expect(rebuilt.committee).toEqual(retired.committee);
    // Still retired, so it stays closed to further edits.
    expect(rebuilt.addCommitteeMember({ role: "doctor", name: "Meena" }).ok).toBe(false);
  });

  it("groups committee members by assignment across several assignments", async () => {
    const fake = createFakeSupabase({
      tables: {
        [ASSIGNMENTS_TABLE]: [
          validRow as unknown as FakeRow,
          { ...validRow, id: "assignment-2", village_id: "village-2" } as FakeRow,
        ],
        [COMMITTEE_MEMBERS_TABLE]: [
          { id: 1, assignment_id: "assignment-1", role: "leader", name: "Asha", contact: null },
          { id: 2, assignment_id: "assignment-2", role: "doctor", name: "Meena", contact: null },
        ],
      },
    });

    const found = await new SupabaseAssignmentRepository(fake.client).findActiveByNgo(
      unwrap(ngoId("ngo-1")),
    );

    expect(found[0]?.committee.map((m) => m.role)).toEqual(["leader"]);
    expect(found[1]?.committee.map((m) => m.role)).toEqual(["doctor"]);
    expect(fake.callTo(COMMITTEE_MEMBERS_TABLE, "select").filters).toEqual([
      { type: "in", column: "assignment_id", value: ["assignment-1", "assignment-2"] },
    ]);
  });
});

describe("SupabaseAssignmentRepository — error surfacing", () => {
  it("throws naming the table when the assignment select fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: ASSIGNMENTS_TABLE, operation: "select", message: "statement timeout" },
    });
    await expect(
      new SupabaseAssignmentRepository(fake.client).findActiveByVillage(unwrap(villageId("v"))),
    ).rejects.toThrow(/select on ngo_coordination_assignments failed: statement timeout/);
  });

  it("throws naming the committee table when its insert fails", async () => {
    const fake = createFakeSupabase({
      failOn: { table: COMMITTEE_MEMBERS_TABLE, operation: "insert" },
    });
    await expect(
      new SupabaseAssignmentRepository(fake.client).save(withCommittee(makeAssignment())),
    ).rejects.toThrow(/insert on ngo_coordination_committee_members failed/);
  });

  it("throws when the unique-active-assignment index rejects the upsert", async () => {
    const fake = createFakeSupabase({
      failOn: {
        table: ASSIGNMENTS_TABLE,
        operation: "upsert",
        message: 'duplicate key value violates unique constraint "one_active_assignment_per_village"',
      },
    });
    await expect(
      new SupabaseAssignmentRepository(fake.client).save(makeAssignment()),
    ).rejects.toThrow(/ngo_coordination_assignments.*one_active_assignment_per_village/s);
  });
});

describe("SupabaseAssignmentRepository — corrupt rows", () => {
  it("throws on an unknown status", () => {
    expect(() => fromRow({ ...validRow, status: "paused" }, [])).toThrow(
      /corrupt row in ngo_coordination_assignments \(id=assignment-1\).*status/s,
    );
  });

  it("throws on a blank village id", () => {
    expect(() => fromRow({ ...validRow, village_id: " " }, [])).toThrow(
      /corrupt row in ngo_coordination_assignments/,
    );
  });

  it("throws on an empty assigned_at", () => {
    expect(() => fromRow({ ...validRow, assigned_at: "" }, [])).toThrow(
      /corrupt row in ngo_coordination_assignments \(id=assignment-1\).*assigned_at/s,
    );
  });

  it("throws when the committee has two members in the same role", () => {
    expect(() =>
      fromRow(validRow, [
        { assignment_id: "assignment-1", role: "leader", name: "Asha", contact: null },
        { assignment_id: "assignment-1", role: "leader", name: "Bina", contact: null },
      ]),
    ).toThrow(/corrupt row in ngo_coordination_committee_members \(id=assignment-1\).*leader/s);
  });

  it("surfaces a corrupt row through findActiveByVillage", async () => {
    const fake = createFakeSupabase({
      tables: { [ASSIGNMENTS_TABLE]: [{ ...validRow, ngo_id: "  " } as FakeRow] },
    });
    await expect(
      new SupabaseAssignmentRepository(fake.client).findActiveByVillage(
        unwrap(villageId("village-1")),
      ),
    ).rejects.toThrow(/corrupt row in ngo_coordination_assignments \(id=assignment-1\)/);
  });
});
