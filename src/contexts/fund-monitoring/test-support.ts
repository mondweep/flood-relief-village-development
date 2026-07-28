/**
 * Shared test doubles and builders for the Fund Monitoring context (ADR-004 §2).
 * Not a test file: it only supplies vi.fn() port mocks and pure aggregate builders.
 */
import { vi } from 'vitest';
import {
  type Clock,
  type Money,
  type ProjectId,
  type VillageId,
  asId,
  money,
  unwrap,
} from '../../shared/index.js';
import {
  type EvidenceKind,
  type FundedProject,
  attachEvidence,
  createFundedProject,
  evidenceItem,
  recordExpenditure,
  releaseFunds,
} from './domain/index.js';
import type { ComparableProject, ComparableProjectsQuery, ProjectRepository } from './application/ports.js';

export const PROJECT_ID: ProjectId = asId('11111111-1111-4111-8111-111111111111');
export const OTHER_PROJECT_ID: ProjectId = asId('22222222-2222-4222-8222-222222222222');
export const THIRD_PROJECT_ID: ProjectId = asId('55555555-5555-4555-8555-555555555555');
export const VILLAGE_ID: VillageId = asId('33333333-3333-4333-8333-333333333333');
export const OTHER_VILLAGE_ID: VillageId = asId('44444444-4444-4444-8444-444444444444');

export const SANCTIONED_AT = new Date('2026-01-01T00:00:00.000Z');
export const EXPECTED_COMPLETION_AT = new Date('2026-06-01T00:00:00.000Z');

export const inr = (amountMinor: number): Money => unwrap(money(amountMinor, 'INR'));
export const usd = (amountMinor: number): Money => unwrap(money(amountMinor, 'USD'));

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

export const mockProjectRepository = () => ({
  findById: vi.fn<(id: ProjectId) => Promise<FundedProject | null>>().mockResolvedValue(null),
  findByVillage: vi.fn<(id: VillageId) => Promise<readonly FundedProject[]>>().mockResolvedValue([]),
  save: vi.fn<(project: FundedProject) => Promise<void>>().mockResolvedValue(undefined),
});

export const mockComparableProjectsQuery = () => ({
  findComparable: vi
    .fn<ComparableProjectsQuery['findComparable']>()
    .mockResolvedValue([] as readonly ComparableProject[]),
});

export const mockEventPublisher = () => ({
  publish: vi.fn().mockResolvedValue(undefined),
});

/** Type-level guard that the mocks really satisfy the ports they stand in for. */
export const asProjectRepository = (m: ReturnType<typeof mockProjectRepository>): ProjectRepository => m;
export const asComparableProjectsQuery = (
  m: ReturnType<typeof mockComparableProjectsQuery>,
): ComparableProjectsQuery => m;

export function aProject(overrides: Partial<FundedProject> = {}): FundedProject {
  const base = unwrap(
    createFundedProject({
      id: PROJECT_ID,
      villageId: VILLAGE_ID,
      title: 'Village approach road repair',
      category: 'road',
      fundingSource: 'district',
      sanctioned: inr(1_000_000),
      sanctionedAt: SANCTIONED_AT,
      expectedCompletionAt: EXPECTED_COMPLETION_AT,
    }),
  );
  return { ...base, ...overrides };
}

export const withReleased = (project: FundedProject, amountMinor: number, at = SANCTIONED_AT): FundedProject =>
  unwrap(releaseFunds(project, inr(amountMinor), at));

export const withSpent = (
  project: FundedProject,
  amountMinor: number,
  description = 'materials',
  at = SANCTIONED_AT,
): FundedProject => unwrap(recordExpenditure(project, inr(amountMinor), description, at));

export const withEvidence = (
  project: FundedProject,
  kind: EvidenceKind,
  at = SANCTIONED_AT,
): FundedProject =>
  unwrap(
    attachEvidence(
      project,
      unwrap(
        evidenceItem({
          kind,
          uri: `https://evidence.afrip.test/${kind}.jpg`,
          attachedBy: 'field-officer-7',
          attachedAt: at,
          ...(kind === 'geo_tagged_photo' ? { location: { lat: 26.14, lng: 91.73 } } : {}),
        }),
      ),
    ),
  );

export const comparable = (projectId: ProjectId, spentMinor: number): ComparableProject => ({
  projectId,
  category: 'road',
  spent: inr(spentMinor),
});
