/** Shared error surfacing for the ngo-coordination Supabase adapters. */

/** Rethrows a Supabase error naming the table and the operation that failed. */
export function failed(table: string, operation: string, error: { message?: string } | null): void {
  if (error) {
    throw new Error(
      `supabase ${operation} on ${table} failed: ${error.message ?? "unknown error"}`,
    );
  }
}

/** Error for a row that cannot be turned into a valid aggregate. */
export function corrupt(table: string, id: string, reason: string): Error {
  return new Error(`corrupt row in ${table} (id=${id}): ${reason}`);
}
