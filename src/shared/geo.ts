import { type Result, ok, err } from './result.js';

/** Shared kernel value object: a WGS84 coordinate. */
export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export function geoPoint(lat: number, lng: number): Result<GeoPoint> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return err('GEO_BAD_LAT', `lat out of range: ${lat}`);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return err('GEO_BAD_LNG', `lng out of range: ${lng}`);
  return ok({ lat, lng });
}
