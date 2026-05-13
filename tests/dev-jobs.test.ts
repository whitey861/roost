// Tests for the spawn_dev_agent tool: it should insert a dev_jobs row when
// the chat runtime dispatches it, and the queued tool result must flow back
// to the model so the assistant can respond.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat } from '../shared/chat-runtime.js';
import { TOOLS } from '../shared/tools.js';
import { AGENTS } from '../shared/agents.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { FakeAnthropic } from './fakes/fake-anthropic.js';
import { FakeSupabaseClient } from './fakes/fake-supabase.js';
import { fakeQueryEmbedder } from './fakes/fake-embedder.js';
import { seedFakeDb } from './fixtures/seed-fake-db.js';

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function client(db: ReturnType<typeof seedFakeDb>['db']): SupabaseClient {
  return new FakeSupabaseClient(db) as unknown as SupabaseClient;
}

describe('spawn_dev_agent tool registration', () => {
  it('exists in the TOOLS registry with worker_job handler type', () => {
    const t = TOOLS.find((x) => x.name === 'spawn_dev_agent');
    expect(t).toBeTruthy();
    expect(t?.handlerType).toBe('worker_job');
    expect(t?.requiresApprovalDefault).toBe(false);
    // It's outbound so it shows up in the audit log even though we route
    // around the approval queue.
    expect(t?.isOutbound).toBe(true);
    expect(t?.workspaceScope).toEqual(['dev', 'buildit']);
  });

  it('declares task_spec and target_repo as required input fields', () => {
    const t = TOOLS.find((x) => x.name === 'spawn_dev_agent')!;
    const required = (t.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain('task_spec');
    expect(required).toContain('target_repo');
  });

  it('is on the dev and buildit agent allow-lists and not on the others', () => {
    const dev = AGENTS.find((a) => a.workspaceSlug === 'dev')!;
    const buildit = AGENTS.find((a) => a.workspaceSlug === 'buildit')!;
    expect(dev.toolNames).toContain('spawn_dev_agent');
    expect(buildit.toolNames).toContain('spawn_dev_agent');
    for (const other of AGENTS.filter((a) => a.workspaceSlug !== 'dev' && a.workspaceSlug !== 'buildit')) {
      expect(other.toolNames).not.toContain('spawn_dev_agent');
    }
  });
});

describe('chat runtime: worker_job dispatch', () => {
  it('inserts a dev_jobs row with the tool inputs and returns a queued tool_result', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      {
        toolUses: [
          {
            id: 'call_dev_1',
            name: 'spawn_dev_agent',
            input: {
              task_spec: 'Build a counter module in TypeScript with tests.',
              target_repo: 'whitey861/roost-test',
              target_branch: 'main',
              max_cost_usd: 3.5,
              max_runtime_minutes: 90,
            },
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 50,
        outputTokens: 10,
      },
      { text: 'Queued.', stopReason: 'end_turn', inputTokens: 60, outputTokens: 3 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'build a counter module',
      embedQueryFn: fakeQueryEmbedder,
    }));

    // dev_jobs row created with the right inputs.
    const jobs = fx.db.tableRows('dev_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.task_spec).toBe('Build a counter module in TypeScript with tests.');
    expect(jobs[0]?.target_repo).toBe('whitey861/roost-test');
    expect(jobs[0]?.target_branch).toBe('main');
    expect(Number(jobs[0]?.max_cost_usd)).toBe(3.5);
    expect(jobs[0]?.max_runtime_minutes).toBe(90);
    expect(jobs[0]?.agent_provider).toBe('claude_code');
    expect(jobs[0]?.status).toBe('queued');
    expect(jobs[0]?.workspace_id).toBe(fx.workspaceId);
    expect(jobs[0]?.user_id).toBe(fx.userId);

    // Tool result on the wire surfaces the job id.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const toolOutput = (toolResults[0] as { output: Record<string, unknown> }).output;
    expect(toolOutput.status).toBe('queued');
    expect(typeof toolOutput.job_id).toBe('string');

    // No outbound_action queued: worker_job tools route around the approval
    // queue. The PR review is the approval gate.
    expect(fx.db.tableRows('outbound_actions')).toHaveLength(0);
  });

  it('defaults missing optional fields and still inserts a job', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      {
        toolUses: [
          {
            id: 'call_dev_2',
            name: 'spawn_dev_agent',
            input: { task_spec: 'fix a bug', target_repo: 'whitey861/roost-test' },
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 30,
        outputTokens: 5,
      },
      { text: 'Done.', stopReason: 'end_turn', inputTokens: 30, outputTokens: 2 },
    ]);

    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'fix it',
      embedQueryFn: fakeQueryEmbedder,
    }));
    const jobs = fx.db.tableRows('dev_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.target_branch).toBe('main');
    expect(Number(jobs[0]?.max_cost_usd)).toBe(5);
    expect(jobs[0]?.max_runtime_minutes).toBe(120);
  });

  it('persists tool_call and tool_result messages so the next turn replays correctly', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      {
        toolUses: [
          {
            id: 'call_dev_3',
            name: 'spawn_dev_agent',
            input: { task_spec: 'thing', target_repo: 'whitey861/roost-test' },
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 5,
        outputTokens: 2,
      },
      { text: 'Queued.', stopReason: 'end_turn', inputTokens: 6, outputTokens: 1 },
    ]);
    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'do thing',
      embedQueryFn: fakeQueryEmbedder,
    }));
    const roles = fx.db.tableRows('messages').map((m) => m.role);
    expect(roles).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
  });
});

