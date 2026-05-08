// Behavioural tests for the seed-core helpers used by both
// `scripts/seed.ts` and `scripts/sync-prompts.ts`.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDb, FakeSupabaseClient } from './fakes/fake-supabase.js';
import { syncOneAgentPrompt, upsertAgent } from '../shared/seed-core.js';
import type { AgentSeed } from '../shared/agents.js';

const SAMPLE_SEED: AgentSeed = {
  workspaceSlug: 'pmhc',
  name: 'PMHC Assistant',
  roleDescription: 'PMHC default',
  promptFile: 'prompts/pmhc.md',
  model: 'claude-sonnet-4-6',
  toolNames: ['mock_echo'],
};

function makeClient(seedExisting: { systemPrompt: string; model?: string } | null): { client: SupabaseClient; db: FakeDb; workspaceId: string } {
  const db = new FakeDb();
  const workspaceId = 'ws-1';
  db.seedTable('workspaces', [{ id: workspaceId, slug: 'pmhc' }]);
  if (seedExisting) {
    db.seedTable('agents', [{
      id: 'agent-1',
      workspace_id: workspaceId,
      name: SAMPLE_SEED.name,
      role_description: 'old role',
      system_prompt: seedExisting.systemPrompt,
      model: seedExisting.model ?? 'claude-opus-4-7',
      allowed_tool_ids: ['stale-tool-id'],
    }]);
  } else {
    db.seedTable('agents', []);
  }
  return { client: new FakeSupabaseClient(db) as unknown as SupabaseClient, db, workspaceId };
}

describe('upsertAgent: INSERT path', () => {
  it('reads prompt from disk and inserts a new agent', async () => {
    const fx = makeClient(null);
    const reads: string[] = [];
    const result = await upsertAgent(fx.client, {
      seed: SAMPLE_SEED,
      workspaceId: fx.workspaceId,
      allowedToolIds: ['tool-a'],
      readPrompt: (p) => { reads.push(p); return 'PROMPT FROM DISK'; },
    });
    expect(result.status).toBe('created');
    expect(reads).toEqual(['prompts/pmhc.md']);
    const rows = fx.db.tableRows('agents');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.system_prompt).toBe('PROMPT FROM DISK');
    expect(rows[0]?.model).toBe('claude-sonnet-4-6');
    expect(rows[0]?.allowed_tool_ids).toEqual(['tool-a']);
  });
});

describe('upsertAgent: UPDATE path', () => {
  it('preserves the existing system_prompt and never invokes the prompt reader', async () => {
    const fx = makeClient({ systemPrompt: 'pre-existing manual prompt' });
    let readerCalls = 0;
    const result = await upsertAgent(fx.client, {
      seed: SAMPLE_SEED,
      workspaceId: fx.workspaceId,
      allowedToolIds: ['tool-a', 'tool-b'],
      readPrompt: () => { readerCalls += 1; return 'MARKDOWN PROMPT (should NOT be written)'; },
    });
    expect(result.status).toBe('updated');
    expect(result.systemPromptPreserved).toBe(true);
    expect(readerCalls).toBe(0);

    const rows = fx.db.tableRows('agents');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.system_prompt).toBe('pre-existing manual prompt');
    expect(rows[0]?.allowed_tool_ids).toEqual(['tool-a', 'tool-b']);
    expect(rows[0]?.role_description).toBe('PMHC default');
    expect(rows[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('flips an existing claude-opus-4-7 row to claude-sonnet-4-6', async () => {
    const fx = makeClient({ systemPrompt: 'existing', model: 'claude-opus-4-7' });
    await upsertAgent(fx.client, {
      seed: SAMPLE_SEED,
      workspaceId: fx.workspaceId,
      allowedToolIds: [],
      readPrompt: () => 'unused',
    });
    expect(fx.db.tableRows('agents')[0]?.model).toBe('claude-sonnet-4-6');
  });
});

describe('syncOneAgentPrompt', () => {
  it('writes a new prompt and reports the diff', async () => {
    const fx = makeClient({ systemPrompt: 'old prompt with five words.' });
    const r = await syncOneAgentPrompt(fx.client, {
      workspaceId: fx.workspaceId,
      agentName: SAMPLE_SEED.name,
      nextPrompt: 'a much longer new prompt with significantly more words than before for the diff',
    });
    expect(r.status).toBe('updated');
    expect(r.nextWords - r.prevWords).toBeGreaterThan(0);
    expect(fx.db.tableRows('agents')[0]?.system_prompt).toContain('a much longer');
  });

  it('reports unchanged when the prompt matches', async () => {
    const same = 'same content';
    const fx = makeClient({ systemPrompt: same });
    const r = await syncOneAgentPrompt(fx.client, {
      workspaceId: fx.workspaceId,
      agentName: SAMPLE_SEED.name,
      nextPrompt: same,
    });
    expect(r.status).toBe('unchanged');
  });

  it('--dry-run does not write but still reports updated', async () => {
    const fx = makeClient({ systemPrompt: 'old' });
    const r = await syncOneAgentPrompt(fx.client, {
      workspaceId: fx.workspaceId,
      agentName: SAMPLE_SEED.name,
      nextPrompt: 'new content here',
      dryRun: true,
    });
    expect(r.status).toBe('updated');
    expect(fx.db.tableRows('agents')[0]?.system_prompt).toBe('old');
  });

  it('reports missing when the agent does not exist', async () => {
    const fx = makeClient(null);
    const r = await syncOneAgentPrompt(fx.client, {
      workspaceId: fx.workspaceId,
      agentName: 'Nonexistent',
      nextPrompt: 'whatever',
    });
    expect(r.status).toBe('missing');
  });
});
