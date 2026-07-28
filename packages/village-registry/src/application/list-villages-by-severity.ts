import { ok, type Result } from "@afrip/shared-kernel";
import type { Severity } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface VillageSummary {
  id: string;
  name: string;
  district: string;
  state: string;
  severity: Severity;
  affectedFamilies: number;
  households: number;
}

export interface ListVillagesBySeverityDeps {
  repository: VillageRepository;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
};

export class ListVillagesBySeverity {
  constructor(private readonly deps: ListVillagesBySeverityDeps) {}

  async execute(): Promise<Result<VillageSummary[]>> {
    const villages = await this.deps.repository.listAll();

    const sorted = [...villages].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );

    return ok(
      sorted.map((village) => ({
        id: village.id,
        name: village.name,
        district: village.district,
        state: village.state,
        severity: village.severity,
        affectedFamilies: village.affectedFamilies,
        households: village.households,
      })),
    );
  }
}
