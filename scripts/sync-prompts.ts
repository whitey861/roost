// Roost: explicit prompt sync.
//
// Reads each prompts/<slug>.md file and writes it to the matching
// agent's system_prompt column. Prints a word-count diff per agent
// so it's clear what changed.
//
// Usage:
//   pnpm sync-prompts
//   pnpm sync-prompts -- --workspace pmhc

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENTS } from '../shared/agents.js';
import { syncOneAgentPrompt } from '../shared/seed-core.js';

loadEnv();

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
    else if (a === '--help' || a === '-h') {
      console.log(`Roost: push markdown prompts to the agents table.

Options:
  --workspace <slug>    only sync the named workspace's agent
  --dry-run             print diffs but do not write
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client: SupabaseClient = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const targets = args.workspace
    ? AGENTS.filter((a) => a.workspaceSlug === args.workspace)
    : AGENTS;
  if (targets.length === 0) {
    console.log(`No agents matched ${args.workspace ?? '(all)'}`);
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const a of targets) {
    const path = resolve(process.cwd(), a.promptFile);
    let next: string;
    try {
      next = readFileSync(path, 'utf8');
    } catch (err) {
      console.error(`[error] ${a.name}: cannot read ${a.promptFile} (${err instanceof Error ? err.message : err})`);
      continue;
    }

    const { data: ws, error: wsErr } = await client
      .from('workspaces')
      .select('id')
      .eq('slug', a.workspaceSlug)
      .maybeSingle();
    if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`);
    if (!ws) {
      console.error(`[skip] ${a.name}: workspace ${a.workspaceSlug} not found.`);
      missing += 1;
      continue;
    }

    const result = await syncOneAgentPrompt(client, {
      workspaceId: (ws as { id: string }).id,
      agentName: a.name,
      nextPrompt: next,
      dryRun: args.dryRun,
    });

    if (result.status === 'missing') {
      console.error(`[skip] ${a.name}: not found in DB. Run npm run seed first.`);
      missing += 1;
    } else if (result.status === 'unchanged') {
      console.log(`[unchanged] ${a.name}: ${result.nextWords} words`);
      unchanged += 1;
    } else {
      const delta = result.nextWords - result.prevWords;
      const sign = delta >= 0 ? '+' : '';
      const tag = args.dryRun ? '[dry-run]' : '[update]';
      console.log(`${tag} ${a.name}: ${result.prevWords} → ${result.nextWords} words (${sign}${delta})`);
      if (!args.dryRun) updated += 1;
    }
  }

  console.log(`\n${args.dryRun ? 'dry-run summary' : 'sync complete'}: ${updated} updated, ${unchanged} unchanged, ${missing} missing.`);
}

main().catch((err) => {
  console.error('sync-prompts failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
