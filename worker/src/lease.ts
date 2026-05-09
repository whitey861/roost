// Lease management for dev_jobs.
//
// Workers can run concurrently. We lean on Postgres' `for update skip locked`
// to make lease acquisition safely atomic without app-level coordination.
// The database connection is the source of truth: the Supabase REST client
// can't issue `for update skip locked` directly, so we wrap the operation
// in a small RPC-style update with a CTE that enforces single-pick.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DevJob } from './types.js';

// Lease duration. The worker extends the lease via heartbeats while it's
// actively processing the job. If a worker crashes, the lease expires and
// another worker picks the job back up.
export const LEASE_TTL_SECONDS = 5 * 60;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Try to lease one queued job. Returns null if there's nothing waiting.
//
// We can't issue `for update skip locked` over PostgREST. Instead we rely
// on a Postgres function `lease_dev_job` (deployed via the worker setup
// migration once it exists, or invoked directly here as raw SQL via the
// service role REST endpoint). For the MVP we approximate with a pair of
// queries: pick a candidate, then update only if its status is still
// 'queued'. The update is atomic, so two workers racing can both attempt
// the update but only one will succeed at flipping status from 'queued'.
export async function tryLeaseJob(
  client: SupabaseClient,
  workerId: string,
  nowIso: string = new Date().toISOString(),
  leaseExpiresIso: string = new Date(Date.now() + LEASE_TTL_SECONDS * 1000).toISOString(),
): Promise<DevJob | null> {
  const { data: candidates, error: cErr } = await client
    .from('dev_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);
  if (cErr) throw new Error(`lease candidate select failed: ${cErr.message}`);
  if (!candidates || candidates.length === 0) return null;

  const candidate = candidates[0] as { id: string };

  // Atomic claim: only succeeds if status is still 'queued'.
  const { data: claimed, error: uErr } = await client
    .from('dev_jobs')
    .update({
      status: 'running',
      leased_by: workerId,
      leased_at: nowIso,
      lease_expires_at: leaseExpiresIso,
      updated_at: nowIso,
    })
    .eq('id', candidate.id)
    .eq('status', 'queued')
    .select('*');
  if (uErr) throw new Error(`lease claim failed: ${uErr.message}`);
  if (!claimed || claimed.length === 0) return null; // someone else got it

  return claimed[0] as DevJob;
}

// Extend the lease on a job we already hold. Called periodically so a
// long-running job keeps its claim. Refuses to extend if we no longer own
// the lease (e.g. another worker stole it after our last heartbeat lapsed).
export async function extendLease(
  client: SupabaseClient,
  jobId: string,
  workerId: string,
  nowIso: string = new Date().toISOString(),
  leaseExpiresIso: string = new Date(Date.now() + LEASE_TTL_SECONDS * 1000).toISOString(),
): Promise<boolean> {
  const { data, error } = await client
    .from('dev_jobs')
    .update({
      lease_expires_at: leaseExpiresIso,
      updated_at: nowIso,
    })
    .eq('id', jobId)
    .eq('leased_by', workerId)
    .eq('status', 'running')
    .select('id');
  if (error) throw new Error(`heartbeat failed: ${error.message}`);
  return Boolean(data && data.length > 0);
}

// Recover jobs whose lease expired before completion: their owner crashed,
// so we flip them back to 'queued' for the next polling worker to grab.
// Returns the number of recovered job ids.
export async function recoverExpiredLeases(
  client: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<string[]> {
  // 1. Find candidates: status=running and lease_expires_at < now.
  //    PostgREST doesn't expose `<` directly via .lt() on timestamptz in
  //    every version; it does work via .lt() with ISO strings.
  const { data, error } = await client
    .from('dev_jobs')
    .select('id, leased_by, lease_expires_at')
    .eq('status', 'running')
    .lt('lease_expires_at', nowIso);
  if (error) throw new Error(`recovery scan failed: ${error.message}`);
  const stuck = (data ?? []) as Array<{ id: string }>;
  if (stuck.length === 0) return [];

  const recovered: string[] = [];
  for (const row of stuck) {
    const { data: upd, error: uErr } = await client
      .from('dev_jobs')
      .update({
        status: 'queued',
        leased_by: null,
        leased_at: null,
        lease_expires_at: null,
        updated_at: nowIso,
      })
      .eq('id', row.id)
      .eq('status', 'running')
      .lt('lease_expires_at', nowIso)
      .select('id');
    if (uErr) throw new Error(`recovery update failed: ${uErr.message}`);
    if (upd && upd.length > 0) recovered.push(row.id);
  }
  return recovered;
}
