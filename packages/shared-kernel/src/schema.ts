/**
 * The Postgres schema every AFRIP table lives in.
 *
 * The Supabase project is shared with unrelated applications whose tables sit
 * in `public`; ours are namespaced away from them (see
 * supabase/migrations/00001_initial_schema.sql for the full rationale).
 *
 * This is deliberately NOT `public`. A Supabase client defaults to the `public`
 * schema, so an adapter that forgets to select a schema does not fail loudly —
 * it silently reads and writes in another application's namespace. Every
 * Supabase adapter therefore takes its schema explicitly, defaulting here, and
 * the constant lives in the shared kernel so the six adapter packages agree on
 * one spelling rather than six string literals drifting apart.
 *
 * Override at the edge via the API's `SUPABASE_SCHEMA` environment variable.
 */
export const AFRIP_SCHEMA = "assam_floods";
