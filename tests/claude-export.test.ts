import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildClassifierPrompts,
  classifyConversation,
  extractJson,
  extractMessageText,
  ingestOneConversation,
  loadWorkspaceIdMap,
  makeAnthropicClassifier,
  parseConversations,
  renderConversationMarkdown,
  summarise,
  estimateCost,
  type Classifier,
  type ConversationRunReport,
  type ParsedConversation,
} from '../shared/claude-export.js';
import { FakeDb, FakeSupabaseClient } from './fakes/fake-supabase.js';
import { EMBEDDINGS_DIM } from '../shared/embeddings.js';

const FIXTURE_PATH = join(__dirname, 'fixtures/sample-export/conversations.json');
const FAKE_VEC = Array.from({ length: EMBEDDINGS_DIM }, () => 0.001);
const fakeEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => FAKE_VEC);

function loadFixture(): ParsedConversation[] {
  return parseConversations(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
}

function clientWithWorkspaces(): { client: SupabaseClient; db: FakeDb; workspaceIds: Record<string, string> } {
  const db = new FakeDb();
  const workspaceIds = { pmhc: 'ws-pmhc', kca: 'ws-kca', personal: 'ws-personal', budget: 'ws-budget', dev: 'ws-dev' } as Record<string, string>;
  db.seedTable('workspaces', Object.entries(workspaceIds).map(([slug, id]) => ({ id, slug })));
  db.seedTable('knowledge_documents', []);
  db.seedTable('knowledge_chunks', []);
  return { client: new FakeSupabaseClient(db) as unknown as SupabaseClient, db, workspaceIds };
}

// ---------- Parser ----------

describe('extractMessageText', () => {
  it('prefers text when present', () => {
    expect(extractMessageText({ text: 'hello', content: [{ type: 'text', text: 'ignored' }] })).toBe('hello');
  });
  it('falls back to content[].text blocks', () => {
    expect(extractMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\n\nb');
  });
  it('skips non-text blocks', () => {
    expect(extractMessageText({ content: [{ type: 'image' }, { type: 'text', text: 'x' }, { type: 'tool_use' }] })).toBe('x');
  });
  it('returns empty string when nothing usable', () => {
    expect(extractMessageText({})).toBe('');
    expect(extractMessageText({ content: [{ type: 'image' }] })).toBe('');
  });
});

describe('parseConversations', () => {
  it('parses the fixture and skips empty conversations', () => {
    const convs = loadFixture();
    expect(convs).toHaveLength(6); // 7 in file, one empty is dropped
    const titles = convs.map((c) => c.name);
    expect(titles).toContain('Beacon platform Q3 plan');
    expect(titles).not.toContain('Empty conversation');
  });
  it('handles both text and content[] message shapes', () => {
    const convs = loadFixture();
    const kca = convs.find((c) => c.uuid.startsWith('22222222'))!;
    expect(kca.messages[0]?.text).toContain('Guulabaa');
    const pmhc = convs.find((c) => c.uuid.startsWith('11111111'))!;
    expect(pmhc.messages[0]?.text).toContain('Beacon');
  });
  it('returns [] for non-array input', () => {
    expect(parseConversations({})).toEqual([]);
    expect(parseConversations(null)).toEqual([]);
  });
});

// ---------- Markdown ----------

describe('renderConversationMarkdown', () => {
  it('produces a 4-message conversation as expected', () => {
    const conv: ParsedConversation = {
      uuid: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      name: 'Test convo',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      messages: [
        { uuid: 'a', sender: 'human', text: 'Hello.', created_at: null },
        { uuid: 'b', sender: 'assistant', text: 'Hi back.', created_at: null },
        { uuid: 'c', sender: 'human', text: 'How are you?', created_at: null },
        { uuid: 'd', sender: 'assistant', text: 'Good.', created_at: null },
      ],
    };
    const md = renderConversationMarkdown(conv);
    expect(md).toContain('# Test convo');
    expect(md).toContain('Source: Claude.ai export, conversation 12345678');
    expect(md).toContain('## Message 1: Paul');
    expect(md).toContain('## Message 2: Assistant');
    expect(md).toContain('## Message 4: Assistant');
    expect(md.indexOf('Hello.')).toBeGreaterThan(md.indexOf('Message 1'));
  });

  it('preserves fenced code blocks verbatim', () => {
    const conv: ParsedConversation = {
      uuid: 'aaaaaaaa-1111-2222-3333-444444444444',
      name: 'Code',
      created_at: null,
      updated_at: null,
      messages: [
        { uuid: 'a', sender: 'human', text: 'Here:\n```ts\nconst x = 1;\n```', created_at: null },
      ],
    };
    const md = renderConversationMarkdown(conv);
    expect(md).toContain('```ts\nconst x = 1;\n```');
  });
});

// ---------- Classifier ----------

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses JSON inside markdown fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses JSON surrounded by prose', () => {
    expect(extractJson('Sure, here:\n{"a":1}\n.')).toEqual({ a: 1 });
  });
  it('parses JSON when followed by trailing prose', () => {
    expect(extractJson('{"workspace":"pmhc"}\n\nThat is the classification.')).toEqual({ workspace: 'pmhc' });
  });
  it('handles nested objects with trailing prose using balanced matching', () => {
    expect(extractJson('{"a":1,"b":{"c":2}} more text')).toEqual({ a: 1, b: { c: 2 } });
  });
  it('recovers when the model was truncated mid-object (no closing brace)', () => {
    expect(extractJson('{"workspace":"pmhc","confidence":0.9,"reasoning":"x"')).toEqual({
      workspace: 'pmhc',
      confidence: 0.9,
      reasoning: 'x',
    });
  });
  it('returns null on garbage', () => {
    expect(extractJson('not json')).toBeNull();
  });
});

