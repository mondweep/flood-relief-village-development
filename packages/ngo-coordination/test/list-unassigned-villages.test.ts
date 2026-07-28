import { describe, expect, it, vi } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { ListUnassignedVillages } from "../src/application/list-unassigned-villages.js";
import type { AssignmentRepository } from "../src/application/ports.js";

describe("ListUnassignedVillages use case", () => {
  it("returns only villages without an active assignment, sorted by severity (critical > severe > moderate > minor)", async () => {
    const findActiveByVillage = vi.fn(async (villageId: string) => {
      if (villageId === "village-assigned") return {} as never;
      return undefined;
    });
    const assignmentRepository: AssignmentRepository = {
      findActiveByVillage,
      findActiveByNgo: vi.fn(),
      save: vi.fn(),
    };
    const useCase = new ListUnassignedVillages({ assignmentRepository });

    const result = await useCase.execute([
      { villageId: "village-minor", severity: "minor" },
      { villageId: "village-critical", severity: "critical" },
      { villageId: "village-assigned", severity: "critical" },
      { villageId: "village-moderate", severity: "moderate" },
      { villageId: "village-severe", severity: "severe" },
    ]);

    expect(unwrap(result)).toEqual([
      { villageId: "village-critical", severity: "critical" },
      { villageId: "village-severe", severity: "severe" },
      { villageId: "village-moderate", severity: "moderate" },
      { villageId: "village-minor", severity: "minor" },
    ]);
    expect(findActiveByVillage).toHaveBeenCalledTimes(5);
  });

  it("returns an empty list when every village already has an active assignment", async () => {
    const assignmentRepository: AssignmentRepository = {
      findActiveByVillage: vi.fn().mockResolvedValue({}),
      findActiveByNgo: vi.fn(),
      save: vi.fn(),
    };
    const useCase = new ListUnassignedVillages({ assignmentRepository });

    const result = await useCase.execute([{ villageId: "village-1", severity: "critical" }]);

    expect(unwrap(result)).toEqual([]);
  });

  it("errs on an invalid villageId", async () => {
    const assignmentRepository: AssignmentRepository = {
      findActiveByVillage: vi.fn(),
      findActiveByNgo: vi.fn(),
      save: vi.fn(),
    };
    const useCase = new ListUnassignedVillages({ assignmentRepository });

    const result = await useCase.execute([{ villageId: "", severity: "minor" }]);

    expect(isErr(result)).toBe(true);
  });
});
