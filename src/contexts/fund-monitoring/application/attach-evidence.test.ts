import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { makeAttachEvidence } from './attach-evidence.js';
import {
  PROJECT_ID,
  aProject,
  asProjectRepository,
  fixedClock,
  mockEventPublisher,
  mockProjectRepository,
  withEvidence,
} from '../test-support.js';

const NOW = '2026-04-01T00:00:00.000Z';

describe('FR-FM-3 AttachEvidence (append-only, geo-tagged)', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let events: ReturnType<typeof mockEventPublisher>;
  let useCase: ReturnType<typeof makeAttachEvidence>;

  const command = {
    projectId: PROJECT_ID as string,
    kind: 'geo_tagged_photo',
    uri: 'https://evidence.afrip.test/road-slab.jpg',
    attachedBy: 'field-officer-7',
    location: { lat: 26.14, lng: 91.73 },
  };

  beforeEach(() => {
    projects = mockProjectRepository();
    events = mockEventPublisher();
    projects.findById.mockResolvedValue(aProject());
    useCase = makeAttachEvidence({
      projects: asProjectRepository(projects),
      events,
      clock: fixedClock(NOW),
    });
  });

  it('FR-FM-3: attaches a geo-tagged photo and publishes EvidenceAttached', async () => {
    const result = await useCase.execute(command);

    expect(result.ok).toBe(true);
    expect(projects.save).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'EvidenceAttached',
        occurredAt: new Date(NOW),
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          kind: 'geo_tagged_photo',
          uri: 'https://evidence.afrip.test/road-slab.jpg',
        }),
      }),
    ]);
  });

  it('FR-FM-3: stamps attachedAt from the injected Clock', async () => {
    const result = await useCase.execute(command);

    expect(unwrap(result).evidence[0]?.attachedAt).toEqual(new Date(NOW));
    expect(unwrap(result).evidence[0]?.location).toEqual({ lat: 26.14, lng: 91.73 });
  });

  it('FR-FM-3: evidence is append-only — existing items are preserved', async () => {
    projects.findById.mockResolvedValue(withEvidence(aProject(), 'invoice'));

    const result = await useCase.execute(command);

    const evidence = unwrap(result).evidence;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.kind).toBe('invoice');
    expect(evidence[1]?.kind).toBe('geo_tagged_photo');
  });

  it('FR-FM-3: accepts invoice evidence without a location', async () => {
    const { location: _location, ...withoutLocation } = command;

    const result = await useCase.execute({ ...withoutLocation, kind: 'invoice' });

    expect(result.ok).toBe(true);
    expect(unwrap(result).evidence[0]?.location).toBeUndefined();
  });

  it('FR-FM-3: accepts village_verification evidence', async () => {
    const { location: _location, ...withoutLocation } = command;

    const result = await useCase.execute({ ...withoutLocation, kind: 'village_verification' });

    expect(result.ok).toBe(true);
    expect(unwrap(result).evidence[0]?.kind).toBe('village_verification');
  });

  it('FR-FM-3: accepts completion_certificate evidence', async () => {
    const { location: _location, ...withoutLocation } = command;

    const result = await useCase.execute({ ...withoutLocation, kind: 'completion_certificate' });

    expect(result.ok).toBe(true);
    expect(unwrap(result).evidence[0]?.kind).toBe('completion_certificate');
  });

  it('FR-FM-3: rejects a photo without a geo-tag', async () => {
    const { location: _location, ...withoutLocation } = command;

    const result = await useCase.execute(withoutLocation);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_PHOTO_NEEDS_GEOTAG');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects an out-of-range geo-tag', async () => {
    const result = await useCase.execute({ ...command, location: { lat: 99, lng: 91.73 } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GEO_BAD_LAT');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects an unknown evidence kind at the boundary', async () => {
    const result = await useCase.execute({ ...command, kind: 'selfie' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_EVIDENCE_KIND');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects evidence with a blank uri', async () => {
    const result = await useCase.execute({ ...command, uri: '  ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_NEEDS_URI');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects evidence with no attribution', async () => {
    const result = await useCase.execute({ ...command, attachedBy: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_NEEDS_ATTRIBUTION');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects evidence for an unknown project', async () => {
    projects.findById.mockResolvedValue(null);

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });
});