describe('classifyConversation', () => {
  const conv: ParsedConversation = {
    uuid: 'x',
    name: 't',
    created_at: null,
    updated_at: null,
    messages: [
      { uuid: 'a', sender: 'human', text: 'something', created_at: null },
      { uuid: 'b', sender: 'assistant', text: 'reply', created_at: null },
    ],
  };
  const classifierFor = (text: string): Classifier => async () => ({ text, usage: { inputTokens: 100, outputTokens: 20 } });

  it('classifies into a single workspace at high confidence', async () => {
    const c = await classifyConversation(conv, classifierFor('{"workspace":"pmhc","confidence":0.9,"reasoning":"council"}'));
    expect(c.classification.workspace).toBe('pmhc');
    expect(c.usage.inputTokens).toBe(100);
  });

  it('treats low confidence as none', async () => {
    const c = await classifyConversation(conv, classifierFor('{"workspace":"dev","confidence":0.2}'));
    expect(c.classification.workspace).toBe('none');
  });

  it('passes through "none"', async () => {
    const c = await classifyConversation(conv, classifierFor('{"workspace":"none","reasoning":"unrelated"}'));
    expect(c.classification.workspace).toBe('none');
  });

  it('passes through "multiple" with primary', async () => {
    const c = await classifyConversation(
      conv,
      classifierFor('{"workspace":"multiple","workspaces":["pmhc","dev"],"primary":"pmhc","confidence":0.8}'),
    );
    expect(c.classification.workspace).toBe('multiple');
    if (c.classification.workspace === 'multiple') {
      expect(c.classification.primary).toBe('pmhc');
      expect(c.classification.workspaces).toEqual(['pmhc', 'dev']);
    }
  });

  it('retries once on bad JSON, then returns none', async () => {
    let calls = 0;
    const flaky: Classifier = async () => {
      calls += 1;
      return { text: 'not parseable', usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const c = await classifyConversation(conv, flaky);
    expect(c.classification.workspace).toBe('none');
    expect(calls).toBe(2);
    expect(c.usage.inputTokens).toBe(20);
  });

  it('preserves the model reasoning when threshold flips to none', async () => {
    const c = await classifyConversation(conv, classifierFor('{"workspace":"pmhc","confidence":0.4,"reasoning":"council Beacon"}'));
    expect(c.classification.workspace).toBe('none');
    if (c.classification.workspace === 'none') {
      expect(c.classification.reasoning).toContain('low confidence');
      expect(c.classification.reasoning).toContain('pmhc');
      expect(c.classification.reasoning).toContain('council Beacon');
    }
  });

  it('honours ROOST_CLASSIFIER_MIN_CONFIDENCE override', async () => {
    const old = process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE;
    process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE = '0.3';
    try {
      const c = await classifyConversation(conv, classifierFor('{"workspace":"pmhc","confidence":0.4,"reasoning":"x"}'));
      expect(c.classification.workspace).toBe('pmhc');
    } finally {
      if (old === undefined) delete process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE;
      else process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE = old;
    }
  });

  it('honours an explicit lowConfidenceThreshold option (overrides env)', async () => {
    const old = process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE;
    process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE = '0.9';
    try {
      const c = await classifyConversation(
        conv,
        classifierFor('{"workspace":"pmhc","confidence":0.4,"reasoning":"x"}'),
        { lowConfidenceThreshold: 0.3 },
      );
      expect(c.classification.workspace).toBe('pmhc');
    } finally {
      if (old === undefined) delete process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE;
      else process.env.ROOST_CLASSIFIER_MIN_CONFIDENCE = old;
    }
  });
});

describe('projects/ ingestion', () => {
  it('parser tags conversations with the projectName when provided', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/sample-export/projects/RoostBuild/conversations.json'), 'utf8'));
    const convs = parseConversations(raw, 'RoostBuild');
    expect(convs).toHaveLength(1);
    expect(convs[0]?.projectName).toBe('RoostBuild');
  });

  it('classifier prompt includes the project name when set', () => {
    const conv: ParsedConversation = {
      uuid: 'x', name: 'Schema chat', created_at: null, updated_at: null,
      messages: [
        { uuid: 'a', sender: 'human', text: 'Roost schema?', created_at: null },
        { uuid: 'b', sender: 'assistant', text: 'Sure', created_at: null },
      ],
      projectName: 'RoostBuild',
    };
    const { userPrompt } = buildClassifierPrompts(conv);
    expect(userPrompt).toContain('Claude.ai Project: RoostBuild');
  });

  it('rendered markdown header references the project name', () => {
    const conv: ParsedConversation = {
      uuid: 'aabbccdd-1111-2222-3333-444455556666', name: 'Trip plan',
      created_at: '2026-03-01T08:00:00Z', updated_at: '2026-03-01T08:30:00Z',
      messages: [{ uuid: 'a', sender: 'human', text: 'Hi.', created_at: null }],
      projectName: 'Trip2026',
    };
    const md = renderConversationMarkdown(conv);
    expect(md).toContain('project: Trip2026');
  });

  it('ingestOneConversation stamps metadata.project when projectName is set', async () => {
    const fx = clientWithWorkspaces();
    const conv: ParsedConversation = {
      uuid: 'xx-1', name: 'Roost build chat',
      created_at: null, updated_at: null,
      messages: [
        { uuid: 'a', sender: 'human', text: 'Roost', created_at: null },
        { uuid: 'b', sender: 'assistant', text: 'Adevus', created_at: null },
      ],
      projectName: 'RoostBuild',
    };
    const classify: Classifier = async () => ({
      text: '{"workspace":"dev","confidence":0.95,"reasoning":"Roost build"}',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(r.outcome).toBe('ingested');
    const doc = fx.db.tableRows('knowledge_documents')[0]!;
    expect((doc.metadata as Record<string, unknown>).project).toBe('RoostBuild');
  });
});

describe('makeAnthropicClassifier', () => {
  const liveConv: ParsedConversation = {
    uuid: 'live',
    name: 'Beacon work',
    created_at: null,
    updated_at: null,
    messages: [
      { uuid: 'a', sender: 'human', text: 'Beacon council planning', created_at: null },
      { uuid: 'b', sender: 'assistant', text: 'Sure, here is the plan', created_at: null },
    ],
  };

  it('uses assistant prefill `{` and stitches it back so extractJson sees full JSON', async () => {
    let captured: { body: { messages: Array<{ role: string; content: string }> } } | null = null;
    const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      captured = { body };
      // Anthropic returns just the completion AFTER the prefill.
      const completion = '"workspace":"pmhc","confidence":0.9,"reasoning":"council"}';
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: completion }],
        usage: { input_tokens: 100, output_tokens: 30 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const classifier = makeAnthropicClassifier({ apiKey: 'k', fetchImpl: fakeFetch });
    const out = await classifier({ systemPrompt: 'sys', userPrompt: 'usr' });
    expect(captured!.body.messages).toHaveLength(2);
    expect(captured!.body.messages[1]).toEqual({ role: 'assistant', content: '{' });
    // Reconstructed text is parseable JSON.
    expect(JSON.parse(out.text)).toEqual({ workspace: 'pmhc', confidence: 0.9, reasoning: 'council' });
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 30 });
  });

  it('end-to-end classifyConversation with the live shape returns the workspace', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '"workspace":"kca","confidence":0.92,"reasoning":"Guulabaa"}' }],
      usage: { input_tokens: 80, output_tokens: 25 },
    }), { status: 200 })) as unknown as typeof fetch;
    const classifier = makeAnthropicClassifier({ apiKey: 'k', fetchImpl: fakeFetch });
    const c = await classifyConversation(liveConv, classifier);
    expect(c.classification.workspace).toBe('kca');
  });
});

