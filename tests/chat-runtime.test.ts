import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat } from '../shared/chat-runtime.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { FakeAnthropic } from './fakes/fake-anthropic.js';
import { FakeSupabaseClient } from './fakes/fake-supabase.js';
import { seedFakeDb } from './fixtures/seed-fake-db.js';

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function client(db: ReturnType<typeof seedFakeDb>['db']): SupabaseClient {
  return new FakeSupabaseClient(db) as unknown as SupabaseClient;
}

describe('runChat: happy path with no tools', () => {
  it('streams tokens and emits a done event', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'Hello there.', stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Hi',
    }));

    expect(events[0]?.type).toBe('session');
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(tokens).toBe('Hello there.');
    expect(events.at(-1)?.type).toBe('done');

    // user + assistant messages persisted
    const messages = fx.db.tableRows('messages');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toBe('Hello there.');

    // workspace daily_spent_usd incremented
    const ws = fx.db.tableRows('workspaces')[0];
    expect(Number(ws?.daily_spent_usd)).toBeGreaterThan(0);
  });
});

describe('runChat: mock tool call loop', () => {
  it('executes mock_search and feeds the result back to the model', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      // First turn: model decides to call mock_search.
      {
        toolUses: [{ id: 'call_1', name: 'mock_search', input: { query: 'roost' } }],
        stopReason: 'tool_use',
        inputTokens: 50, outputTokens: 10,
      },
      // Second turn: model summarises results.
      { text: 'Found three things.', stopReason: 'end_turn', inputTokens: 60, outputTokens: 8 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'search for roost',
    }));

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toBeTruthy();
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeTruthy();

    const finalText = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(finalText).toBe('Found three things.');

    // Persisted: user, tool_call, tool_result, assistant
    const roles = fx.db.tableRows('messages').map((m) => m.role);
    expect(roles).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);

    // Two Anthropic calls were made
    expect(anthropic.calls).toHaveLength(2);
    // Second call's last message must be tool_result blocks
    const second = anthropic.calls[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string }>;
    expect(blocks[0]?.type).toBe('tool_result');
  });
});

describe('runChat: outbound tool requires approval', () => {
  it('queues an outbound_action and feeds queued_for_approval back to the model', async () => {
    const fx = seedFakeDb({ approvalMode: 'all_outbound' });
    const anthropic = new FakeAnthropic([
      {
        toolUses: [{ id: 'call_1', name: 'mock_send_email', input: { to: 'a@b.com', subject: 'hi', body: 'hey' } }],
        stopReason: 'tool_use',
        inputTokens: 50, outputTokens: 10,
      },
      { text: 'Queued for approval.', stopReason: 'end_turn', inputTokens: 60, outputTokens: 5 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'email a@b.com hi',
    }));

    const queued = events.find((e) => e.type === 'tool_result' && (e as { queued_for_approval?: boolean }).queued_for_approval);
    expect(queued).toBeTruthy();

    const actions = fx.db.tableRows('outbound_actions');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe('pending');
    expect(actions[0]?.action_type).toBe('mock_send_email');
    expect(actions[0]?.target).toBe('a@b.com');
  });
});

describe('runChat: budget cap enforcement', () => {
  it('emits budget_exceeded when daily_spent_usd >= budget at start', async () => {
    const fx = seedFakeDb({ budget: 1, spent: 1 });
    const anthropic = new FakeAnthropic([]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Hi',
    }));

    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(true);
    // Anthropic was never called
    expect(anthropic.calls).toHaveLength(0);
  });

  it('rolls over when reset_at is yesterday', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const fx = seedFakeDb({ budget: 1, spent: 999, resetAt: yesterday });
    const anthropic = new FakeAnthropic([
      { text: 'Hello.', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Hi',
    }));

    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });
});
