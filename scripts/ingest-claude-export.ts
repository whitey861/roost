// Roost: ingest a Claude.ai conversations export into the knowledge layer.
//
// Usage:
//   pnpm ingest-claude-export -- --path /path/to/extracted/export
//   pnpm ingest-claude-export -- --path ... --dry-run
//   pnpm ingest-claude-export -- --path ... --force
//   pnpm ingest-claude-export -- --path ... --limit 10
//   pnpm ingest-claude-export -- --path ... --exclude-personal

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  estimateCost,
  ingestOneConversation,
  loadWorkspaceIdMap,
  makeAnthropicClassifier,
  parseConversations,
  summarise,
  type ConversationRunReport,
  type PipelineSummary,
} from '../shared/claude-export.js';
import { voyageEmbedder } from '../shared/ingest-core.js';

loadEnv();

interface CliArgs {
  path?: string;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
  excludePersonal?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--path') out.path = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--exclude-personal') out.excludePersonal = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Roost: ingest a Claude.ai conversations export.

Options:
  --path <dir>           extracted export folder (containing conversations.json)
  --dry-run              classify only, no Supabase writes, no embeds
  --force                re-classify and re-ingest existing conversations
  --limit <n>            only process the first n conversations (testing)
  --exclude-personal     remap personal-classified conversations to none
`);
      process.exit(0);
    }
  }
  return out;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function loadConversationsFile(exportPath: string): unknown {
  if (!existsSync(exportPath)) throw new Error(`Path does not exist: ${exportPath}`);
  const stat = statSync(exportPath);
  const conversationsPath = stat.isDirectory() ? join(exportPath, 'conversations.json') : exportPath;
  if (!existsSync(conversationsPath)) {
    throw new Error(`conversations.json not found at ${conversationsPath}`);
  }
  return JSON.parse(readFileSync(conversationsPath, 'utf8'));
}

function pad(s: string | number, width: number, right = false): string {
  const str = String(s);
  if (str.length >= width) return str;
  const padding = ' '.repeat(width - str.length);
  return right ? padding + str : str + padding;
}

function printSummary(summary: PipelineSummary, dryRun: boolean): void {
  const cost = estimateCost(summary);
  console.log('');
  console.log(pad('Workspace', 18) + pad('Conversations', 16, true) + pad('Chunks', 12, true) + pad('Tokens', 14, true) + pad('Cost (USD)', 14, true));
  for (const [slug, row] of Object.entries(summary.byWorkspace)) {
    const cellCost = (row.tokens / 1_000_000) * 0.06;
    console.log(
      pad(slug, 18)
      + pad(row.conversations, 16, true)
      + pad(row.chunks, 12, true)
      + pad(row.tokens.toLocaleString(), 14, true)
      + pad(`$${cellCost.toFixed(4)}`, 14, true),
    );
  }
  if (summary.skippedNone > 0) {
    console.log(pad('none (skipped)', 18) + pad(summary.skippedNone, 16, true) + pad('-', 12, true) + pad('-', 14, true) + pad('-', 14, true));
  }
  if (summary.skippedExisting > 0) {
    console.log(pad('already ingested', 18) + pad(summary.skippedExisting, 16, true) + pad('-', 12, true) + pad('-', 14, true) + pad('-', 14, true));
  }
  console.log('-'.repeat(74));
  console.log(
    pad('Total ingested', 18)
    + pad(summary.totalIngestedConversations, 16, true)
    + pad(summary.totalChunks, 12, true)
    + pad(summary.totalEmbedTokens.toLocaleString(), 14, true)
    + pad(`$${cost.voyageUsd.toFixed(4)}`, 14, true),
  );
  console.log(pad(dryRun ? 'Voyage embedding cost (would be)' : 'Voyage embedding cost', 60) + pad(`$${cost.voyageUsd.toFixed(4)}`, 14, true));
  console.log(pad('Classification calls', 60) + pad(`$${cost.classifierUsd.toFixed(4)}`, 14, true));
  console.log(pad('Total', 60) + pad(`$${cost.totalUsd.toFixed(4)}`, 14, true));
  if (dryRun) console.log('\n(dry-run: no Supabase writes, no Voyage calls)');
}

function reportLine(r: ConversationRunReport): string {
  const conf = r.classification && r.classification.workspace !== 'none' && r.classification.workspace !== 'multiple'
    ? r.classification.confidence.toFixed(2)
    : (r.classification && r.classification.workspace === 'multiple' ? r.classification.confidence.toFixed(2) : '-');
  const ws = r.workspaceSlug ?? (r.classification?.workspace ?? '?');
  switch (r.outcome) {
    case 'skip-existing':
      return `[skip] ${r.title}: already ingested`;
    case 'skip-none':
      return `[skip] ${r.title}: not workspace-relevant${r.classification?.reasoning ? ` (${r.classification.reasoning})` : ''}`;
    case 'skip-low-confidence':
      return `[skip] ${r.title}: low confidence`;
    case 'skip-personal-excluded':
      return `[skip] ${r.title}: personal excluded by flag`;
    case 'ingested-dry':
      return `[classify] ${r.title} → ${ws} (confidence ${conf})`;
    case 'ingested':
      return `[ingest] ${r.title} → ${ws}: ${r.result?.chunkCount ?? 0} chunks (confidence ${conf})`;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error('Missing --path. Use --help for usage.');
    process.exit(1);
  }

  const raw = loadConversationsFile(args.path);
  let conversations = parseConversations(raw);
  if (args.limit && args.limit > 0) conversations = conversations.slice(0, args.limit);
  if (conversations.length === 0) {
    console.log('No conversations parsed. Nothing to do.');
    return;
  }
  console.log(`Parsed ${conversations.length} conversations from ${args.path}.`);

  // Live wiring.
  const supabaseUrl = args.dryRun ? '' : requireEnv('SUPABASE_URL');
  const supabaseKey = args.dryRun ? '' : requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set; cannot classify.');
  if (!args.dryRun && !process.env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set; cannot embed.');

  const client = args.dryRun
    ? null
    : createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const classifier = makeAnthropicClassifier();
  const embed = voyageEmbedder();
  const workspaceIds = client ? await loadWorkspaceIdMap(client) : {};

  const reports: ConversationRunReport[] = [];
  for (const conv of conversations) {
    try {
      const r = await ingestOneConversation(
        // For dry-run we pass a no-op client (the function won't write).
        client ?? createInertClient(),
        embed,
        classifier,
        workspaceIds,
        conv,
        { dryRun: args.dryRun ?? false, force: args.force ?? false, excludePersonal: args.excludePersonal ?? false },
      );
      reports.push(r);
      console.log(reportLine(r));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${conv.name}: ${msg}`);
      reports.push({ uuid: conv.uuid, title: conv.name, outcome: 'skip-none', error: msg });
    }
  }

  printSummary(summarise(reports), Boolean(args.dryRun));
}

// Inert client used during --dry-run when we still need to satisfy the
// SupabaseClient parameter type in ingestOneConversation. Only existence
// checks are performed before classification, and dry-run returns
// before any writes.
function createInertClient(): import('@supabase/supabase-js').SupabaseClient {
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    is: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    delete: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (cb: (v: { data: unknown; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(cb),
  };
  // deno-lint-ignore no-explicit-any
  return { from: () => builder, rpc: async () => ({ data: null, error: null }) } as any;
}

main().catch((err) => {
  console.error('ingest-claude-export failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
