// Roost: knowledge retrieval (Deno copy for Edge Functions).
//
// Paired with shared/retrieval.ts (Node). The canonical block between
// SHARED_RUNTIME_START / SHARED_RUNTIME_END must stay byte-equivalent
// (modulo comments and whitespace) to the Node copy.

// @ts-ignore: remote import resolved by Deno at runtime.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';
import { embedQuery, type EmbedOptions } from './embeddings.ts';

// SHARED_RUNTIME_START

export interface KnowledgeHit {
  document_id: string;
  document_title: string;
  source_ref: string;
  source_url: string | null;
  chunk_index: number;
  content: string;
  similarity: number;
}

// Single-query embedder used at retrieval time. Tests inject a deterministic
// fake; production passes embedQuery through.
export type QueryEmbedder = (query: string, opts?: EmbedOptions) => Promise<number[]>;

export interface RetrieveOptions {
  k?: number;
  minSimilarity?: number;
  embedOptions?: EmbedOptions;
  embedQueryFn?: QueryEmbedder;
}

// Format hits into the <workspace_knowledge> block we prepend to the
// agent's system prompt. Pure: no Supabase, no Voyage.
export function formatKnowledgeBlock(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return '';
  const intro = [
    'The following are excerpts from this workspace\'s knowledge base, retrieved as relevant to the user\'s current message.',
    'Use them as context. If they conflict with what the user just said, prefer what the user said and flag the conflict.',
  ].join(' ');

  const parts: string[] = ['<workspace_knowledge>', intro, ''];
  hits.forEach((h, i) => {
    parts.push(`[Excerpt ${i + 1}: from "${h.document_title}" (${h.source_ref})]`);
    parts.push(h.content.trim());
    parts.push('');
  });
  parts.push('</workspace_knowledge>');
  return parts.join('\n');
}

export async function retrieveTopK(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  k = 4,
  minSimilarity = 0.4,
  options: RetrieveOptions = {},
): Promise<KnowledgeHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  let embedding: number[];
  try {
    const embed = options.embedQueryFn ?? embedQuery;
    embedding = await embed(trimmed, options.embedOptions);
  } catch {
    // Embedding failure: fall back to no-knowledge mode rather than
    // breaking the chat. Real failures are visible in the ingest script.
    return [];
  }

  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: embedding,
    ws_id: workspaceId,
    match_count: k,
  });
  if (error) return [];
  const rows = (data ?? []) as Array<{
    document_id: string;
    document_title: string;
    source_ref: string;
    source_url: string | null;
    chunk_index: number;
    content: string;
    similarity: number;
  }>;
  return rows
    .filter((r) => Number(r.similarity) >= minSimilarity)
    .map((r) => ({
      document_id: r.document_id,
      document_title: r.document_title,
      source_ref: r.source_ref,
      source_url: r.source_url,
      chunk_index: r.chunk_index,
      content: r.content,
      similarity: Number(r.similarity),
    }));
}

// SHARED_RUNTIME_END
