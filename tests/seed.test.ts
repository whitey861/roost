// Static checks on seed definitions plus behavioural tests for the
// agent-seeding logic (system_prompt protection, sync-prompts).
//
// Behavioural seed runs hit a real Supabase, which is out of scope for
// unit tests; we run the relevant functions against the in-memory
// FakeSupabaseClient instead.

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WORKSPACES, AGENTS, DEFAULT_MODEL, loadSystemPrompt } from '../shared/agents.js';
import { TOOLS } from '../shared/tools.js';
import { ensureAgents } from '../scripts/seed.js';
import { syncOnePrompt, syncPrompts } from '../scripts/sync-prompts.js';
import { FakeDb, FakeSupabaseClient } from './fakes/fake-supabase.js';

function fakeClient(): { client: SupabaseClient; db: FakeDb } {
  const db = new FakeDb();
  const client = new FakeSupabaseClient(db) as unknown as SupabaseClient;
  return { client, db };
}

function seedWorkspacesAndTools(db: FakeDb): { workspaceIds: Record<string, string>; toolIds: Record<string, string> } {
  const workspaceIds: Record<string, string> = {};
  db.seedTable('workspaces', WORKSPACES.map((w) => {
    const id = randomUUID();
    workspaceIds[w.slug] = id;
    return { id, slug: w.slug, name: w.name, description: w.description };
  }));
  const toolIds: Record<string, string> = {};
  db.seedTable('tools', TOOLS.map((t) => {
    const id = randomUUID();
    toolIds[t.name] = id;
    return { id, name: t.name };
  }));
  db.seedTable('agents', []);
  return { workspaceIds, toolIds };
}

describe('seed: workspaces and agents', () => {
  it('seeds the expected workspaces', () => {
    const slugs = WORKSPACES.map((w) => w.slug).sort();
    expect(slugs).toEqual(['budget', 'dev', 'kca', 'oarfish', 'personal', 'pmhc']);
  });

  it('every workspace has exactly one default agent', () => {
    for (const ws of WORKSPACES) {
      const agents = AGENTS.filter((a) => a.workspaceSlug === ws.slug);
      expect(agents).toHaveLength(1);
    }
  });

  it('every agent points at a readable prompt file', () => {
    for (const a of AGENTS) {
      expect(a.promptFile).toBe(`prompts/${a.workspaceSlug}.md`);
      const text = loadSystemPrompt(a);
      expect(text.length).toBeGreaterThan(0);
      expect(text.includes('—')).toBe(false);
    }
  });

  it('all seeded agents default to Sonnet 4.6', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-4-6');
    for (const a of AGENTS) expect(a.model).toBe('claude-sonnet-4-6');
  });
});

describe('seed: tools', () => {
  it('includes the mock tools used by the chat runtime', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('mock_echo');
    expect(names).toContain('mock_search');
    expect(names).toContain('mock_send_email');
  });

  it('mock_send_email is outbound and requires approval by default', () => {
    const t = TOOLS.find((x) => x.name === 'mock_send_email')!;
    expect(t.isOutbound).toBe(true);
    expect(t.requiresApprovalDefault).toBe(true);
  });

  it('includes web_search as an anthropic_server tool', () => {
    const t = TOOLS.find((x) => x.name === 'web_search')!;
    expect(t.handlerType).toBe('anthropic_server');
    expect(t.handlerConfig.server_tool_type).toBe('web_search_20250305');
  });

  it('includes generate_image as an internal tool scoped to oarfish', () => {
    const t = TOOLS.find((x) => x.name === 'generate_image')!;
    expect(t.handlerType).toBe('internal');
    expect(t.requiresApprovalDefault).toBe(false);
    expect(t.isOutbound).toBe(false);
    expect(t.workspaceScope).toEqual(['oarfish']);
  });
});

describe('migrations: generate_image registry row', () => {
  it('0014_generate_image_tool.sql inserts the tool row idempotently', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0014_generate_image_tool.sql'), 'utf8');
    expect(sql).toMatch(/insert into public\.tools/i);
    expect(sql).toMatch(/'generate_image'/);
    expect(sql).toMatch(/'internal'/);
    expect(sql).toMatch(/on conflict\s*\(name\)\s*do nothing/i);
  });
});

