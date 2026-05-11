// Roost: tests for the generate_image (Recraft) tool wiring.
// Covers registry shape, allow-list scoping to oarfish, handler unit
// behaviour against a fake fetch, and chat-runtime dispatch (event
// stream + persisted JSON tool_result).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat } from '../shared/chat-runtime.js';
import { TOOLS } from '../shared/tools.js';
import { AGENTS } from '../shared/agents.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { generateImage } from '../shared/tool-handlers/generate-image.js';
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

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function makeFetch(
  responder: (req: CapturedRequest) => { ok: boolean; status?: number; bodyText?: string; bodyJson?: unknown },
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const rawBody = (init?.body as string | undefined) ?? '';
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const captured: CapturedRequest = { url, init: init ?? {}, body };
    calls.push(captured);
    const r = responder(captured);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => (r.bodyJson ?? {}) as unknown,
      text: async () => r.bodyText ?? '',
    } as unknown as Response;
  };
  return { fetch: fn, calls };
}

describe('tool registry: generate_image', () => {
  it('exists with handler_type internal, requires_approval false, and a valid schema', () => {
    const t = TOOLS.find((x) => x.name === 'generate_image');
    expect(t).toBeTruthy();
    expect(t?.handlerType).toBe('internal');
    expect(t?.requiresApprovalDefault).toBe(false);
    expect(t?.isOutbound).toBe(false);
    const schema = t!.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['prompt']);
    expect(schema.properties.prompt).toBeTruthy();
    expect(schema.properties.style_id).toBeTruthy();
    expect(schema.properties.size).toBeTruthy();
  });

  it('is scoped to the oarfish workspace', () => {
    const t = TOOLS.find((x) => x.name === 'generate_image')!;
    expect(t.workspaceScope).toEqual(['oarfish']);
  });
});

describe('default agent allow-lists: generate_image', () => {
  it('oarfish has generate_image; other workspaces do not', () => {
    const oarfish = AGENTS.find((a) => a.workspaceSlug === 'oarfish')!;
    expect(oarfish.toolNames).toContain('generate_image');
    for (const a of AGENTS) {
      if (a.workspaceSlug === 'oarfish') continue;
      expect(a.toolNames).not.toContain('generate_image');
    }
  });
});

describe('generateImage handler: unit', () => {
  const KEY = 'test-recraft-key';

  beforeEach(() => {
    delete process.env.RECRAFT_API_KEY;
  });
  afterEach(() => {
    delete process.env.RECRAFT_API_KEY;
  });

  it('returns image_url, credits_used, and model on a successful call', async () => {
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      bodyJson: { data: [{ url: 'https://img.recraft.ai/abc.png' }], meta: { usage: { credits_used: 1 } } },
    }));
    const r = await generateImage({ prompt: 'a deep-sea fish' }, { apiKey: KEY, fetchImpl: fetch });
    expect(r).toEqual({ image_url: 'https://img.recraft.ai/abc.png', credits_used: 1, model: 'recraftv3' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('https://external.api.recraft.ai/v1/images/generations');
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('defaults credits_used to 0 when meta.usage is missing', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    const r = await generateImage({ prompt: 'p' }, { apiKey: KEY, fetchImpl: fetch });
    expect(r.credits_used).toBe(0);
    expect(r.model).toBe('recraftv3');
  });

  it('passes style_id through unchanged when provided', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    await generateImage(
      { prompt: 'p', style_id: 'style-uuid-123' },
      { apiKey: KEY, fetchImpl: fetch },
    );
    expect(calls[0]!.body.style_id).toBe('style-uuid-123');
    expect(calls[0]!.body.style).toBeUndefined();
  });

  it('uses the digital_illustration/hand_drawn default when no style_id is provided', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    await generateImage({ prompt: 'p' }, { apiKey: KEY, fetchImpl: fetch });
    expect(calls[0]!.body.style).toBe('digital_illustration/hand_drawn');
    expect(calls[0]!.body.style_id).toBeUndefined();
  });

  it('uses 1024x1024 as the default size and passes through an explicit size', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    await generateImage({ prompt: 'p' }, { apiKey: KEY, fetchImpl: fetch });
    expect(calls[0]!.body.size).toBe('1024x1024');

    const { fetch: fetch2, calls: calls2 } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/y.png' }] } }));
    await generateImage({ prompt: 'p', size: '1536x1024' }, { apiKey: KEY, fetchImpl: fetch2 });
    expect(calls2[0]!.body.size).toBe('1536x1024');
  });

  it('throws when the API returns a non-ok status, including the response body', async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 402, bodyText: 'Insufficient credits' }));
    await expect(generateImage({ prompt: 'p' }, { apiKey: KEY, fetchImpl: fetch })).rejects.toThrow(
      /Recraft API error 402.*Insufficient credits/,
    );
  });

  it('throws when the response is missing a URL', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: { data: [] } }));
    await expect(generateImage({ prompt: 'p' }, { apiKey: KEY, fetchImpl: fetch })).rejects.toThrow(
      /missing image URL/,
    );
  });

  it('throws a clear error when RECRAFT_API_KEY is not set', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    await expect(generateImage({ prompt: 'p' }, { fetchImpl: fetch })).rejects.toThrow(/RECRAFT_API_KEY is not set/);
  });

  it('reads RECRAFT_API_KEY from process.env when no apiKey option is passed', async () => {
    process.env.RECRAFT_API_KEY = 'from-env';
    const { fetch, calls } = makeFetch(() => ({ ok: true, bodyJson: { data: [{ url: 'https://img.recraft.ai/x.png' }] } }));
    await generateImage({ prompt: 'p' }, { fetchImpl: fetch });
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-env');
  });
});

