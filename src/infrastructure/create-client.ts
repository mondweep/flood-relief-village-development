/**
 * Factory for the server-side Supabase client (ADR-003).
 * Uses the service-role key — this client is for backend adapters only, never the browser.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export function createSupabaseClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey);
}