describe('ensureAgents: behaviour', () => {
  it('creates new agents from prompt files on a fresh database', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds, toolIds } = seedWorkspacesAndTools(db);
    await ensureAgents(client, workspaceIds, toolIds);
    const agents = db.tableRows('agents');
    expect(agents).toHaveLength(WORKSPACES.length);
    for (const a of agents) {
      expect(typeof a.system_prompt).toBe('string');
      expect((a.system_prompt as string).length).toBeGreaterThan(0);
      expect(a.model).toBe('claude-sonnet-4-6');
    }
  });

  it('idempotently adds the web_search tool to existing agents on re-seed', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds, toolIds } = seedWorkspacesAndTools(db);

    // Pre-seed agents with the OLD allow-list (no web_search) to simulate
    // a database from before this phase.
    const legacyAllowed = ['mock_echo', 'mock_search', 'search_knowledge']
      .map((n) => toolIds[n]!)
      .filter(Boolean);
    db.seedTable('agents', WORKSPACES.map((ws) => ({
      id: randomUUID(),
      workspace_id: workspaceIds[ws.slug]!,
      name: `${ws.name} Assistant`,
      role_description: 'old',
      system_prompt: 'old',
      model: 'claude-sonnet-4-6',
      allowed_tool_ids: legacyAllowed,
    })));

    await ensureAgents(client, workspaceIds, toolIds);

    const webSearchId = toolIds.web_search!;
    expect(webSearchId).toBeTruthy();
    for (const agent of db.tableRows('agents')) {
      const allowed = agent.allowed_tool_ids as string[];
      expect(allowed).toContain(webSearchId);
    }
  });

  it('does not overwrite an existing agent\'s system_prompt', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds, toolIds } = seedWorkspacesAndTools(db);

    // Pre-seed a synthetic agent for the pmhc workspace with a
    // hand-tuned prompt that must survive the next ensureAgents() call.
    const pmhcId = workspaceIds.pmhc!;
    const existingId = randomUUID();
    db.seedTable('agents', [
      {
        id: existingId,
        workspace_id: pmhcId,
        name: 'PMHC Assistant',
        role_description: 'old desc',
        system_prompt: 'pre-existing manual prompt',
        model: 'claude-opus-4-7',
        allowed_tool_ids: [],
      },
    ]);

    await ensureAgents(client, workspaceIds, toolIds);

    const pmhcAgent = db.tableRows('agents').find((a) => a.id === existingId)!;
    expect(pmhcAgent.system_prompt).toBe('pre-existing manual prompt');
    // Other fields ARE refreshed on update.
    expect(pmhcAgent.role_description).toBe('Default assistant for the PMHC workspace.');
    expect(pmhcAgent.model).toBe('claude-sonnet-4-6');
    // Allowed tools are repopulated from the seed definition.
    expect(Array.isArray(pmhcAgent.allowed_tool_ids)).toBe(true);
    expect((pmhcAgent.allowed_tool_ids as string[]).length).toBeGreaterThan(0);
  });
});

describe('syncPrompts: behaviour', () => {
  it('updates a stale system_prompt for one workspace', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds } = seedWorkspacesAndTools(db);

    // Existing agent with a stale prompt body.
    const pmhcAgent = AGENTS.find((a) => a.workspaceSlug === 'pmhc')!;
    db.seedTable('agents', [
      {
        id: randomUUID(),
        workspace_id: workspaceIds.pmhc!,
        name: pmhcAgent.name,
        role_description: 'role',
        system_prompt: 'old prompt content',
        model: 'claude-sonnet-4-6',
        allowed_tool_ids: [],
      },
    ]);

    const results = await syncPrompts(client, { workspace: 'pmhc' });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('updated');
    expect(results[0]?.diff).toMatch(/words/);

    const stored = db.tableRows('agents')[0]?.system_prompt as string;
    expect(stored).toBe(loadSystemPrompt(pmhcAgent));
  });

  it('reports unchanged when the DB matches the file', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds } = seedWorkspacesAndTools(db);
    const pmhcAgent = AGENTS.find((a) => a.workspaceSlug === 'pmhc')!;
    const text = loadSystemPrompt(pmhcAgent);
    db.seedTable('agents', [
      {
        id: randomUUID(),
        workspace_id: workspaceIds.pmhc!,
        name: pmhcAgent.name,
        role_description: 'role',
        system_prompt: text,
        model: 'claude-sonnet-4-6',
        allowed_tool_ids: [],
      },
    ]);

    const r = await syncOnePrompt(client, pmhcAgent);
    expect(r.status).toBe('unchanged');
  });

  it('reports missing-agent when the agent does not exist yet', async () => {
    const { client, db } = fakeClient();
    seedWorkspacesAndTools(db);
    const pmhcAgent = AGENTS.find((a) => a.workspaceSlug === 'pmhc')!;
    const r = await syncOnePrompt(client, pmhcAgent);
    expect(r.status).toBe('missing-agent');
  });

  it('--dry-run does not write', async () => {
    const { client, db } = fakeClient();
    const { workspaceIds } = seedWorkspacesAndTools(db);
    const pmhcAgent = AGENTS.find((a) => a.workspaceSlug === 'pmhc')!;
    db.seedTable('agents', [
      {
        id: randomUUID(),
        workspace_id: workspaceIds.pmhc!,
        name: pmhcAgent.name,
        role_description: 'role',
        system_prompt: 'untouched',
        model: 'claude-sonnet-4-6',
        allowed_tool_ids: [],
      },
    ]);
    const r = await syncOnePrompt(client, pmhcAgent, { dryRun: true });
    expect(r.status).toBe('updated');
    expect(db.tableRows('agents')[0]?.system_prompt).toBe('untouched');
  });
});
