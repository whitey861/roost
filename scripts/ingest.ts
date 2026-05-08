// Roost: knowledge ingestion CLI.
//
// Examples:
//   pnpm ingest -- --workspace pmhc --file knowledge/pmhc/foo.md
//   pnpm ingest -- --workspace pmhc
//   pnpm ingest -- --all
//   pnpm ingest -- --workspace pmhc --force
//
// Reads VOYAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from .env.

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, basename } from 'node:path';
import { ingestDocument, voyageEmbedder } from '../shared/ingest-core.js';
import { WORKSPACES } from '../shared/agents.js';

loadEnv();

const REPO_ROOT = process.cwd();
const KNOWLEDGE_ROOT = join(REPO_ROOT, 'knowledge');

interface CliArgs {
  workspace?: string;
  file?: string;
  all?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Roost ingest: chunk and embed markdown into Supabase pgvector.

Options:
  --workspace <slug>    target workspace (e.g. pmhc, kca, personal, budget, dev)
  --file <path>         single file to ingest (relative or absolute)
  --all                 ingest every file under every workspace
  --force               re-chunk and re-embed even if file is older than chunked_at
  --dry-run             chunk only, no Supabase writes, no Voyage calls
  --help                show this message
`);
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function findMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(full);
    }
  }
  return out;
}

interface FileTarget {
  workspaceSlug: string;
  absolutePath: string;
}

function collectTargets(args: CliArgs): FileTarget[] {
  if (args.file) {
    const abs = resolve(args.file);
    const slug = args.workspace ?? inferWorkspaceFromPath(abs);
    if (!slug) throw new Error('Could not infer workspace from path; pass --workspace.');
    return [{ workspaceSlug: slug, absolutePath: abs }];
  }
  if (args.workspace) {
    const dir = join(KNOWLEDGE_ROOT, args.workspace);
    return findMarkdownFiles(dir).map((p) => ({ workspaceSlug: args.workspace!, absolutePath: p }));
  }
  if (args.all) {
    const out: FileTarget[] = [];
    for (const ws of WORKSPACES) {
      const dir = join(KNOWLEDGE_ROOT, ws.slug);
      try {
        statSync(dir);
      } catch {
        continue;
      }
      for (const p of findMarkdownFiles(dir)) {
        out.push({ workspaceSlug: ws.slug, absolutePath: p });
      }
    }
    return out;
  }
  throw new Error('Specify --file, --workspace, or --all.');
}

function inferWorkspaceFromPath(absPath: string): string | null {
  const rel = relative(KNOWLEDGE_ROOT, absPath);
  if (rel.startsWith('..')) return null;
  const parts = rel.split(/[\\/]/);
  return parts[0] ?? null;
}

async function loadWorkspaceIds(client: import('@supabase/supabase-js').SupabaseClient, slugs: string[]): Promise<Record<string, string>> {
  if (slugs.length === 0) return {};
  const { data, error } = await client.from('workspaces').select('id, slug').in('slug', slugs);
  if (error) throw new Error(`Workspace lookup failed: ${error.message}`);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ id: string; slug: string }>) {
    out[row.slug] = row.id;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets = collectTargets(args);
  if (targets.length === 0) {
    console.log('No markdown files matched. Nothing to do.');
    return;
  }

  if (args.dryRun) {
    const { chunkMarkdown } = await import('../shared/chunker.js');
    let totalChunks = 0;
    let totalTokens = 0;
    for (const t of targets) {
      const raw = readFileSync(t.absolutePath, 'utf8');
      const chunks = chunkMarkdown(raw);
      const tokens = chunks.reduce((s, c) => s + c.tokens, 0);
      totalChunks += chunks.length;
      totalTokens += tokens;
      console.log(`${relative(REPO_ROOT, t.absolutePath)}: ${chunks.length} chunks, ${tokens} tokens (dry-run)`);
    }
    console.log(`\nDry-run total: ${totalChunks} chunks, ${totalTokens} tokens. No Supabase writes, no Voyage calls.`);
    return;
  }

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  // Voyage API key is checked lazily inside the embedder; surface a
  // clearer message up-front though.
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set. Add it to .env before ingesting.');
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const embed = voyageEmbedder();

  const slugs = Array.from(new Set(targets.map((t) => t.workspaceSlug)));
  const idBySlug = await loadWorkspaceIds(client, slugs);

  let totalChunks = 0;
  let totalTokens = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const t of targets) {
    const wsId = idBySlug[t.workspaceSlug];
    if (!wsId) {
      console.error(`Skipping ${t.absolutePath}: workspace "${t.workspaceSlug}" not found in DB. Run seed first.`);
      continue;
    }
    const raw = readFileSync(t.absolutePath, 'utf8');
    const stat = statSync(t.absolutePath);
    const sourceRef = relative(REPO_ROOT, t.absolutePath).split(/\\/g).join('/');
    const defaultTitle = basename(t.absolutePath, '.md');

    const result = await ingestDocument(client, embed, {
      workspaceId: wsId,
      workspaceSlug: t.workspaceSlug,
      sourceRef,
      fileMtimeMs: stat.mtimeMs,
      raw,
      defaultTitle,
      force: args.force,
    });

    if (result.status === 'created') created += 1;
    else if (result.status === 'updated') updated += 1;
    else skipped += 1;

    totalChunks += result.chunkCount;
    totalTokens += result.totalTokens;

    const cost = (result.totalTokens / 1_000_000) * 0.06;
    console.log(
      `${sourceRef}: ${result.status} (${result.chunkCount} chunks, ${result.totalTokens} tokens, $${cost.toFixed(4)})`,
    );
  }

  const totalCost = (totalTokens / 1_000_000) * 0.06;
  console.log(
    `\nTotal: ${created} created, ${updated} updated, ${skipped} skipped. ${totalChunks} chunks, ${totalTokens} tokens, $${totalCost.toFixed(4)}.`,
  );
}

main().catch((err) => {
  console.error('Ingest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
