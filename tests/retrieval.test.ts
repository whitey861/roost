import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDb, FakeSupabaseClient } from './fakes/fake-supabase.js';
import { retrieveTopK, formatKnowledgeBlock } from '../shared/retrieval.js';
import { EMBEDDINGS_DIM } from '../shared/embeddings.js';

function vec(seed: number): number[] {
  const out = new Array<number>(EMBEDDINGS_DIM);
  for (let i = 0; i < EMBEDDINGS_DIM; i++) out[i] = Math.sin(seed + i) * 0.01;
  return out;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (const x of a) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b));
}

interface ChunkRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  workspace_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
}

interface DocRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  title: string;
  source_ref: string;
  source_url: string | null;
}

function buildFixture(): { db: FakeDb; client: SupabaseClient; queryEmbedding: number[]; ws1: string; ws2: string } {
  const db = new FakeDb();
  const ws1 = 'ws-1';
  const ws2 = 'ws-2';

  const docs: DocRow[] = [
    { id: 'doc-a', workspace_id: ws1, title: 'AI Strategy', source_ref: 'knowledge/pmhc/ai-strategy.md', source_url: null },
    { id: 'doc-b', workspace_id: ws1, title: 'Beacon platform', source_ref: 'knowledge/pmhc/beacon.md', source_url: null },
    { id: 'doc-c', workspace_id: ws2, title: 'Other workspace', source_ref: 'knowledge/kca/other.md', source_url: null },
  ];
  db.seedTable('knowledge_documents', docs);

  // 10 chunks across 3 docs. Chunks for ws1 closer to query embedding.
  const queryEmbedding = vec(0);
  const chunks: ChunkRow[] = [];
  // doc-a: 4 chunks
  for (let i = 0; i < 4; i++) {
    chunks.push({
      id: `chunk-a${i}`,
      document_id: 'doc-a',
      workspace_id: ws1,
      chunk_index: i,
      content: `[Section: A${i}] content for chunk a${i}`,
      embedding: vec(i + 1),
    });
  }
  // doc-b: 3 chunks
  for (let i = 0; i < 3; i++) {
    chunks.push({
      id: `chunk-b${i}`,
      document_id: 'doc-b',
      workspace_id: ws1,
      chunk_index: i,
      content: `[Section: B${i}] content for chunk b${i}`,
      embedding: vec((i + 1) * 7),
    });
  }
  // doc-c: 3 chunks in a different workspace
  for (let i = 0; i < 3; i++) {
    chunks.push({
      id: `chunk-c${i}`,
      document_id: 'doc-c',
      workspace_id: ws2,
      chunk_index: i,
      content: `[Section: C${i}] cross-workspace content`,
      embedding: vec(i + 100),
    });
  }
  db.seedTable('knowledge_chunks', chunks);

  const client = new FakeSupabaseClient(db);

  // Stub the embedQuery call. Retrieval calls embedQuery, which calls
  // Voyage. We bypass it by registering an RPC that uses the queryEmbedding
  // we already know. The real embedQuery is not called because we will
  // pass embedOptions.fetchImpl that returns our fixed vector.
  client.registerRpc('match_knowledge_chunks', async (args) => {
    const queryEmb = args.query_embedding as number[];
    const wsId = args.ws_id as string;
    const k = args.match_count as number;
    const cs = chunks
      .filter((c) => c.workspace_id === wsId)
      .map((c) => ({
        document_id: c.document_id,
        document_title: docs.find((d) => d.id === c.document_id)!.title,
        source_ref: docs.find((d) => d.id === c.document_id)!.source_ref,
        source_url: docs.find((d) => d.id === c.document_id)!.source_url,
        chunk_index: c.chunk_index,
        content: c.content,
        similarity: cosine(c.embedding, queryEmb),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
    return { data: cs, error: null };
  });

  return { db, client: client as unknown as SupabaseClient, queryEmbedding, ws1, ws2 };
}

// Voyage stub: return a fixed vector for any input.
function voyageStub(vector: number[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
    const data = body.input.map((_, i) => ({ embedding: vector, index: i }));
    return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('retrieveTopK', () => {
  it('returns top-K hits in descending similarity within the workspace', async () => {
    const fx = buildFixture();
    const hits = await retrieveTopK(fx.client, fx.ws1, 'anything', 4, -1, {
      embedOptions: { apiKey: 'k', fetchImpl: voyageStub(fx.queryEmbedding) },
    });
    expect(hits).toHaveLength(4);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.similarity).toBeGreaterThanOrEqual(hits[i]!.similarity);
    }
    // None of the cross-workspace doc-c chunks
    for (const h of hits) expect(h.document_id).not.toBe('doc-c');
  });

  it('respects the workspace filter', async () => {
    const fx = buildFixture();
    const hits = await retrieveTopK(fx.client, fx.ws2, 'anything', 4, -1, {
      embedOptions: { apiKey: 'k', fetchImpl: voyageStub(fx.queryEmbedding) },
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.document_id).toBe('doc-c');
  });

  it('respects the minSimilarity threshold', async () => {
    const fx = buildFixture();
    const hits = await retrieveTopK(fx.client, fx.ws1, 'anything', 10, 0.99, {
      embedOptions: { apiKey: 'k', fetchImpl: voyageStub(fx.queryEmbedding) },
    });
    // Threshold 0.99 should reject everything.
    expect(hits).toHaveLength(0);
  });

  it('returns [] for an empty query without calling Voyage', async () => {
    const fx = buildFixture();
    const hits = await retrieveTopK(fx.client, fx.ws1, '   ', 4, 0);
    expect(hits).toHaveLength(0);
  });

  it('returns [] when embedding fails (graceful no-op)', async () => {
    const fx = buildFixture();
    // 400 is non-retriable, so we don't sit through the backoff schedule.
    const hits = await retrieveTopK(fx.client, fx.ws1, 'q', 4, 0, {
      embedOptions: {
        apiKey: 'k',
        fetchImpl: (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch,
      },
    });
    expect(hits).toHaveLength(0);
  });
});

describe('formatKnowledgeBlock', () => {
  it('returns empty string for no hits', () => {
    expect(formatKnowledgeBlock([])).toBe('');
  });
  it('wraps hits in <workspace_knowledge> with title and source_ref', () => {
    const block = formatKnowledgeBlock([
      { document_id: 'd1', document_title: 'AI Strategy', source_ref: 'knowledge/pmhc/ai.md', source_url: null, chunk_index: 0, content: 'Some text.', similarity: 0.8 },
    ]);
    expect(block).toContain('<workspace_knowledge>');
    expect(block).toContain('AI Strategy');
    expect(block).toContain('knowledge/pmhc/ai.md');
    expect(block).toContain('Some text.');
    expect(block).toContain('</workspace_knowledge>');
  });
});
