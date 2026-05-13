// Roost: push prompt-file changes to the agents.system_prompt column.
//
// The seed script never overwrites system_prompt on existing agents, so this
// is the explicit channel for prompt updates. Edit the markdown file at
// prompts/<slug>.md, then run this script.
//
// Usage:
//   npm run sync-prompts                      # syncs all five
//   npm run sync-prompts -- --workspace pmhc  # one workspace
//   npm run sync-prompts -- --dry-run         # show diff but do not write
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment.
//
// This script talks to PostgREST directly via fetch instead of using
// @supabase/supabase-js, which transitively requires a global WebSocket and
// fails to import on Node 20 with "Node.js 20 detected without native
// WebSocket support". The script only reads two rows and writes one column,
// so the full client is overkill.

import { config as loadEnv } from 'dotenv';
import { AGENTS, loadSystemPrompt, type AgentSeed } from '../shared/agents.js';

loadEnv();

interface CliArgs {
  workspace?: string;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--workspace' || a === '-w') out.workspace = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Roost: sync prompt files to the agents table.

Options:
  --workspace <slug>   only sync one workspace's agent
  --dry-run            print diffs without writing
`);
      process.exit(0);
    }
  }
  return out;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`Missing env var: ${key}. Copy .env.example to .env and fill in values.`);
  }
  return v;
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function diffSummary(before: string, after: string): string {
  const b = wordCount(before);
  const a = wordCount(after);
  const delta = a - b;
  const sign = delta >= 0 ? '+' : '';
  return `${b} -> ${a} words (${sign}${delta})`;
}

interface SyncResult {
  agentName: string;
  workspaceSlug: string;
  status: 'updated' | 'unchanged' | 'created' | 'missing-agent' | 'missing-workspace';
  diff?: string;
}

export interface PromptSyncClient {
  getWorkspaceIdBySlug(slug: string): Promise<string | null>;
  getAgent(workspaceId: string, name: string): Promise<{ id: string; system_prompt: string } | null>;
  updateAgentSystemPrompt(agentId: string, systemPrompt: string): Promise<void>;
}

export function createRestClient(url: string, serviceKey: string): PromptSyncClient {
  const baseUrl = `${url.replace(/\/$/, '')}/rest/v1`;
  const baseHeaders: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...baseHeaders, ...((init.headers as Record<string, string> | undefined) ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase REST ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return res;
  }

  return {
    async getWorkspaceIdBySlug(slug) {
      const path = `/workspaces?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`;
      const res = await request(path);
      const rows = (await res.json()) as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    },
    async getAgent(workspaceId, name) {
      const qs = `select=id,system_prompt&workspace_id=eq.${encodeURIComponent(workspaceId)}&name=eq.${encodeURIComponent(name)}&limit=1`;
      const res = await request(`/agents?${qs}`);
      const rows = (await res.json()) as Array<{ id: string; system_prompt: string }>;
      return rows[0] ?? null;
    },
    async updateAgentSystemPrompt(agentId, systemPrompt) {
      await request(`/agents?id=eq.${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ system_prompt: systemPrompt }),
      });
    },
  };
}

export async function syncOnePrompt(
  client: PromptSyncClient,
  agent: AgentSeed,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const desired = loadSystemPrompt(agent);

  const workspaceId = await client.getWorkspaceIdBySlug(agent.workspaceSlug);
  if (!workspaceId) {
    return { agentName: agent.name, workspaceSlug: agent.workspaceSlug, status: 'missing-workspace' };
  }

  const existing = await client.getAgent(workspaceId, agent.name);
  if (!existing) {
    return { agentName: agent.name, workspaceSlug: agent.workspaceSlug, status: 'missing-agent' };
  }

  if (existing.system_prompt === desired) {
    return { agentName: agent.name, workspaceSlug: agent.workspaceSlug, status: 'unchanged' };
  }

  const diff = diffSummary(existing.system_prompt ?? '', desired);
  if (options.dryRun) {
    return { agentName: agent.name, workspaceSlug: agent.workspaceSlug, status: 'updated', diff };
  }

  await client.updateAgentSystemPrompt(existing.id, desired);
  return { agentName: agent.name, workspaceSlug: agent.workspaceSlug, status: 'updated', diff };
}

export async function syncPrompts(
  client: PromptSyncClient,
  options: { workspace?: string; dryRun?: boolean } = {},
): Promise<SyncResult[]> {
  const targets = options.workspace
    ? AGENTS.filter((a) => a.workspaceSlug === options.workspace)
    : AGENTS;
  if (options.workspace && targets.length === 0) {
    throw new Error(`No agent for workspace slug "${options.workspace}".`);
  }
  const out: SyncResult[] = [];
  for (const a of targets) {
    out.push(await syncOnePrompt(client, a, { dryRun: options.dryRun }));
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createRestClient(url, serviceKey);

  const results = await syncPrompts(client, { workspace: args.workspace, dryRun: args.dryRun });
  for (const r of results) {
    if (r.status === 'updated') {
      console.log(`[${args.dryRun ? 'dry-run' : 'updated'}] ${r.workspaceSlug}/${r.agentName}: ${r.diff}`);
    } else if (r.status === 'unchanged') {
      console.log(`[unchanged] ${r.workspaceSlug}/${r.agentName}`);
    } else if (r.status === 'missing-agent') {
      console.log(`[missing-agent] ${r.workspaceSlug}/${r.agentName}: run \`npm run seed\` first`);
    } else if (r.status === 'missing-workspace') {
      console.log(`[missing-workspace] ${r.workspaceSlug}: run \`npm run seed\` first`);
    }
  }
}

import { fileURLToPath } from 'node:url';

const isCli = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isCli) {
  main().catch((err) => {
    console.error('sync-prompts failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
