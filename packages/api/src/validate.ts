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
