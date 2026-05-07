// Edge Function helper: build a Supabase client with the service role.
// All chat / agent / telegram operations bypass RLS, since they are
// authoritative server-side runtime calls.

// @ts-ignore: remote import resolved by Deno at runtime, not by tsc.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';
import { env } from './env.ts';

export function serviceRoleClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// User-scoped client backed by the caller's JWT. Used for membership checks
// without trusting the JWT body directly: we re-verify against the DB.
export function userClient(jwt: string): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
