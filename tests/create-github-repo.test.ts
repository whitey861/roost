// Roost: tests for the create_github_repo tool wiring.
// Covers registry shape, allow-list scoping to buildit + dev, handler unit
// behaviour against a fake fetch (success, 422 name collision, 401
// unauthorized, bad input), and chat-runtime dispatch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runChat } from '../shared/chat-runtime.js';
import { TOOLS } from '../shared/tools.js';
import { AGENTS } from '../shared/agents.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { createGithubRepo } from '../shared/tool-handlers/create-github-repo.js';
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
  method: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

interface ResponderResult {
  ok: boolean;
  status?: number;
  bodyText?: string;
  bodyJson?: unknown;
}

function makeFetch(
  responder: (req: CapturedRequest) => ResponderResult,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = (init?.body as string | undefined) ?? '';
    let body: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const captured: CapturedRequest = { url, method, init: init ?? {}, body };
    calls.push(captured);
    const r = responder(captured);
    const text = r.bodyText ?? (r.bodyJson != null ? JSON.stringify(r.bodyJson) : '');
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => (r.bodyJson ?? (text ? JSON.parse(text) : {})) as unknown,
      text: async () => text,
    } as unknown as Response;
  };
  return { fetch: fn, calls };
}

describe('tool registry: create_github_repo', () => {
  it('exists with handler_type internal, is_outbound true, and a valid schema', () => {
    const t = TOOLS.find((x) => x.name === 'create_github_repo');
    expect(t).toBeTruthy();
    expect(t?.handlerType).toBe('internal');
    expect(t?.requiresApprovalDefault).toBe(false);
    expect(t?.isOutbound).toBe(true);
    const schema = t!.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['name']);
    expect(schema.properties.name).toBeTruthy();
    expect(schema.properties.description).toBeTruthy();
    expect(schema.properties.private).toBeTruthy();
    expect(schema.properties.owner).toBeTruthy();
  });

  it('is scoped to buildit and dev workspaces', () => {
    const t = TOOLS.find((x) => x.name === 'create_github_repo')!;
    expect(new Set(t.workspaceScope)).toEqual(new Set(['buildit', 'dev']));
  });
});

describe('default agent allow-lists: create_github_repo', () => {
  it('buildit and dev have create_github_repo; other workspaces do not', () => {
    const buildit = AGENTS.find((a) => a.workspaceSlug === 'buildit')!;
    const dev = AGENTS.find((a) => a.workspaceSlug === 'dev')!;
    expect(buildit.toolNames).toContain('create_github_repo');
    expect(dev.toolNames).toContain('create_github_repo');
    for (const a of AGENTS) {
      if (a.workspaceSlug === 'buildit' || a.workspaceSlug === 'dev') continue;
      expect(a.toolNames).not.toContain('create_github_repo');
    }
  });
});

