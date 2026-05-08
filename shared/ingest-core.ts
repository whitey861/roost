// Roost: ingestion core (testable). The CLI in scripts/ingest.ts
// supplies the file system + Voyage; this module owns the diff,
// chunk, embed, persist flow.

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkMarkdown, estimateTokens, type Chunk } from './chunker.js';
import { embedTexts, EMBEDDINGS_MODEL, type EmbedOptions } from './embeddings.js';

export interface FrontMatter {
  title?: string;
  tags?: string[];
  source_url?: string;
  source_type?: 'markdown' | 'claude_export' | 'pasted_note' | 'web_page' | 'file_upload';
}

export interface ParsedDocument {
  frontmatter: FrontMatter;
  body: string;
}

// Parse YAML-ish frontmatter between --- markers at the top of the file.
// Only supports the small subset we use: scalar strings and YAML
// flow-style arrays (e.g. tags: [a, b]). Falls through to the full
// body if no frontmatter is present.
export function parseFrontmatter(raw: string): ParsedDocument {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');

  const fm: FrontMatter = {};
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);

    if (key === 'tags') {
      if (value.startsWith('[') && value.endsWith(']')) {
        fm.tags = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else if (value.length > 0) {
        fm.tags = [value];
      }
    } else if (key === 'title') {
      fm.title = value;
    } else if (key === 'source_url') {
      fm.source_url = value;
    } else if (key === 'source_type') {
      const allowed = ['markdown', 'claude_export', 'pasted_note', 'web_page', 'file_upload'] as const;
      if ((allowed as readonly string[]).includes(value)) {
        fm.source_type = value as FrontMatter['source_type'];
      }
    }
  }

  return { frontmatter: fm, body };
}

export interface IngestRequest {
  workspaceId: string;
  workspaceSlug: string;
  sourceRef: string;
  fileMtimeMs: number;
  raw: string;
  defaultTitle: string;
  force?: boolean;
}

export interface IngestResult {
  status: 'created' | 'updated' | 'skipped';
  documentId: string;
  chunkCount: number;
  totalTokens: number;
}

export interface EmbedderFn {
  (texts: string[]): Promise<number[][]>;
}

// Persist a single document end-to-end. Returns a structured result
// so callers can print summaries.
export async function ingestDocument(
  client: SupabaseClient,
  embed: EmbedderFn,
  req: IngestRequest,
): Promise<IngestResult> {
  const parsed = parseFrontmatter(req.raw);
  const title = parsed.frontmatter.title ?? req.defaultTitle;
  const sourceType = parsed.frontmatter.source_type ?? 'markdown';
  const sourceUrl = parsed.frontmatter.source_url ?? null;
  const tags = parsed.frontmatter.tags ?? [];

  // Look up existing document by (workspace_id, source_ref).
  const { data: existing } = await client
    .from('knowledge_documents')
    .select('id, chunked_at')
    .eq('workspace_id', req.workspaceId)
    .eq('source_ref', req.sourceRef)
    .maybeSingle();

  const existingDoc = existing as { id: string; chunked_at: string | null } | null;

  if (existingDoc && !req.force && existingDoc.chunked_at) {
    const chunkedAtMs = Date.parse(existingDoc.chunked_at);
    if (!Number.isNaN(chunkedAtMs) && chunkedAtMs > req.fileMtimeMs) {
      return { status: 'skipped', documentId: existingDoc.id, chunkCount: 0, totalTokens: 0 };
    }
  }

  // Upsert the document row.
  const docPayload = {
    workspace_id: req.workspaceId,
    title,
    source_type: sourceType,
    source_ref: req.sourceRef,
    source_url: sourceUrl,
    content_md: parsed.body,
    tags,
    metadata: { embeddings_model: EMBEDDINGS_MODEL },
    updated_at: new Date().toISOString(),
  };

  let documentId: string;
  if (existingDoc) {
    const { error: uerr } = await client
      .from('knowledge_documents')
      .update(docPayload)
      .eq('id', existingDoc.id);
    if (uerr) throw new Error(`Update document failed: ${uerr.message}`);
    documentId = existingDoc.id;
    // Replace chunks: delete existing first.
    const { error: derr } = await client.from('knowledge_chunks').delete().eq('document_id', documentId);
    if (derr) throw new Error(`Delete old chunks failed: ${derr.message}`);
  } else {
    const { data, error: ierr } = await client
      .from('knowledge_documents')
      .insert(docPayload)
      .select('id')
      .single();
    if (ierr || !data) throw new Error(`Insert document failed: ${ierr?.message}`);
    documentId = (data as { id: string }).id;
  }

  // Chunk and embed.
  const chunks: Chunk[] = chunkMarkdown(parsed.body);
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);

  if (chunks.length === 0) {
    await client
      .from('knowledge_documents')
      .update({ chunked_at: new Date().toISOString() })
      .eq('id', documentId);
    return { status: existingDoc ? 'updated' : 'created', documentId, chunkCount: 0, totalTokens: 0 };
  }

  const embeddings = await embed(chunks.map((c) => c.content));
  if (embeddings.length !== chunks.length) {
    throw new Error(`Embedder returned ${embeddings.length} vectors for ${chunks.length} chunks`);
  }

  const chunkRows = chunks.map((c, i) => ({
    document_id: documentId,
    workspace_id: req.workspaceId,
    chunk_index: i,
    content: c.content,
    tokens: c.tokens,
    embedding: embeddings[i]!,
    metadata: c.metadata,
  }));

  const { error: cerr } = await client.from('knowledge_chunks').insert(chunkRows);
  if (cerr) throw new Error(`Insert chunks failed: ${cerr.message}`);

  await client
    .from('knowledge_documents')
    .update({ chunked_at: new Date().toISOString() })
    .eq('id', documentId);

  return {
    status: existingDoc ? 'updated' : 'created',
    documentId,
    chunkCount: chunks.length,
    totalTokens,
  };
}

// Convenience: build an EmbedderFn from the live Voyage client.
export function voyageEmbedder(opts: EmbedOptions = {}): EmbedderFn {
  return async (texts: string[]): Promise<number[][]> => embedTexts(texts, opts);
}

export { estimateTokens };
