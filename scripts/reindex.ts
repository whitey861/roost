// Roost: re-embed all chunks. Use after upgrading the embedding model
// or changing the chunker. Reads every document's content_md, re-chunks,
// re-embeds, and replaces the chunks. Safe to re-run.
//
// Scaffolded; this phase ships with light testing only.

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { ingestDocument, voyageEmbedder } from '../shared/ingest-core.js';

loadEnv();

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

interface CliArgs {
  workspace?: string;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set.');

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let q = client
    .from('knowledge_documents')
    .select('id, workspace_id, source_ref, title, content_md, workspaces(slug)');
  if (args.workspace) {
    const { data: ws } = await client.from('workspaces').select('id').eq('slug', args.workspace).maybeSingle();
    if (!ws) throw new Error(`Unknown workspace: ${args.workspace}`);
    q = q.eq('workspace_id', (ws as { id: string }).id);
  }
  const { data, error } = await q;
  if (error) throw new Error(`List documents failed: ${error.message}`);

  const docs = (data ?? []) as unknown as Array<{
    id: string;
    workspace_id: string;
    source_ref: string;
    title: string;
    content_md: string | null;
    workspaces: { slug: string } | { slug: string }[] | null;
  }>;
  // Postgrest may return embedded relations as an array. Normalise.
  for (const d of docs) {
    if (Array.isArray(d.workspaces)) d.workspaces = d.workspaces[0] ?? null;
  }
  console.log(`Reindexing ${docs.length} documents${args.dryRun ? ' (dry-run)' : ''}...`);

  if (args.dryRun) {
    for (const d of docs) {
      const slug = (d.workspaces && !Array.isArray(d.workspaces)) ? d.workspaces.slug : '?';
      console.log(`  ${slug} :: ${d.source_ref}`);
    }
    return;
  }

  const embed = voyageEmbedder();
  let totalChunks = 0;

  for (const d of docs) {
    if (!d.content_md) {
      console.log(`Skipping ${d.source_ref}: no content_md stored.`);
      continue;
    }
    const slug = (d.workspaces && !Array.isArray(d.workspaces)) ? d.workspaces.slug : 'unknown';
    const result = await ingestDocument(client, embed, {
      workspaceId: d.workspace_id,
      workspaceSlug: slug,
      sourceRef: d.source_ref,
      fileMtimeMs: Date.now(),
      raw: d.content_md,
      defaultTitle: d.title,
      force: true,
    });
    totalChunks += result.chunkCount;
    console.log(`  ${d.source_ref}: ${result.chunkCount} chunks`);
  }

  console.log(`\nReindex complete. ${totalChunks} chunks across ${docs.length} documents.`);
}

main().catch((err) => {
  console.error('Reindex failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