describe('createGithubRepo handler: unit', () => {
  const TOKEN = 'gh_test_token';

  beforeEach(() => {
    delete process.env.GITHUB_REPO_CREATE_TOKEN;
  });
  afterEach(() => {
    delete process.env.GITHUB_REPO_CREATE_TOKEN;
  });

  it('success path: POSTs to /user/repos and returns full_name/clone_url/html_url', async () => {
    const { fetch, calls } = makeFetch((req) => {
      if (req.method === 'POST' && req.url === 'https://api.github.com/user/repos') {
        return {
          ok: true,
          status: 201,
          bodyJson: {
            full_name: 'whitey861/andypandy',
            clone_url: 'https://github.com/whitey861/andypandy.git',
            html_url: 'https://github.com/whitey861/andypandy',
          },
        };
      }
      return { ok: false, status: 500, bodyText: 'unexpected' };
    });

    const result = await createGithubRepo(
      { name: 'andypandy', description: 'salon CRM' },
      { token: TOKEN, fetchImpl: fetch },
    );

    expect(result).toEqual({
      full_name: 'whitey861/andypandy',
      clone_url: 'https://github.com/whitey861/andypandy.git',
      html_url: 'https://github.com/whitey861/andypandy',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.github.com/user/repos');
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(calls[0]!.body).toEqual({
      name: 'andypandy',
      private: true,
      description: 'salon CRM',
    });
  });

  it('defaults private to true and omits description when not provided', async () => {
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      status: 201,
      bodyJson: {
        full_name: 'me/foo',
        clone_url: 'https://github.com/me/foo.git',
        html_url: 'https://github.com/me/foo',
      },
    }));
    await createGithubRepo({ name: 'foo' }, { token: TOKEN, fetchImpl: fetch });
    expect(calls[0]!.body).toEqual({ name: 'foo', private: true });
  });

  it('respects an explicit private: false', async () => {
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      status: 201,
      bodyJson: {
        full_name: 'me/foo',
        clone_url: 'https://github.com/me/foo.git',
        html_url: 'https://github.com/me/foo',
      },
    }));
    await createGithubRepo({ name: 'foo', private: false }, { token: TOKEN, fetchImpl: fetch });
    expect((calls[0]!.body as { private: boolean }).private).toBe(false);
  });

  it('owner is an org: POSTs to /orgs/{owner}/repos', async () => {
    const { fetch, calls } = makeFetch((req) => {
      if (req.method === 'GET' && req.url === 'https://api.github.com/users/adevus') {
        return { ok: true, status: 200, bodyJson: { type: 'Organization', login: 'adevus' } };
      }
      if (req.method === 'POST' && req.url === 'https://api.github.com/orgs/adevus/repos') {
        return {
          ok: true,
          status: 201,
          bodyJson: {
            full_name: 'adevus/widget',
            clone_url: 'https://github.com/adevus/widget.git',
            html_url: 'https://github.com/adevus/widget',
          },
        };
      }
      return { ok: false, status: 500, bodyText: `unexpected ${req.method} ${req.url}` };
    });

    const result = await createGithubRepo(
      { name: 'widget', owner: 'adevus' },
      { token: TOKEN, fetchImpl: fetch },
    );
    expect(result.full_name).toBe('adevus/widget');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/users/adevus',
      'POST https://api.github.com/orgs/adevus/repos',
    ]);
  });

  it('owner is a user account: still POSTs to /user/repos', async () => {
    const { fetch, calls } = makeFetch((req) => {
      if (req.method === 'GET' && req.url === 'https://api.github.com/users/whitey861') {
        return { ok: true, status: 200, bodyJson: { type: 'User', login: 'whitey861' } };
      }
      if (req.method === 'POST' && req.url === 'https://api.github.com/user/repos') {
        return {
          ok: true,
          status: 201,
          bodyJson: {
            full_name: 'whitey861/foo',
            clone_url: 'https://github.com/whitey861/foo.git',
            html_url: 'https://github.com/whitey861/foo',
          },
        };
      }
      return { ok: false, status: 500, bodyText: `unexpected ${req.method} ${req.url}` };
    });

    const result = await createGithubRepo(
      { name: 'foo', owner: 'whitey861' },
      { token: TOKEN, fetchImpl: fetch },
    );
    expect(result.full_name).toBe('whitey861/foo');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/users/whitey861',
      'POST https://api.github.com/user/repos',
    ]);
  });

  it('name collision: throws with a 422 error including the GitHub message', async () => {
    const { fetch } = makeFetch(() => ({
      ok: false,
      status: 422,
      bodyJson: {
        message: 'Validation Failed',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    }));
    await expect(
      createGithubRepo({ name: 'andypandy' }, { token: TOKEN, fetchImpl: fetch }),
    ).rejects.toThrow(/GitHub API error 422.*Validation Failed.*name.*already exists/);
  });

  it('unauthorized: throws with a 401 error', async () => {
    const { fetch } = makeFetch(() => ({
      ok: false,
      status: 401,
      bodyJson: { message: 'Bad credentials' },
    }));
    await expect(
      createGithubRepo({ name: 'foo' }, { token: 'bogus', fetchImpl: fetch }),
    ).rejects.toThrow(/GitHub API error 401.*Bad credentials/);
  });

  it('bad input: missing name', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true, bodyJson: {} }));
    await expect(
      createGithubRepo({ name: '' }, { token: TOKEN, fetchImpl: fetch }),
    ).rejects.toThrow(/name is required/);
    // deno-lint-ignore no-explicit-any
    await expect(createGithubRepo({} as any, { token: TOKEN, fetchImpl: fetch })).rejects.toThrow(/name is required/);
    expect(calls).toHaveLength(0);
  });

  it('bad input: whitespace-only name', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: {} }));
    await expect(
      createGithubRepo({ name: '   ' }, { token: TOKEN, fetchImpl: fetch }),
    ).rejects.toThrow(/name is required/);
  });

  it('throws when GITHUB_REPO_CREATE_TOKEN is not set', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: {} }));
    await expect(createGithubRepo({ name: 'foo' }, { fetchImpl: fetch })).rejects.toThrow(
      /GITHUB_REPO_CREATE_TOKEN is not set/,
    );
  });

  it('reads GITHUB_REPO_CREATE_TOKEN from process.env when no token option is passed', async () => {
    process.env.GITHUB_REPO_CREATE_TOKEN = 'from-env';
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      bodyJson: {
        full_name: 'me/foo',
        clone_url: 'https://github.com/me/foo.git',
        html_url: 'https://github.com/me/foo',
      },
    }));
    await createGithubRepo({ name: 'foo' }, { fetchImpl: fetch });
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-env');
  });

  it('throws when the response is missing repo fields', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, bodyJson: { not_a_repo: true } }));
    await expect(
      createGithubRepo({ name: 'foo' }, { token: TOKEN, fetchImpl: fetch }),
    ).rejects.toThrow(/missing repo fields/);
  });
});

