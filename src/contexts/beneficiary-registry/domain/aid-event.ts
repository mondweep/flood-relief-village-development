import { type Result, ok, err } from '../../../shared/index.js';

/**
 * VO: AidEvent (PRD §5 BC-3, FR-BR-2).
 * Append-only aid history entry. Timestamp is always supplied by the caller
 * (application layer, sourced from the injected Clock — never Date.now() here).
 */
export interface AidEvent {
  readonly kind: string;
  readonly providerName: string;
  readonly at: Date;
  readonly note?: string;
}

export function aidEvent(kind: string, providerName: string, at: Date, note?: string): Result<AidEvent> {
  const trimmedKind = kind.trim();
  if (trimmedKind.length === 0) return err('AID_EVENT_EMPTY_KIND', 'aid kind must not be empty');

  const trimmedProvider = providerName.trim();
  if (trimmedProvider.length === 0) return err('AID_EVENT_EMPTY_PROVIDER', 'provider name must not be empty');

  if (Number.isNaN(at.getTime())) return err('AID_EVENT_INVALID_DATE', 'aid event date is invalid');

  return ok({
    kind: trimmedKind,
    providerName: trimmedProvider,
    at,
    ...(note !== undefined && note.trim().length > 0 ? { note: note.trim() } : {}),
  });
}

/** FR-BR-3: same-kind aid within the suspicion window (default 7 days) is a suspected duplicate. */
export function isSuspectedDuplicate(
  candidate: AidEvent,
  existing: AidEvent,
  suspicionWindowDays: number,
): boolean {
  if (candidate.kind !== existing.kind) return false;
  const windowMs = suspicionWindowDays * 24 * 60 * 60 * 1000;
  const deltaMs = Math.abs(candidate.at.getTime() - existing.at.getTime());
  return deltaMs <= windowMs;
}
