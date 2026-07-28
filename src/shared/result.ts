/** Explicit success/failure without exceptions crossing layer boundaries. */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface DomainError {
  readonly code: string;
  readonly message: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = (code: string, message: string): Result<never, DomainError> => ({
  ok: false,
  error: { code, message },
});

/** Unwrap for tests and composition roots; throws if the result is an error. */
export function unwrap<T, E extends DomainError>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap on error result: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
}
