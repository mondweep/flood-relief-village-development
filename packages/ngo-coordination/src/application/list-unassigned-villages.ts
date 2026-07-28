import { err, ok, villageId as toVillageId, type Result } from "@afrip/shared-kernel";
import type { AssignmentRepository } from "./ports.js";

export type VillageSeverity = "critical" | "severe" | "moderate" | "minor";

const SEVERITY_ORDER: Record<VillageSeverity, number> = {
  critical: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
};

export interface ListUnassignedVillagesDeps {
  assignmentRepository: AssignmentRepository;
}

export interface VillageSeverityInput {
  villageId: string;
  severity: VillageSeverity;
}

/** Cross-context query: caller supplies village/severity pairs, we never call Village Registry ourselves. */
export class ListUnassignedVillages {
  constructor(private readonly deps: ListUnassignedVillagesDeps) {}

  async execute(input: VillageSeverityInput[]): Promise<Result<VillageSeverityInput[]>> {
    const unassigned: VillageSeverityInput[] = [];

    for (const item of input) {
      const villageIdResult = toVillageId(item.villageId);
      if (!villageIdResult.ok) return err(villageIdResult.error);

      const active = await this.deps.assignmentRepository.findActiveByVillage(villageIdResult.value);
      if (!active) unassigned.push(item);
    }

    return ok(unassigned.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]));
  }
}