describe('runChat: create_github_repo dispatch', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    process.env.GITHUB_REPO_CREATE_TOKEN = 'gh_runchat';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_REPO_CREATE_TOKEN;
  });

  it('emits tool_call and tool_result with the GitHub repo payload, and persists the row', async () => {
    const githubCalls: CapturedRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith('https://api.github.com/')) {
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? JSON.parse(init.body as string) : null;
        githubCalls.push({ url, method, init: init ?? {}, body });
        if (url === 'https://api.github.com/user/repos' && method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              full_name: 'whitey861/andypandy',
              clone_url: 'https://github.com/whitey861/andypandy.git',
              html_url: 'https://github.com/whitey861/andypandy',
            }),
            text: async () => JSON.stringify({
              full_name: 'whitey861/andypandy',
              clone_url: 'https://github.com/whitey861/andypandy.git',
              html_url: 'https://github.com/whitey861/andypandy',
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const fx = seedFakeDb({ approvalMode: 'autonomous' });
    const anthropic = new FakeAnthropic([
      {
        text: 'Creating the repo.',
        toolUses: [{ id: 'tu_1', name: 'create_github_repo', input: { name: 'andypandy', description: 'salon CRM' } }],
        stopReason: 'tool_use',
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        text: 'Repo created: whitey861/andypandy.',
        stopReason: 'end_turn',
        inputTokens: 12,
        outputTokens: 8,
      },
    ]);

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'spin up a new repo',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const toolCall = events.find((e) => e.type === 'tool_call') as
      | (Extract<ChatStreamEvent, { type: 'tool_call' }> | undefined);
    expect(toolCall).toBeTruthy();
    expect(toolCall?.name).toBe('create_github_repo');
    expect(toolCall?.input).toEqual({ name: 'andypandy', description: 'salon CRM' });

    const toolResult = events.find((e) => e.type === 'tool_result') as
      | (Extract<ChatStreamEvent, { type: 'tool_result' }> | undefined);
    expect(toolResult).toBeTruthy();
    expect(toolResult?.queued_for_approval).toBeFalsy();
    expect(toolResult?.output).toEqual({
      full_name: 'whitey861/andypandy',
      clone_url: 'https://github.com/whitey861/andypandy.git',
      html_url: 'https://github.com/whitey861/andypandy',
    });

    expect(githubCalls).toHaveLength(1);
    expect(githubCalls[0]!.url).toBe('https://api.github.com/user/repos');
    expect(githubCalls[0]!.body).toEqual({
      name: 'andypandy',
      private: true,
      description: 'salon CRM',
    });

    const messages = fx.db.tableRows('messages');
    const resultRow = messages.find((m) => m.role === 'tool_result' && m.tool_name === 'create_github_repo');
    expect(resultRow).toBeTruthy();
    const stored = resultRow!.tool_output as Record<string, unknown>;
    expect(stored.full_name).toBe('whitey861/andypandy');
    expect(stored.clone_url).toBe('https://github.com/whitey861/andypandy.git');
    expect(stored.html_url).toBe('https://github.com/whitey861/andypandy');
  });

  it('returns an error payload (not throwing) when GitHub returns 422 name collision', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith('https://api.github.com/')) {
        return {
          ok: false,
          status: 422,
          json: async () => ({
            message: 'Validation Failed',
            errors: [{ field: 'name', code: 'custom', message: 'name already exists on this account' }],
          }),
          text: async () => JSON.stringify({
            message: 'Validation Failed',
            errors: [{ field: 'name', code: 'custom', message: 'name already exists on this account' }],
          }),
        } as unknown as Response;
      }
      throw new Error('unexpected fetch');
    }) as typeof fetch;

    const fx = seedFakeDb({ approvalMode: 'autonomous' });
    const anthropic = new FakeAnthropic([
      {
        text: '',
        toolUses: [{ id: 'tu_err', name: 'create_github_repo', input: { name: 'andypandy' } }],
        stopReason: 'tool_use',
        inputTokens: 5,
        outputTokens: 1,
      },
      {
        text: 'pick a different name',
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
    expect(String(toolResult?.output.error)).toMatch(/GitHub API error 422/);
    expect(String(toolResult?.output.error)).toMatch(/already exists/);
  });
});