describe('runChat: generate_image dispatch', () => {
  beforeEach(() => {
    process.env.RECRAFT_API_KEY = 'rt-test-key';
    // Stub global fetch so the chat-runtime dispatch reaches Recraft via the
    // handler's default fetch path.
    (globalThis as { __recraftFetchCalls?: CapturedRequest[] }).__recraftFetchCalls = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { __originalFetch?: typeof fetch }).__originalFetch = originalFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith('https://external.api.recraft.ai/')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        (globalThis as { __recraftFetchCalls?: CapturedRequest[] }).__recraftFetchCalls!.push({
          url,
          init: init ?? {},
          body,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ url: 'https://img.recraft.ai/generated.png' }],
            meta: { usage: { credits_used: 1 } },
          }),
          text: async () => '',
        } as unknown as Response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    const original = (globalThis as { __originalFetch?: typeof fetch }).__originalFetch;
    if (original) globalThis.fetch = original;
    delete process.env.RECRAFT_API_KEY;
  });

  it('emits tool_call and tool_result with JSON-stringified image payload, and persists the row', async () => {
    const fx = seedFakeDb({ approvalMode: 'autonomous' });
    const anthropic = new FakeAnthropic([
      {
        text: 'On it.',
        toolUses: [{ id: 'tu_1', name: 'generate_image', input: { prompt: 'oar fish in the deep' } }],
        stopReason: 'tool_use',
        inputTokens: 20,
        outputTokens: 5,
      },
      {
        text: 'Here you go: ![oar fish](https://img.recraft.ai/generated.png)',
        stopReason: 'end_turn',
        inputTokens: 30,
        outputTokens: 12,
      },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'Make me a hero image.',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const toolCall = events.find((e) => e.type === 'tool_call') as
      | (Extract<ChatStreamEvent, { type: 'tool_call' }> | undefined);
    expect(toolCall).toBeTruthy();
    expect(toolCall?.name).toBe('generate_image');
    expect(toolCall?.input).toEqual({ prompt: 'oar fish in the deep' });

    const toolResult = events.find((e) => e.type === 'tool_result') as
      | (Extract<ChatStreamEvent, { type: 'tool_result' }> | undefined);
    expect(toolResult).toBeTruthy();
    expect(toolResult?.queued_for_approval).toBeFalsy();
    expect(toolResult?.output).toMatchObject({
      image_url: 'https://img.recraft.ai/generated.png',
      credits_used: 1,
      model: 'recraftv3',
    });

    const recraftCalls = (globalThis as { __recraftFetchCalls?: CapturedRequest[] }).__recraftFetchCalls!;
    expect(recraftCalls).toHaveLength(1);
    expect(recraftCalls[0]!.body.prompt).toBe('oar fish in the deep');
    expect(recraftCalls[0]!.body.model).toBe('recraftv3');

    const messages = fx.db.tableRows('messages');
    const resultRow = messages.find((m) => m.role === 'tool_result' && m.tool_name === 'generate_image');
    expect(resultRow).toBeTruthy();
    const stored = resultRow!.tool_output as Record<string, unknown>;
    expect(stored.image_url).toBe('https://img.recraft.ai/generated.png');
    expect(stored.credits_used).toBe(1);
    expect(stored.model).toBe('recraftv3');

    // Sanity: the agent's next turn embedded the URL using markdown.
    const assistantTexts = messages.filter((m) => m.role === 'assistant').map((m) => m.content as string);
    expect(assistantTexts.some((t) => t.includes('![oar fish](https://img.recraft.ai/generated.png)'))).toBe(true);
  });

  it('returns an error payload (not throwing) when the Recraft call fails', async () => {
    // Override the global fetch installed in beforeEach to fail.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith('https://external.api.recraft.ai/')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
      }
      throw new Error('unexpected fetch');
    }) as typeof fetch;

    const fx = seedFakeDb({ approvalMode: 'autonomous' });
    const anthropic = new FakeAnthropic([
      {
        text: '',
        toolUses: [{ id: 'tu_err', name: 'generate_image', input: { prompt: 'p' } }],
        stopReason: 'tool_use',
        inputTokens: 5,
        outputTokens: 1,
      },
      {
        text: 'sorry that failed',
        stopReason: 'end_turn',
        inputTokens: 6,
        outputTokens: 3,
      },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'try again',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const toolResult = events.find((e) => e.type === 'tool_result') as
      | (Extract<ChatStreamEvent, { type: 'tool_result' }> | undefined);
    expect(toolResult).toBeTruthy();
    expect(toolResult?.output.ok).toBe(false);
    expect(String(toolResult?.output.error)).toMatch(/Recraft API error 500/);
  });
});
