import { type Result, ok, err, type GeoPoint } from '../../../shared/index.js';

/**
 * BC-6 Issue Tracking — Attachment value object (PRD §5 BC-6).
 * A photo of the issue plus the GPS location it was captured at (FR-IT-1).
 */
export interface Attachment {
  readonly photoUrl: string;
  readonly location: GeoPoint;
}

export function attachment(photoUrl: string, location: GeoPoint): Result<Attachment> {
  if (photoUrl.trim().length === 0) {
    return err('ATTACHMENT_EMPTY_PHOTO_URL', 'attachment photo url must not be empty');
  }
  return ok({ photoUrl, location });
}
