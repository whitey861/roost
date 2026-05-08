// Verifies that the chat runtime injects retrieved knowledge into the
// system prompt and dispatches the search_knowledge tool. Uses fakes
// throughout: no real Voyage, no real Supabase.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat } from '../shared/chat-runtime.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { FakeAnthropic } from './fakes/fake-anthropic.js';
import { FakeSupabaseClient, type RpcHandler } from './fakes/fake-supabase.js';
import { seedFakeDb } from './fixtures/seed-fake-db.js';
import { EMBEDDINGS_DIM } from '../shared/embeddings.js';

const FAKE_VEC = Array.from({ length: EMBEDDINGS_DIM }, () => 0.001);

function withVoyageStub(): { restore: () => void } {
  // Patch global fetch so embedQuery doesn't hit the network.
  const orig = globalThis.fetch;
  const stub = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
    const data = body.input.map((_, i) => ({ embedding: FAKE_VEC, index: i }));
    return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;
  process.env.VOYAGE_API_KEY = 'test-key';
  return {
    restore: () => {
      globalThis.fetch = orig;
      delete process.env.VOYAGE_API_KEY;
    },
  };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function clientWithRpc(db: ReturnType<typeof seedFakeDb>['db'], rpc: RpcHandler): SupabaseClient {
  const c = new FakeSupabaseClient(db);
  c.registerRpc('match_knowledge_chunks', rpc);
  return c as unknown as SupabaseClient;
}

describe('chat runtime: knowledge auto-injection', () => {
  it('prepends retrieved chunks to the system prompt when hits exist', async () => {
    const fx = seedFakeDb();
    const stub = withVoyageStub();
    try {
      const rpc: RpcHandler = async () => ({
        data: [
          {
            document_id: 'd1',
            document_title: 'Beacon Phase 2 plan',
            source_ref: 'knowledge/pmhc/beacon-phase-2.md',
            source_url: null,
            chunk_index: 0,
            content: '[Section: Plan] Phase 2 will replace ServiceDesk by end of FY26.',
            similarity: 0.85,
          },
        ],
        error: null,
      });
      const client = clientWithRpc(fx.db, rpc);
      const anthropic = new FakeAnthropic([
        { text: 'Acknowledged.', stopReason: 'end_turn', inputTokens: 5, outputTokens: 1 },
      ]);

      const events = await collect(runChat({
        client,
        anthropic,
        workspaceId: fx.workspaceId,
        userId: fx.userId,
        channel: 'web',
        userMessage: 'What is planned for Beacon Phase 2?',
      }));

      expect(events.at(-1)?.type).toBe('done');
      expect(anthropic.calls).toHaveLength(1);
      const sys = anthropic.calls[0]!.systemPrompt;
      expect(sys).toContain('<workspace_knowledge>');
      expect(sys).toContain('Beacon Phase 2 plan');
      expect(sys).toContain('ServiceDesk');
    } finally {
      stub.restore();
    }
  });

  it('does not inject anything when no hits clear the threshold', async () => {
    const fx = seedFakeDb();
    const stub = withVoyageStub();
    try {
      const rpc: RpcHandler = async () => ({
        data: [
          { document_id: 'd1', document_title: 't', source_ref: 'r', source_url: null, chunk_index: 0, content: 'x', similarity: 0.1 },
        ],
        error: null,
      });
      const client = clientWithRpc(fx.db, rpc);
      const anthropic = new FakeAnthropic([
        { text: 'No knowledge needed.', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 },
      ]);

      await collect(runChat({
        client,
        anthropic,
        workspaceId: fx.workspaceId,
        userId: fx.userId,
        channel: 'web',
        userMessage: 'What time is it?',
      }));

      const sys = anthropic.calls[0]!.systemPrompt;
      expect(sys).not.toContain('<workspace_knowledge>');
    } finally {
      stub.restore();
    }
  });
});

describe('chat runtime: search_knowledge tool dispatch', () => {
  it('routes search_knowledge calls to retrieveTopK and feeds hits back to the model', async () => {
    const fx = seedFakeDb();
    const stub = withVoyageStub();
    try {
      const rpc: RpcHandler = async () => ({
        data: [
          {
            document_id: 'd1',
            document_title: 'Contractor management policy',
            source_ref: 'knowledge/pmhc/contractors.md',
            source_url: null,
            chunk_index: 2,
            content: '[Section: Approval] Contractors over $50k require committee sign-off.',
            similarity: 0.7,
          },
        ],
        error: null,
      });
      const client = clientWithRpc(fx.db, rpc);

      // Override the seeded agent's allowed tools to include search_knowledge.
      const search = {
        id: 'search-knowledge-id',
        name: 'search_knowledge',
        description: 'Search the workspace knowledge base.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        handler_type: 'internal' as const,
        handler_config: {},
        requires_approval_default: false,
        is_outbound: false,
        workspace_scope: ['*'],
        created_at: new Date().toISOString(),
      };
      fx.db.tableRows('tools').push(search);
      const agent = fx.db.tableRows('agents')[0]!;
      (agent.allowed_tool_ids as string[]).push(search.id);

      const anthropic = new FakeAnthropic([
        {
          toolUses: [{ id: 'call-sk', name: 'search_knowledge', input: { query: 'contractor management', max_results: 3 } }],
          stopReason: 'tool_use',
          inputTokens: 10,
          outputTokens: 5,
        },
        { text: 'Found policy.', stopReason: 'end_turn', inputTokens: 20, outputTokens: 5 },
      ]);

      const events = await collect(runChat({
        client,
        anthropic,
        workspaceId: fx.workspaceId,
        userId: fx.userId,
        channel: 'web',
        userMessage: 'Search the knowledge base for contractor management.',
      }));

      const toolResult = events.find((e) => e.type === 'tool_result') as
        | { output: Record<string, unknown> }
        | undefined;
      expect(toolResult).toBeTruthy();
      const hits = toolResult!.output.hits as Array<{ document_title: string }>;
      expect(Array.isArray(hits)).toBe(true);
      expect(hits[0]?.document_title).toBe('Contractor management policy');
    } finally {
      stub.restore();
    }
  });
});