describe('check_dev_jobs tool', () => {
  it('exists in the TOOLS registry as an internal handler scoped to dev and buildit', () => {
    const t = TOOLS.find((x) => x.name === 'check_dev_jobs');
    expect(t).toBeTruthy();
    expect(t?.handlerType).toBe('internal');
    expect(t?.requiresApprovalDefault).toBe(false);
    expect(t?.isOutbound).toBe(false);
    expect(t?.workspaceScope).toEqual(['dev', 'buildit']);
  });

  it('is on the dev and buildit agent allow-lists and not on the others', () => {
    const dev = AGENTS.find((a) => a.workspaceSlug === 'dev')!;
    const buildit = AGENTS.find((a) => a.workspaceSlug === 'buildit')!;
    expect(dev.toolNames).toContain('check_dev_jobs');
    expect(buildit.toolNames).toContain('check_dev_jobs');
    for (const other of AGENTS.filter((a) => a.workspaceSlug !== 'dev' && a.workspaceSlug !== 'buildit')) {
      expect(other.toolNames).not.toContain('check_dev_jobs');
    }
  });

  it('returns the user\'s recent jobs scoped to the workspace, newest first', async () => {
    const fx = seedFakeDb();
    const otherUserId = '00000000-0000-0000-0000-000000000099';
    const now = Date.now();
    const minsAgo = (n: number) => new Date(now - n * 60000).toISOString();

    fx.db.tableRows('dev_jobs').push(
      {
        id: 'job-running',
        workspace_id: fx.workspaceId,
        user_id: fx.userId,
        agent_id: fx.agentId,
        task_spec: 'Build a counter module in TypeScript with tests.',
        target_repo: 'whitey861/roost-test',
        target_branch: 'main',
        status: 'running',
        max_iterations: 50,
        iterations_used: 0,
        max_cost_usd: 5,
        cost_usd: 0,
        created_at: minsAgo(20),
        leased_at: minsAgo(18),
        completed_at: null,
        pr_url: null,
      },
      {
        id: 'job-done',
        workspace_id: fx.workspaceId,
        user_id: fx.userId,
        agent_id: fx.agentId,
        task_spec: 'Earlier finished job.',
        target_repo: 'whitey861/roost-test',
        target_branch: 'main',
        status: 'completed',
        iterations_used: 7,
        runtime_seconds: 3600,
        cost_usd: 1.23,
        created_at: minsAgo(180),
        leased_at: minsAgo(178),
        completed_at: minsAgo(118),
        pr_url: 'https://github.com/whitey861/roost-test/pull/42',
        pr_number: 42,
      },
      {
        id: 'job-other-user',
        workspace_id: fx.workspaceId,
        user_id: otherUserId,
        agent_id: fx.agentId,
        task_spec: 'Someone else\'s job.',
        target_repo: 'whitey861/roost-test',
        status: 'running',
        created_at: minsAgo(5),
        leased_at: minsAgo(5),
      },
    );

    const anthropic = new FakeAnthropic([
      {
        toolUses: [{ id: 'call_check_1', name: 'check_dev_jobs', input: {} }],
        stopReason: 'tool_use',
        inputTokens: 20,
        outputTokens: 5,
      },
      { text: 'Here you go.', stopReason: 'end_turn', inputTokens: 30, outputTokens: 3 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'is it building?',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const out = (toolResults[0] as { output: Record<string, unknown> }).output;
    const jobs = out.jobs as Array<Record<string, unknown>>;
    expect(out.count).toBe(2);
    expect(jobs.map((j) => j.id)).toEqual(['job-running', 'job-done']);

    const running = jobs[0]!;
    expect(running.status).toBe('running');
    expect(running.target_repo).toBe('whitey861/roost-test');
    expect(running.task_spec_preview).toBe('Build a counter module in TypeScript with tests.');
    expect(typeof running.elapsed_minutes).toBe('number');
    expect(running.elapsed_minutes).toBeGreaterThanOrEqual(17);
    expect(running.elapsed_minutes).toBeLessThanOrEqual(19);

    const done = jobs[1]!;
    expect(done.status).toBe('completed');
    expect(done.pr_url).toBe('https://github.com/whitey861/roost-test/pull/42');
    expect(done.pr_number).toBe(42);
    expect(done.elapsed_minutes).toBe(60);
  });

  it('honours limit and status filters', async () => {
    const fx = seedFakeDb();
    const now = Date.now();
    const minsAgo = (n: number) => new Date(now - n * 60000).toISOString();
    fx.db.tableRows('dev_jobs').push(
      { id: 'a', workspace_id: fx.workspaceId, user_id: fx.userId, agent_id: fx.agentId, task_spec: 't', target_repo: 'r', status: 'queued', created_at: minsAgo(1) },
      { id: 'b', workspace_id: fx.workspaceId, user_id: fx.userId, agent_id: fx.agentId, task_spec: 't', target_repo: 'r', status: 'running', created_at: minsAgo(2), leased_at: minsAgo(2) },
      { id: 'c', workspace_id: fx.workspaceId, user_id: fx.userId, agent_id: fx.agentId, task_spec: 't', target_repo: 'r', status: 'completed', created_at: minsAgo(3), leased_at: minsAgo(3), completed_at: minsAgo(1) },
      { id: 'd', workspace_id: fx.workspaceId, user_id: fx.userId, agent_id: fx.agentId, task_spec: 't', target_repo: 'r', status: 'failed', created_at: minsAgo(4) },
    );

    const anthropic = new FakeAnthropic([
      {
        toolUses: [{ id: 'call_check_2', name: 'check_dev_jobs', input: { status: 'running', limit: 1 } }],
        stopReason: 'tool_use',
        inputTokens: 5,
        outputTokens: 2,
      },
      { text: 'ok', stopReason: 'end_turn', inputTokens: 5, outputTokens: 1 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'still running?',
      embedQueryFn: fakeQueryEmbedder,
    }));
    const out = (events.filter((e) => e.type === 'tool_result')[0] as { output: Record<string, unknown> }).output;
    const jobs = out.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe('b');
  });

  it('does not require approval and does not insert outbound_actions', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      {
        toolUses: [{ id: 'call_check_3', name: 'check_dev_jobs', input: {} }],
        stopReason: 'tool_use',
        inputTokens: 5,
        outputTokens: 2,
      },
      { text: 'no jobs.', stopReason: 'end_turn', inputTokens: 5, outputTokens: 2 },
    ]);
    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'anything queued?',
      embedQueryFn: fakeQueryEmbedder,
    }));
    expect(fx.db.tableRows('outbound_actions')).toHaveLength(0);
  });
});

describe('migrations: dev_jobs and worker_job', () => {
  it('migration files exist with correct numbering', async () => {
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..', 'supabase', 'migrations');
    const files = readdirSync(dir);
    expect(files).toContain('0012_dev_jobs.sql');
    expect(files).toContain('0013_worker_job_handler.sql');
  });

  it('0012 creates dev_jobs and dev_job_notifications and enables RLS', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0012_dev_jobs.sql'), 'utf8');
    expect(sql).toMatch(/create table if not exists public\.dev_jobs/);
    expect(sql).toMatch(/create table if not exists public\.dev_job_notifications/);
    expect(sql).toMatch(/alter table public\.dev_jobs enable row level security/);
    expect(sql).toMatch(/alter table public\.dev_job_notifications enable row level security/);
    // status enum: every state must be allowed.
    for (const s of ['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout']) {
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toMatch(/status in/);
  });

  it('0013 adds worker_job to the tool_handler_type enum idempotently', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0013_worker_job_handler.sql'), 'utf8');
    expect(sql).toMatch(/alter type tool_handler_type add value if not exists 'worker_job'/);
  });
});
