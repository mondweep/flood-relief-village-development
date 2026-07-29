import { ok, type Result } from "@afrip/shared-kernel";
import type { CoordinateSource, Severity } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface VillageSummary {
  id: string;
  name: string;
  district: string;
  state: string;
  severity: Severity;
  affectedFamilies: number;
  households: number;
  /**
   * How this village's position was obtained (ADR 0012 §1) — the provenance
   * WITHOUT the coordinate.
   *
   * On the summary rather than only on the full profile so that "which villages
   * still need a surveyed position?" can be answered from a list query. ADR 0012
   * §Consequences calls that the feature's real payoff: not nicer data entry, but
   * a visible data-quality gap.
   *
   * The lat/lng is deliberately absent from this summary, as it always was.
   * Coordinates locate flood-affected settlements and, through the beneficiary
   * registry, vulnerable people (§Context 4); the provenance says only whether
   * anyone has been there with a device, which is a fact about our records.
   */
  positionSource: CoordinateSource;
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
        positionSource: village.geo.source,
      })),
    );
  }
}
