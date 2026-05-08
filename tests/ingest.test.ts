import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDb, FakeSupabaseClient } from './fakes/fake-supabase.js';
import { ingestDocument, parseFrontmatter } from '../shared/ingest-core.js';
import { EMBEDDINGS_DIM } from '../shared/embeddings.js';

const FAKE_VEC = Array.from({ length: EMBEDDINGS_DIM }, () => 0.001);
const fakeEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => FAKE_VEC);

function setupClient(): { client: SupabaseClient; db: FakeDb; workspaceId: string } {
  const db = new FakeDb();
  const workspaceId = 'ws-123';
  db.seedTable('workspaces', [{ id: workspaceId, slug: 'pmhc' }]);
  db.seedTable('knowledge_documents', []);
  db.seedTable('knowledge_chunks', []);
  return { client: new FakeSupabaseClient(db) as unknown as SupabaseClient, db, workspaceId };
}

describe('parseFrontmatter', () => {
  it('parses a simple block', () => {
    const raw = `---
title: AI Strategy
tags: [strategy, pmhc]
source_url: https://example.com/x
---
Body here.
`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('AI Strategy');
    expect(frontmatter.tags).toEqual(['strategy', 'pmhc']);
    expect(frontmatter.source_url).toBe('https://example.com/x');
    expect(body).toContain('Body here');
    expect(body).not.toContain('---');
  });

  it('returns empty frontmatter for plain content', () => {
    const { frontmatter, body } = parseFrontmatter('Hello world.');
    expect(frontmatter).toEqual({});
    expect(body).toBe('Hello world.');
  });

  it('ignores unknown fields and bad source_type', () => {
    const raw = `---
title: t
source_type: not_a_real_type
banana: yes
---
b
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('t');
    expect(frontmatter.source_type).toBeUndefined();
  });
});

describe('ingestDocument', () => {
  const baseReq = {
    workspaceId: 'ws-123',
    workspaceSlug: 'pmhc',
    sourceRef: 'knowledge/pmhc/foo.md',
    fileMtimeMs: Date.now(),
    raw: '## Section\n\nContent paragraph one.\n\nContent paragraph two.\n',
    defaultTitle: 'foo',
  };

  it('creates a document and chunks on first ingest', async () => {
    const { client, db, workspaceId } = setupClient();
    const result = await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId });
    expect(result.status).toBe('created');
    expect(result.chunkCount).toBeGreaterThan(0);

    const docs = db.tableRows('knowledge_documents');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe('foo');
    expect(docs[0]?.chunked_at).toBeTruthy();

    const chunks = db.tableRows('knowledge_chunks');
    expect(chunks.length).toBe(result.chunkCount);
    expect(chunks[0]?.workspace_id).toBe(workspaceId);
  });

  it('skips re-ingesting an unchanged file (older mtime than chunked_at)', async () => {
    const { client, db, workspaceId } = setupClient();
    await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId });
    const before = db.tableRows('knowledge_chunks').length;
    expect(before).toBeGreaterThan(0);

    // Pass an mtime older than chunked_at by simulating no clock advance.
    const oldMtime = Date.now() - 60_000;
    const result = await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId, fileMtimeMs: oldMtime });
    expect(result.status).toBe('skipped');

    const after = db.tableRows('knowledge_chunks').length;
    expect(after).toBe(before);
  });

  it('replaces chunks when content has changed (force or newer mtime)', async () => {
    const { client, db, workspaceId } = setupClient();
    await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId });
    const initial = db.tableRows('knowledge_chunks').map((r) => r.id);

    const updated = {
      ...baseReq,
      workspaceId,
      raw: '## New Section\n\nCompletely different content here.\n',
      fileMtimeMs: Date.now() + 60_000,
    };
    const result = await ingestDocument(client, fakeEmbed, updated);
    expect(result.status).toBe('updated');

    const after = db.tableRows('knowledge_chunks').map((r) => r.id);
    for (const id of after) expect(initial).not.toContain(id);
    expect(db.tableRows('knowledge_documents')).toHaveLength(1);
  });

  it('honours --force by re-embedding even when file is older than chunked_at', async () => {
    const { client, db, workspaceId } = setupClient();
    await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId });
    const initial = db.tableRows('knowledge_chunks').length;
    expect(initial).toBeGreaterThan(0);

    const result = await ingestDocument(client, fakeEmbed, {
      ...baseReq,
      workspaceId,
      fileMtimeMs: Date.now() - 60_000,
      force: true,
    });
    expect(result.status).toBe('updated');
    expect(db.tableRows('knowledge_chunks').length).toBe(result.chunkCount);
  });

  it('extracts title from frontmatter', async () => {
    const { client, db, workspaceId } = setupClient();
    const raw = `---
title: Pretty Title
tags: [a, b]
---
Body content here.
`;
    await ingestDocument(client, fakeEmbed, { ...baseReq, workspaceId, raw, defaultTitle: 'fallback' });
    const docs = db.tableRows('knowledge_documents');
    expect(docs[0]?.title).toBe('Pretty Title');
    expect(docs[0]?.tags).toEqual(['a', 'b']);
  });
});