describe('buildClassifierPrompts', () => {
  it('truncates message snippets', () => {
    const longText = 'a'.repeat(2000);
    const conv: ParsedConversation = {
      uuid: 'x', name: 't', created_at: null, updated_at: null,
      messages: [
        { uuid: '1', sender: 'human', text: longText, created_at: null },
        { uuid: '2', sender: 'assistant', text: longText, created_at: null },
      ],
    };
    const { userPrompt } = buildClassifierPrompts(conv);
    expect(userPrompt.length).toBeLessThan(longText.length);
    expect(userPrompt).toContain('...');
  });
});

// ---------- Ingest pipeline ----------

function fixedClassifierByTitle(map: Record<string, string>): Classifier {
  return async ({ userPrompt }) => {
    const titleMatch = userPrompt.match(/Title: (.*)/);
    const title = titleMatch?.[1] ?? '';
    const json = map[title] ?? '{"workspace":"none","reasoning":"unmapped"}';
    return { text: json, usage: { inputTokens: 100, outputTokens: 20 } };
  };
}

const FIXTURE_CLASSIFICATIONS: Record<string, string> = {
  'Beacon platform Q3 plan': '{"workspace":"pmhc","confidence":0.9,"reasoning":"council Beacon"}',
  'Koala hospital fundraising letter': '{"workspace":"kca","confidence":0.95,"reasoning":"KCA"}',
  'Foster care meal plan': '{"workspace":"personal","confidence":0.85,"reasoning":"household"}',
  'Roost backend Phase 3 schema': '{"workspace":"dev","confidence":0.95,"reasoning":"Adevus"}',
  'Random trivia question': '{"workspace":"none","reasoning":"unrelated"}',
  'AI strategy and Adevus product roadmap': '{"workspace":"multiple","workspaces":["pmhc","dev"],"primary":"pmhc","confidence":0.7}',
};

