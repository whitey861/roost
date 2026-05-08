// Roost: tests for the web_search Anthropic server tool wiring.
// Covers tool registry, server-tool declaration shape, runtime streaming
// of server_tool_use / web_search_tool_result blocks, persistence, and
// reconstructHistory's threading of server-tool blocks back into the
// assistant message content on subsequent turns.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat, reconstructHistory } from '../shared/chat-runtime.js';
import { TOOLS, SERVER_TOOL_NAMES } from '../shared/tools.js';
import { toAnthropicToolDefs, type ToolRow } from '../shared/tools-runtime.js';
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

describe('tool registry: web_search', () => {
  it('exists with handler_type anthropic_server and the web_search_20250305 server type', () => {
    const t = TOOLS.find((x) => x.name === 'web_search');
    expect(t).toBeTruthy();
    expect(t?.handlerType).toBe('anthropic_server');
    expect(t?.handlerConfig).toMatchObject({
      server_tool_type: 'web_search_20250305',
      max_uses: 5,
    });
    expect(t?.isOutbound).toBe(false);
    expect(t?.requiresApprovalDefault).toBe(false);
  });

  it('SERVER_TOOL_NAMES includes web_search', () => {
    expect(SERVER_TOOL_NAMES.has('web_search')).toBe(true);
  });
});

describe('default agent allow-lists: web_search', () => {
  it('every default agent includes web_search', () => {
    for (const a of AGENTS) {
      expect(a.toolNames).toContain('web_search');
    }
  });
});

describe('toAnthropicToolDefs: server-tool shape', () => {
  it('emits the Anthropic server-tool declaration when handler_type is anthropic_server', () => {
    const rows: ToolRow[] = [
      {
        id: '1',
        name: 'web_search',
        description: 'Search the web.',
        input_schema: { type: 'object' },
        handler_type: 'anthropic_server',
        handler_config: { server_tool_type: 'web_search_20250305', max_uses: 5 },
        requires_approval_default: false,
        is_outbound: false,
        workspace_scope: ['*'],
      },
      {
        id: '2',
        name: 'mock_echo',
        description: 'Echo.',
        input_schema: { type: 'object' },
        handler_type: 'mock',
        handler_config: {},
        requires_approval_default: false,
        is_outbound: false,
        workspace_scope: ['*'],
      },
    ];
    const defs = toAnthropicToolDefs(rows);
    expect(defs[0]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    expect(defs[1]).toEqual({ name: 'mock_echo', description: 'Echo.', input_schema: { type: 'object' } });
  });

  it('omits max_uses when not configured', () => {
    const rows: ToolRow[] = [
      {
        id: '1',
        name: 'web_search',
        description: '',
        input_schema: {},
        handler_type: 'anthropic_server',
        handler_config: { server_tool_type: 'web_search_20250305' },
        requires_approval_default: false,
        is_outbound: false,
        workspace_scope: ['*'],
      },
    ];
    const defs = toAnthropicToolDefs(rows);
    expect(defs[0]).toEqual({ type: 'web_search_20250305', name: 'web_search' });
  });
});

describe('runChat: web_search server tool', () => {
  it('declares the server tool in the Anthropic API call when allowed', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'ok.', stopReason: 'end_turn', inputTokens: 5, outputTokens: 1 },
    ]);

    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Hi',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const sent = anthropic.calls[0]!;
    const serverTool = sent.tools.find((t) => 'type' in t && t.type === 'web_search_20250305');
    expect(serverTool).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  });

  it('threads server_tool_use and web_search_tool_result blocks through the SSE stream and persists them', async () => {
    const fx = seedFakeDb();
    const searchContent = [
      {
        type: 'web_search_result',
        url: 'https://example.com/a',
        title: 'Example A',
        encrypted_content: 'enc',
      },
    ];
    const anthropic = new FakeAnthropic([
      {
        text: 'According to the search,',
        serverToolUses: [{ id: 'srv_1', name: 'web_search', input: { query: 'roost news' } }],
        serverToolResults: [{ tool_use_id: 'srv_1', toolName: 'web_search', content: searchContent }],
        stopReason: 'end_turn',
        inputTokens: 80, outputTokens: 25,
      },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Latest news on Roost?',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const toolCall = events.find((e) => e.type === 'tool_call') as
      | (Extract<ChatStreamEvent, { type: 'tool_call' }> | undefined);
    expect(toolCall).toBeTruthy();
    expect(toolCall?.name).toBe('web_search');
    expect(toolCall?.tool_call_id).toBe('srv_1');
    expect(toolCall?.input).toEqual({ query: 'roost news' });

    const toolResult = events.find((e) => e.type === 'tool_result') as
      | (Extract<ChatStreamEvent, { type: 'tool_result' }> | undefined);
    expect(toolResult).toBeTruthy();
    expect(toolResult?.tool_call_id).toBe('srv_1');
    expect(toolResult?.output).toEqual({ content: searchContent });
    // Server-tool results never need approval.
    expect(toolResult?.queued_for_approval).toBeFalsy();

    // Loop terminated on end_turn (no second Anthropic call).
    expect(anthropic.calls).toHaveLength(1);

    // Persisted: user, assistant text, tool_call (server), tool_result (server).
    const messages = fx.db.tableRows('messages');
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool_call', 'tool_result']);
    const callRow = messages.find((m) => m.role === 'tool_call')!;
    expect(callRow.tool_name).toBe('web_search');
    expect(callRow.tool_call_id).toBe('srv_1');
    expect(callRow.tool_input).toEqual({ query: 'roost news' });
    const resultRow = messages.find((m) => m.role === 'tool_result')!;
    expect(resultRow.tool_name).toBe('web_search');
    expect(resultRow.tool_call_id).toBe('srv_1');
    expect(resultRow.tool_output).toEqual({ content: searchContent });

    // No outbound_actions queued — server tools bypass the approval pipeline.
    expect(fx.db.tableRows('outbound_actions')).toHaveLength(0);

    // Daily spend incremented for the search-using turn.
    const ws = fx.db.tableRows('workspaces')[0];
    expect(Number(ws?.daily_spent_usd)).toBeGreaterThan(0);
  });
});

