import { Money, projectId, unwrap, villageId } from "@afrip/shared-kernel";
import { vi } from "vitest";
import type { FundedProject, ProjectCategory, FundSource } from "../src/domain/funded-project.js";
import { FundedProject as Project } from "../src/domain/funded-project.js";

export const NOW = new Date("2026-07-28T10:00:00.000Z");

export interface MakeProjectOverrides {
  id?: string;
  villageId?: string;
  name?: string;
  category?: ProjectCategory;
  fundSource?: FundSource;
  sanctionedMinor?: number;
}

export function makeProject(overrides: MakeProjectOverrides = {}): FundedProject {
  return unwrap(
    Project.sanction({
      id: unwrap(projectId(overrides.id ?? "proj-1")),
      villageId: unwrap(villageId(overrides.villageId ?? "vil-1")),
      name: overrides.name ?? "Bridge rebuild",
      category: overrides.category ?? "bridge",
      fundSource: overrides.fundSource ?? "district",
      sanctioned: unwrap(Money.of(overrides.sanctionedMinor ?? 1_000_000)),
    }),
  );
}

export function money(amountMinor: number): Money {
  return unwrap(Money.of(amountMinor));
}

/** vi.fn() mock of the ProjectRepository port. */
export function repositoryMock(project: FundedProject | null = null) {
  return {
    findById: vi.fn().mockResolvedValue(project),
    save: vi.fn().mockResolvedValue(undefined),
    listByVillage: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
  };
}

/** vi.fn() mock of the EventPublisher port. */
export function publisherMock() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

/** vi.fn() mock of the Clock port. */
export function clockMock(now: Date = NOW) {
  return { now: vi.fn(() => now) };
}

/** vi.fn() mock of the IdGenerator port. */
export function idGeneratorMock(ids: string[] = ["proj-1"]) {
  let i = 0;
  return { next: vi.fn(() => ids[i++] ?? `generated-${i}`) };
}
