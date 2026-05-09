import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tryLeaseJob, extendLease, recoverExpiredLeases } from '../src/lease.js';
import { FakeDb, FakeSupabaseClient } from './fake-supabase.js';

function client(db: FakeDb): SupabaseClient {
  return new FakeSupabaseClient(db) as unknown as SupabaseClient;
}

function seedJob(db: FakeDb, overrides: Record<string, unknown> = {}): string {
  const id = `job-${Math.random().toString(36).slice(2, 10)}`;
  db.tableRows('dev_jobs').push({
    id,
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    user_id: 'user-1',
    task_spec: 'do something',
    target_repo: 'whitey861/roost-test',
    target_branch: 'main',
    agent_provider: 'claude_code',
    agent_provider_config: {},
    max_iterations: 50,
    max_cost_usd: 5,
    max_runtime_minutes: 120,
    status: 'queued',
    leased_by: null,
    leased_at: null,
    lease_expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

describe('lease atomicity', () => {
  it('returns null when no jobs are queued', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const job = await tryLeaseJob(client(db), 'worker-A');
    expect(job).toBeNull();
  });

  it('leases a single queued job to a single worker', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const id = seedJob(db);
    const job = await tryLeaseJob(client(db), 'worker-A');
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe('running');
    expect(job?.leased_by).toBe('worker-A');
    expect(job?.lease_expires_at).toBeTruthy();
  });

  it('only one of two racing workers wins the same job', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    seedJob(db);
    const c = client(db);
    const [a, b] = await Promise.all([
      tryLeaseJob(c, 'worker-A'),
      tryLeaseJob(c, 'worker-B'),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    const stored = db.tableRows('dev_jobs')[0]!;
    expect(stored.status).toBe('running');
    expect(['worker-A', 'worker-B']).toContain(stored.leased_by);
  });

  it('picks the oldest queued job first', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const oldId = seedJob(db, { created_at: '2025-01-01T00:00:00Z' });
    seedJob(db, { created_at: '2025-02-01T00:00:00Z' });
    const job = await tryLeaseJob(client(db), 'w');
    expect(job?.id).toBe(oldId);
  });

  it('extendLease keeps a held lease alive', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const id = seedJob(db);
    const c = client(db);
    await tryLeaseJob(c, 'worker-A');
    const before = db.tableRows('dev_jobs').find((r) => r.id === id)!;
    const beforeExpiry = before.lease_expires_at;
    // small delta so the timestamps differ
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const ok = await extendLease(c, id, 'worker-A', new Date().toISOString(), future);
    expect(ok).toBe(true);
    const after = db.tableRows('dev_jobs').find((r) => r.id === id)!;
    expect(after.lease_expires_at).not.toBe(beforeExpiry);
  });

  it('extendLease refuses if a different worker holds the lease', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const id = seedJob(db);
    const c = client(db);
    await tryLeaseJob(c, 'worker-A');
    const ok = await extendLease(c, id, 'worker-B');
    expect(ok).toBe(false);
  });
});

describe('crash recovery', () => {
  it('requeues running jobs whose lease has expired', async () => {
    const db = new FakeDb();
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.seedTable('dev_jobs', []);
    const id = seedJob(db, {
      status: 'running',
      leased_by: 'dead-worker',
      leased_at: past,
      lease_expires_at: past,
    });
    const recovered = await recoverExpiredLeases(client(db));
    expect(recovered).toContain(id);
    const row = db.tableRows('dev_jobs').find((r) => r.id === id)!;
    expect(row.status).toBe('queued');
    expect(row.leased_by).toBeNull();
  });

  it('does not touch running jobs whose lease is still valid', async () => {
    const db = new FakeDb();
    db.seedTable('dev_jobs', []);
    const future = new Date(Date.now() + 60_000).toISOString();
    const id = seedJob(db, {
      status: 'running',
      leased_by: 'live-worker',
      leased_at: new Date().toISOString(),
      lease_expires_at: future,
    });
    const recovered = await recoverExpiredLeases(client(db));
    expect(recovered).not.toContain(id);
    const row = db.tableRows('dev_jobs').find((r) => r.id === id)!;
    expect(row.status).toBe('running');
    expect(row.leased_by).toBe('live-worker');
  });
});
