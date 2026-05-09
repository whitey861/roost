// Static checks on the migration files. We can't spin up Postgres in CI,
// so we sanity-check that the SQL is present and not obviously malformed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'supabase', 'migrations');

describe('migrations', () => {
  it('lists numbered SQL files in order', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < files.length; i++) {
      const expected = String(i + 1).padStart(4, '0');
      expect(files[i]?.startsWith(expected + '_')).toBe(true);
    }
  });

  it('default model has been switched to Sonnet 4.6', () => {
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(all).toMatch(/alter column model set default 'claude-sonnet-4-6'/);
    expect(all).toMatch(/update public\.agents set model = 'claude-sonnet-4-6'/);
  });

  it('all files use `create table if not exists` or DO blocks for idempotency', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const hasCreateTable = /create table/i.test(sql);
      if (hasCreateTable) {
        expect(sql).toMatch(/create table if not exists/i);
      }
    }
  });

  it('references all key tables somewhere in the migration set', () => {
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const expectedTables = [
      'profiles', 'workspaces', 'workspace_members', 'agents', 'tools', 'agent_tool_overrides',
      'sessions', 'messages', 'jobs', 'agent_runs', 'artifacts', 'outbound_actions',
      'telegram_links', 'telegram_pairing_codes', 'audit_log',
      'knowledge_documents', 'knowledge_chunks',
      'dev_jobs', 'dev_job_notifications',
    ];
    for (const t of expectedTables) {
      expect(all).toContain(`public.${t}`);
    }
  });

  it('enables RLS on user-data tables', () => {
    const rls = readFileSync(join(dir, '0008_rls_policies.sql'), 'utf8');
    const tables = ['workspaces', 'workspace_members', 'agents', 'sessions', 'messages', 'outbound_actions', 'telegram_links', 'profiles'];
    for (const t of tables) {
      expect(rls).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
    }
  });
});
