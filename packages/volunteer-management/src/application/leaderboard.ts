import { ok, type Result } from "@afrip/shared-kernel";
import type { VolunteerRepository } from "./ports.js";

export interface LeaderboardEntry {
  volunteerId: string;
  name: string;
  totalHours: number;
}

export interface LeaderboardOutput {
  entries: LeaderboardEntry[];
}

export interface LeaderboardDeps {
  repository: VolunteerRepository;
}

export class Leaderboard {
  constructor(private readonly deps: LeaderboardDeps) {}

  async execute(): Promise<Result<LeaderboardOutput>> {
    const volunteers = await this.deps.repository.listAll();

    const entries: LeaderboardEntry[] = volunteers
      .map((v) => ({
        volunteerId: v.id,
        name: v.name,
        totalHours: v.getTotalHours(),
      }))
      .sort((a, b) => b.totalHours - a.totalHours);

    return ok({ entries });
  }
}
