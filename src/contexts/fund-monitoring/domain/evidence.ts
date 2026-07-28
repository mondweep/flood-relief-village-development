/**
 * EvidenceItem (PRD §5 BC-4, FR-FM-3): append-only proof attached to a funded project.
 * A photo is only evidence if it is geo-tagged.
 */
import { type GeoPoint, type Result, err, ok } from '../../../shared/index.js';
import type { EvidenceKind } from './types.js';

export interface EvidenceItem {
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly attachedBy: string;
  readonly attachedAt: Date;
  readonly location?: GeoPoint;
}

export interface NewEvidence {
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly attachedBy: string;
  readonly attachedAt: Date;
  readonly location?: GeoPoint;
}

export function evidenceItem(input: NewEvidence): Result<EvidenceItem> {
  const uri = input.uri.trim();
  if (uri === '') return err('EVIDENCE_NEEDS_URI', 'evidence must reference a stored artefact');

  const attachedBy = input.attachedBy.trim();
  if (attachedBy === '') {
    return err('EVIDENCE_NEEDS_ATTRIBUTION', 'evidence must record who attached it (NFR-1)');
  }

  if (input.kind === 'geo_tagged_photo' && input.location === undefined) {
    return err('EVIDENCE_PHOTO_NEEDS_GEOTAG', 'photographic evidence must carry a GPS location');
  }

  const base = { kind: input.kind, uri, attachedBy, attachedAt: input.attachedAt };
  return ok(input.location === undefined ? base : { ...base, location: input.location });
}
