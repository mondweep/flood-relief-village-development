import { describe, expect, it } from 'vitest';
import { unwrap, geoPoint } from '../../../shared/index.js';
import { attachment } from './attachment.js';

// FR-IT-1: attachments carry a photo and GPS location (state-based, pure domain — ADR-004 §5).
describe('Attachment', () => {
  const point = unwrap(geoPoint(26.2, 92.9));

  it('FR-IT-1 creates an attachment with a photo url and GPS location', () => {
    const result = attachment('https://cdn.example.com/photo.jpg', point);
    expect(result.ok).toBe(true);
    expect(unwrap(result).location).toEqual(point);
  });

  it('FR-IT-1 rejects an empty photo url', () => {
    const result = attachment('   ', point);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ATTACHMENT_EMPTY_PHOTO_URL');
  });
});
