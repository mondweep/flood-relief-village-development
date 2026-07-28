import { describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import {
  attachEvidence,
  completeProject,
  createFundedProject,
  hasVillageVerification,
  recordExpenditure,
  releaseFunds,
} from './funded-project.js';
import { evidenceItem } from './evidence.js';
import {
  EXPECTED_COMPLETION_AT,
  PROJECT_ID,
  SANCTIONED_AT,
  VILLAGE_ID,
  aProject,
  inr,
  withEvidence,
  withReleased,
} from '../test-support.js';

// Pure aggregate: state-based assertions (ADR-004 §5).
const AT = new Date('2026-02-01T00:00:00.000Z');

describe('FundedProject aggregate', () => {
  it('FR-FM-1: a new project is sanctioned, unspent and evidence-free', () => {
    const project = unwrap(
      createFundedProject({
        id: PROJECT_ID,
        villageId: VILLAGE_ID,
        title: '  Primary school roof  ',
        category: 'school',
        fundingSource: 'csr',
        sanctioned: inr(50_000),
        sanctionedAt: SANCTIONED_AT,
        expectedCompletionAt: EXPECTED_COMPLETION_AT,
      }),
    );

    expect(project.status).toBe('sanctioned');
    expect(project.title).toBe('Primary school roof');
    expect(project.completedAt).toBeUndefined();
    expect(project.evidence).toEqual([]);
  });

  it('FR-FM-1: rejects a completion date on or before the sanction date', () => {
    const r = createFundedProject({
      id: PROJECT_ID,
      villageId: VILLAGE_ID,
      title: 'Bridge',
      category: 'bridge',
      fundingSource: 'mp',
      sanctioned: inr(50_000),
      sanctionedAt: SANCTIONED_AT,
      expectedCompletionAt: SANCTIONED_AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROJECT_BAD_COMPLETION_DATE');
  });

  it('FR-FM-2: releasing funds keeps the project in_progress on subsequent releases', () => {
    const once = unwrap(releaseFunds(aProject(), inr(100), AT));
    const twice = unwrap(releaseFunds(once, inr(100), AT));
    expect(twice.status).toBe('in_progress');
    expect(twice.ledger.releases).toHaveLength(2);
  });

  it('FR-FM-2: a completed project accepts no further releases or expenditures', () => {
    const completed = unwrap(
      completeProject(withEvidence(withReleased(aProject(), 100), 'village_verification'), AT),
    );

    const release = releaseFunds(completed, inr(10), AT);
    const spend = recordExpenditure(completed, inr(10), 'late bill', AT);

    expect(release.ok).toBe(false);
    if (!release.ok) expect(release.error.code).toBe('PROJECT_ALREADY_COMPLETED');
    expect(spend.ok).toBe(false);
    if (!spend.ok) expect(spend.error.code).toBe('PROJECT_ALREADY_COMPLETED');
  });

  it('FR-FM-3: evidence is appended, never replaced, and the source array is untouched', () => {
    const project = withEvidence(aProject(), 'invoice');
    const next = unwrap(
      attachEvidence(
        project,
        unwrap(
          evidenceItem({
            kind: 'completion_certificate',
            uri: 'https://evidence.afrip.test/cert.pdf',
            attachedBy: 'engineer-2',
            attachedAt: AT,
          }),
        ),
      ),
    );

    expect(project.evidence).toHaveLength(1);
    expect(next.evidence).toHaveLength(2);
    expect(next.evidence[0]).toEqual(project.evidence[0]);
  });

  it('FR-FM-3: hasVillageVerification only recognises village_verification evidence', () => {
    expect(hasVillageVerification(withEvidence(aProject(), 'geo_tagged_photo'))).toBe(false);
    expect(hasVillageVerification(withEvidence(aProject(), 'village_verification'))).toBe(true);
  });

  it('FR-FM-3: a geo-tagged photo without coordinates is not valid evidence', () => {
    const r = evidenceItem({
      kind: 'geo_tagged_photo',
      uri: 'https://evidence.afrip.test/x.jpg',
      attachedBy: 'volunteer-3',
      attachedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EVIDENCE_PHOTO_NEEDS_GEOTAG');
  });

  it('FR-FM-3: completion requires village verification', () => {
    const r = completeProject(withEvidence(aProject(), 'completion_certificate'), AT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('COMPLETION_NEEDS_VILLAGE_VERIFICATION');
  });
});
