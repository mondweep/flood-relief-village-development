/**
 * Branded identity types shared across bounded contexts (shared kernel).
 * IDs are client-generated UUIDs (NFR-3: offline-first idempotency).
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type VillageId = Brand<string, 'VillageId'>;
export type NgoId = Brand<string, 'NgoId'>;
export type AssignmentId = Brand<string, 'AssignmentId'>;
export type BeneficiaryId = Brand<string, 'BeneficiaryId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type IssueId = Brand<string, 'IssueId'>;
export type VolunteerId = Brand<string, 'VolunteerId'>;
export type PersonId = Brand<string, 'PersonId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (raw: string): boolean => UUID_RE.test(raw);

export function asId<B extends string>(raw: string): Brand<string, B> {
  if (!isUuid(raw)) throw new Error(`invalid id: ${raw}`);
  return raw as Brand<string, B>;
}

/** Port: id generation is injected so tests stay deterministic. */
export interface IdGenerator {
  next(): string;
}