describe('reconstructHistory: server-tool blocks live in the assistant message', () => {
  it('routes server tool_call and tool_result rows into pendingAssistant', () => {
    const rows = [
      { role: 'user', content: 'news?', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'assistant', content: 'searching', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'tool_call', content: null, tool_call_id: 'srv_1', tool_name: 'web_search', tool_input: { query: 'x' }, tool_output: null },
      { role: 'tool_result', content: null, tool_call_id: 'srv_1', tool_name: 'web_search', tool_input: null, tool_output: { content: [{ url: 'https://e.com' }] } },
      { role: 'assistant', content: 'summary', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
    ];
    const messages = reconstructHistory(rows);

    // Expect: user, then ONE assistant message with text + server_tool_use +
    // web_search_tool_result + text. No intervening user message of
    // tool_results.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'news?' });
    expect(messages[1]?.role).toBe('assistant');
    const blocks = messages[1]!.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'server_tool_use', 'web_search_tool_result', 'text']);
  });

  it('still routes client tool_result rows into a separate user message', () => {
    const rows = [
      { role: 'user', content: 'echo', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'tool_call', content: null, tool_call_id: 'tc1', tool_name: 'mock_echo', tool_input: { text: 'hi' }, tool_output: null },
      { role: 'tool_result', content: null, tool_call_id: 'tc1', tool_name: 'mock_echo', tool_input: null, tool_output: { echoed: 'hi' } },
    ];
    const messages = reconstructHistory(rows);
    // user, assistant (with tool_use), user (with tool_result)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const aBlocks = messages[1]!.content as Array<{ type: string }>;
    expect(aBlocks.map((b) => b.type)).toEqual(['tool_use']);
    const tBlocks = messages[2]!.content as Array<{ type: string }>;
    expect(tBlocks.map((b) => b.type)).toEqual(['tool_result']);
  });
});
