import { err, ok, type Result } from "@afrip/shared-kernel";

/**
 * Boundary validation. The domain owns the real rules (severity enums, ranges,
 * invariants); this layer only guarantees the *shape* the use cases assume, so a
 * missing `geo` or a string where an array belongs becomes a 400 rather than a
 * TypeError inside an aggregate.
 */

export type Body = Record<string, unknown>;

export function asObject(value: unknown): Result<Body> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("request body must be a JSON object");
  }
  return ok(value as Body);
}

export function requiredString(body: Body, key: string): Result<string> {
  const value = body[key];
  if (typeof value !== "string") return err(`${key} must be a string`);
  return ok(value);
}

export function optionalString(body: Body, key: string): Result<string | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "string") return err(`${key} must be a string when present`);
  return ok(value);
}

export function requiredNumber(body: Body, key: string): Result<number> {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return err(`${key} must be a finite number`);
  }
  return ok(value);
}

export function optionalNumber(body: Body, key: string): Result<number | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return err(`${key} must be a finite number when present`);
  }
  return ok(value);
}

/**
 * Absent and empty are distinguished deliberately: several use cases treat a
 * missing list as "derive it for me" and an empty one as "there are none".
 */
export function optionalNumberArray(body: Body, key: string): Result<number[] | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return ok(undefined);
  if (!Array.isArray(value)) return err(`${key} must be an array of numbers`);
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    return err(`${key} must be an array of numbers`);
  }
  return ok([...(value as number[])]);
}

export function optionalObjectArray(body: Body, key: string): Result<Body[] | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return ok(undefined);
  if (!Array.isArray(value)) return err(`${key} must be an array of objects`);
  const out: Body[] = [];
  for (const item of value) {
    const parsed = asObject(item);
    if (!parsed.ok) return err(`${key} must be an array of objects`);
    out.push(parsed.value);
  }
  return ok(out);
}

export function requiredStringArray(body: Body, key: string): Result<string[]> {
  const value = body[key];
  if (!Array.isArray(value)) return err(`${key} must be an array of strings`);
  if (value.some((item) => typeof item !== "string")) return err(`${key} must be an array of strings`);
  return ok([...(value as string[])]);
}

export function optionalStringArray(body: Body, key: string): Result<string[]> {
  if (body[key] === undefined || body[key] === null) return ok([]);
  return requiredStringArray(body, key);
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export function requiredCoordinates(body: Body, key: string): Result<Coordinates> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(`${key} must be an object with numeric lat and lng`);
  }
  const record = value as Body;
  const lat = requiredNumber(record, "lat");
  if (!lat.ok) return err(`${key}.lat must be a finite number`);
  const lng = requiredNumber(record, "lng");
  if (!lng.ok) return err(`${key}.lng must be a finite number`);
  return ok({ lat: lat.value, lng: lng.value });
}

// `optionalCoordinates` used to live here. It had exactly one caller — the
// village correction route — and that route now takes provenance with the
// point, so it went with it (ADR 0012 §1). `requiredCoordinates` stays: `Issue`
// still uses it for `gps`, and adopting the value object there is explicitly
// follow-on work.

/**
 * Coordinates carrying their provenance (ADR 0012 §1).
 *
 * Separate from `requiredCoordinates` above rather than replacing it: `Issue`
 * uses that one for its `gps` field and has the same ambiguity, but adopting
 * this value object there is explicitly follow-on work (ADR 0012 §Consequences),
 * and widening the shared helper would force it early and half-done.
 *
 * `source` is typed `string` here, not the domain union. This layer asserts the
 * SHAPE — that a source was supplied at all — and the `Village` aggregate owns
 * the enum, exactly as it owns `severity`. Note the asymmetry with the fields
 * below it: `source` has no default and no absent case, because a coordinate
 * arriving without one is the ambiguity the whole decision exists to remove,
 * and quietly filling it in at the HTTP boundary would reintroduce it here.
 */
export interface ProvenancedCoordinates extends Coordinates {
  source: string;
  accuracyMetres?: number;
  capturedAt?: string;
}

export function requiredProvenancedCoordinates(
  body: Body,
  key: string,
): Result<ProvenancedCoordinates> {
  const point = requiredCoordinates(body, key);
  if (!point.ok) return err(point.error);

  const record = body[key] as Body;
  const source = requiredString(record, "source");
  if (!source.ok) return err(`${key}.source must be a string`);
  const accuracyMetres = optionalNumber(record, "accuracyMetres");
  if (!accuracyMetres.ok) return err(`${key}.accuracyMetres must be a finite number when present`);
  const capturedAt = optionalString(record, "capturedAt");
  if (!capturedAt.ok) return err(`${key}.capturedAt must be a string when present`);

  return ok({
    lat: point.value.lat,
    lng: point.value.lng,
    source: source.value,
    ...(accuracyMetres.value === undefined ? {} : { accuracyMetres: accuracyMetres.value }),
    ...(capturedAt.value === undefined ? {} : { capturedAt: capturedAt.value }),
  });
}

export function optionalProvenancedCoordinates(
  body: Body,
  key: string,
): Result<ProvenancedCoordinates | undefined> {
  if (body[key] === undefined || body[key] === null) return ok(undefined);
  return requiredProvenancedCoordinates(body, key);
}

export function requiredObject(body: Body, key: string): Result<Body> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(`${key} must be an object`);
  }
  return ok(value as Body);
}

/** A record whose every value must be a finite number, e.g. recovery dimension scores. */
export function requiredNumberRecord(body: Body, key: string): Result<Record<string, number>> {
  const objectResult = requiredObject(body, key);
  if (!objectResult.ok) return err(objectResult.error);
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(objectResult.value)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return err(`${key}.${field} must be a finite number`);
    }
    out[field] = value;
  }
  return ok(out);
}

export function optionalNumberRecord(body: Body, key: string): Result<Record<string, number> | undefined> {
  if (body[key] === undefined || body[key] === null) return ok(undefined);
  const result = requiredNumberRecord(body, key);
  if (!result.ok) return err(result.error);
  return ok(result.value);
}