describe('ingestOneConversation', () => {
  it('ingests a single workspace conversation end-to-end', async () => {
    const fx = clientWithWorkspaces();
    const convs = loadFixture();
    const conv = convs.find((c) => c.name === 'Beacon platform Q3 plan')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(r.outcome).toBe('ingested');
    expect(r.workspaceSlug).toBe('pmhc');
    expect(r.result?.chunkCount).toBeGreaterThan(0);

    const docs = fx.db.tableRows('knowledge_documents');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.workspace_id).toBe(fx.workspaceIds.pmhc);
    expect(docs[0]?.source_ref).toBe(`claude_export:${conv.uuid}`);
    expect(docs[0]?.title).toBe(conv.name);

    const chunks = fx.db.tableRows('knowledge_chunks');
    expect(chunks.length).toBe(r.result?.chunkCount);
  });

  it('skips re-ingest by default', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Beacon platform Q3 plan')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    const second = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(second.outcome).toBe('skip-existing');
    expect(fx.db.tableRows('knowledge_documents')).toHaveLength(1);
  });

  it('--force re-ingests even when row exists', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Beacon platform Q3 plan')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    const initialChunkIds = fx.db.tableRows('knowledge_chunks').map((c) => c.id);
    const second = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, { force: true });
    expect(second.outcome).toBe('ingested');
    const afterIds = fx.db.tableRows('knowledge_chunks').map((c) => c.id);
    for (const id of afterIds) expect(initialChunkIds).not.toContain(id);
  });

  it('skips none-classified conversations without writes', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Random trivia question')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(r.outcome).toBe('skip-none');
    expect(fx.db.tableRows('knowledge_documents')).toHaveLength(0);
  });

  it('routes "multiple" classifications into the primary workspace and tags secondaries', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'AI strategy and Adevus product roadmap')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(r.outcome).toBe('ingested');
    expect(r.workspaceSlug).toBe('pmhc');
    const doc = fx.db.tableRows('knowledge_documents')[0]!;
    expect((doc.tags as string[]).some((t) => String(t).includes('also:dev'))).toBe(true);
    expect((doc.metadata as Record<string, unknown>).secondary_workspaces).toEqual(['dev']);
  });

  it('respects --exclude-personal', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Foster care meal plan')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, { excludePersonal: true });
    expect(r.outcome).toBe('skip-personal-excluded');
    expect(fx.db.tableRows('knowledge_documents')).toHaveLength(0);
  });

  it('--dry-run classifies but does not persist', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Beacon platform Q3 plan')!;
    const classify = fixedClassifierByTitle(FIXTURE_CLASSIFICATIONS);
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, { dryRun: true });
    expect(r.outcome).toBe('ingested-dry');
    expect(fx.db.tableRows('knowledge_documents')).toHaveLength(0);
  });

  it('high-confidence single-workspace classification does not flip to none', async () => {
    // The user-stated invariant: budget@0.95 with default threshold 0.5
    // must surface as workspace=budget end-to-end.
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Foster care meal plan')!; // generic body, classifier decides
    const classify: Classifier = async () => ({
      text: '{"workspace":"budget","confidence":0.95,"reasoning":"household finances and Float app"}',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, fx.workspaceIds, conv, {});
    expect(r.outcome).toBe('ingested');
    expect(r.workspaceSlug).toBe('budget');
    expect(r.classification?.workspace).toBe('budget');
  });

  it('dry-run with empty workspaceIds still surfaces high-confidence classifications', async () => {
    // Reproduces the live bug: in --dry-run the CLI passes an empty
    // workspaceIds map (no DB connection), so the slug→id lookup
    // fails and the conversation is wrongly reported as skip-none.
    // A budget@0.95 classification must come through as ingested-dry.
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Foster care meal plan')!;
    const classify: Classifier = async () => ({
      text: '{"workspace":"budget","confidence":0.95,"reasoning":"household finances and Float app"}',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, {}, conv, { dryRun: true });
    expect(r.outcome).toBe('ingested-dry');
    expect(r.workspaceSlug).toBe('budget');
    expect(r.classification?.workspace).toBe('budget');
  });

  it('non-dry-run with an unknown workspace slug returns an error outcome (not skip-none)', async () => {
    const fx = clientWithWorkspaces();
    const conv = loadFixture().find((c) => c.name === 'Foster care meal plan')!;
    const classify: Classifier = async () => ({
      text: '{"workspace":"budget","confidence":0.95,"reasoning":"x"}',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    // Strip 'budget' from the workspace map to simulate an unseeded DB.
    const partial = { ...fx.workspaceIds };
    delete (partial as Record<string, string>).budget;
    const r = await ingestOneConversation(fx.client, fakeEmbed, classify, partial, conv, {});
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('budget');
    expect(fx.db.tableRows('knowledge_documents')).toHaveLength(0);
  });
});

describe('summarise + estimateCost', () => {
  it('rolls per-workspace counts and computes cost', () => {
    const reports: ConversationRunReport[] = [
      { uuid: '1', title: 'a', outcome: 'ingested', workspaceSlug: 'pmhc', result: { status: 'created', documentId: 'd1', chunkCount: 5, totalTokens: 3000 }, classifierUsage: { inputTokens: 200, outputTokens: 30 } },
      { uuid: '2', title: 'b', outcome: 'ingested', workspaceSlug: 'kca', result: { status: 'created', documentId: 'd2', chunkCount: 3, totalTokens: 1800 }, classifierUsage: { inputTokens: 200, outputTokens: 30 } },
      { uuid: '3', title: 'c', outcome: 'skip-none', classifierUsage: { inputTokens: 200, outputTokens: 30 } },
      { uuid: '4', title: 'd', outcome: 'skip-existing' },
    ];
    const sum = summarise(reports);
    expect(sum.totalIngestedConversations).toBe(2);
    expect(sum.totalChunks).toBe(8);
    expect(sum.totalEmbedTokens).toBe(4800);
    expect(sum.skippedNone).toBe(1);
    expect(sum.skippedExisting).toBe(1);
    expect(sum.classifierInputTokens).toBe(600);
    expect(sum.classifierOutputTokens).toBe(90);
    const cost = estimateCost(sum);
    expect(cost.voyageUsd).toBeGreaterThan(0);
    expect(cost.classifierUsd).toBeGreaterThan(0);
    expect(cost.totalUsd).toBeCloseTo(cost.voyageUsd + cost.classifierUsd, 6);
  });
});

describe('loadWorkspaceIdMap', () => {
  it('returns slug to id mapping', async () => {
    const fx = clientWithWorkspaces();
    const map = await loadWorkspaceIdMap(fx.client);
    expect(map.pmhc).toBe(fx.workspaceIds.pmhc);
    expect(map.kca).toBe(fx.workspaceIds.kca);
    expect(map.dev).toBe(fx.workspaceIds.dev);
  });
});
