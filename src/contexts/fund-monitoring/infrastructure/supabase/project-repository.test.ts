import { describe, expect, it } from 'vitest';
import { asId, unwrap, type ProjectId, type VillageId } from '../../../../shared/index.js';
import { attachEvidence, createFundedProject, recordExpenditure, releaseFunds } from '../../domain/funded-project.js';
import { evidenceItem } from '../../domain/evidence.js';
import {
  fromProjectRow,
  toNewEvidenceRow,
  toNewLedgerEntryRows,
  toProjectRow,
  type EvidenceRow,
  type LedgerEntryRow,
} from './project-repository.js';

const projectId = (): ProjectId => asId<'ProjectId'>('50000000-0000-4000-8000-000000000001');
const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');

const aProject = () =>
  unwrap(
    createFundedProject({
      id: projectId(),
      villageId: villageId(),
      title: 'Bridge repair',
      category: 'bridge',
      fundingSource: 'district',
      sanctioned: { amountMinor: 1_000_000, currency: 'INR' },
      sanctionedAt: new Date('2026-01-01T00:00:00.000Z'),
      expectedCompletionAt: new Date('2026-06-01T00:00:00.000Z'),
    }),
  );

describe('toProjectRow', () => {
  it('maps a freshly sanctioned project to status "active" with zero released/spent', () => {
    const row = toProjectRow(aProject());
    expect(row).toMatchObject({
      id: projectId(),
      village_id: villageId(),
      title: 'Bridge repair',
      category: 'bridge',
      funding_source: 'district',
      currency: 'INR',
      sanctioned_minor: 1_000_000,
      released_minor: 0,
      spent_minor: 0,
      status: 'active',
      completed_at: null,
    });
  });

  it('maps an in_progress project (post-release) to status "active" too', () => {
    const released = unwrap(releaseFunds(aProject(), { amountMinor: 400_000, currency: 'INR' }, new Date('2026-02-01T00:00:00.000Z')));
    expect(toProjectRow(released).status).toBe('active');
    expect(toProjectRow(released).released_minor).toBe(400_000);
  });

  it('maps a completed project to status "completed" with a completed_at timestamp', () => {
    let project = aProject();
    project = unwrap(releaseFunds(project, { amountMinor: 1_000_000, currency: 'INR' }, new Date('2026-02-01T00:00:00.000Z')));
    project = unwrap(
      attachEvidence(
        project,
        unwrap(
          evidenceItem({ kind: 'village_verification', uri: 'https://x/y', attachedBy: 'field-officer', attachedAt: new Date('2026-03-01T00:00:00.000Z') }),
        ),
      ),
    );

    const row = toProjectRow(project);
    expect(row.status).toBe('active');
  });
});

describe('toNewLedgerEntryRows', () => {
  it('emits only the tail beyond what is already persisted, split by entry type', () => {
    let project = aProject();
    project = unwrap(releaseFunds(project, { amountMinor: 400_000, currency: 'INR' }, new Date('2026-02-01T00:00:00.000Z')));
    project = unwrap(recordExpenditure(project, { amountMinor: 100_000, currency: 'INR' }, 'labour', new Date('2026-02-05T00:00:00.000Z')));

    const rows = toNewLedgerEntryRows(project, 0, 0);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entry_type === 'release')).toMatchObject({ amount_minor: 400_000, description: null });
    expect(rows.find((r) => r.entry_type === 'expenditure')).toMatchObject({ amount_minor: 100_000, description: 'labour' });

    expect(toNewLedgerEntryRows(project, 1, 1)).toHaveLength(0);
  });
});

describe('toNewEvidenceRow', () => {
  it('maps the domain evidence kind "geo_tagged_photo" to the row kind "photo"', () => {
    const project = aProject();
    const item = unwrap(
      evidenceItem({
        kind: 'geo_tagged_photo',
        uri: 'https://x/photo.jpg',
        attachedBy: 'field-officer',
        attachedAt: new Date('2026-02-01T00:00:00.000Z'),
        location: { lat: 26.9, lng: 94.1 },
      }),
    );

    const row = toNewEvidenceRow(project, item);
    expect(row.kind).toBe('photo');
    expect(row.lat).toBe(26.9);
    expect(row.lng).toBe(94.1);
  });

  it('passes non-photo kinds through unchanged, with null lat/lng when there is no location', () => {
    const project = aProject();
    const item = unwrap(
      evidenceItem({ kind: 'invoice', uri: 'https://x/invoice.pdf', attachedBy: 'field-officer', attachedAt: new Date('2026-02-01T00:00:00.000Z') }),
    );

    const row = toNewEvidenceRow(project, item);
    expect(row.kind).toBe('invoice');
    expect(row.lat).toBeNull();
    expect(row.lng).toBeNull();
  });
});

describe('fromProjectRow', () => {
  it('rebuilds status "in_progress" from an "active" row that already has releases', () => {
    const project = unwrap(releaseFunds(aProject(), { amountMinor: 400_000, currency: 'INR' }, new Date('2026-02-01T00:00:00.000Z')));
    const row = toProjectRow(project);
    const ledgerRows: LedgerEntryRow[] = toNewLedgerEntryRows(project, 0, 0) as LedgerEntryRow[];

    const rebuilt = fromProjectRow(row, ledgerRows, []);

    expect(rebuilt.status).toBe('in_progress');
    expect(rebuilt.ledger.releases).toHaveLength(1);
  });

  it('rebuilds status "sanctioned" from an "active" row with no releases yet', () => {
    const row = toProjectRow(aProject());
    const rebuilt = fromProjectRow(row, [], []);
    expect(rebuilt.status).toBe('sanctioned');
  });

  it('rebuilds status "completed" and includes completedAt only when the row has one', () => {
    const row = toProjectRow(aProject());
    const completedRow = { ...row, status: 'completed', completed_at: '2026-06-01T00:00:00.000Z' };

    const rebuilt = fromProjectRow(completedRow, [], []);

    expect(rebuilt.status).toBe('completed');
    expect(rebuilt.completedAt).toEqual(new Date('2026-06-01T00:00:00.000Z'));
  });

  it('maps evidence kind "photo" back to "geo_tagged_photo" and reconstructs the location', () => {
    const row = toProjectRow(aProject());
    const evidenceRow: EvidenceRow = {
      id: 'evidence-1',
      project_id: row.id,
      kind: 'photo',
      url: 'https://x/photo.jpg',
      lat: 26.9,
      lng: 94.1,
      attached_at: '2026-02-01T00:00:00.000Z',
    };

    const rebuilt = fromProjectRow(row, [], [evidenceRow]);

    expect(rebuilt.evidence).toEqual([
      { kind: 'geo_tagged_photo', uri: 'https://x/photo.jpg', attachedBy: '', attachedAt: new Date('2026-02-01T00:00:00.000Z'), location: { lat: 26.9, lng: 94.1 } },
    ]);
  });
});
