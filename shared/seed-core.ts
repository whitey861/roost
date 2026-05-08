// Roost: testable seed helpers. The CLI wraps these with a real
// Supabase client and dotenv loading.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentSeed } from './agents.js';

export interface AgentRow {
  id: string;
  name: string;
  workspace_id: string;
  system_prompt: string | null;
  model: string;
  allowed_tool_ids: string[];
  role_description: string | null;
}

export type PromptReader = (file: string) => string;

export interface AgentUpsertResult {
  status: 'created' | 'updated';
  id: string;
  systemPromptPreserved: boolean;
}

// Idempotent agent upsert that DOES NOT overwrite system_prompt on
// UPDATE. New agents are inserted with the prompt read from disk via
// the supplied reader. Existing agents have only role_description,
// allowed_tool_ids, and model updated.
export async function upsertAgent(
  client: SupabaseClient,
  args: {
    seed: AgentSeed;
    workspaceId: string;
    allowedToolIds: string[];
    readPrompt: PromptReader;
  },
): Promise<AgentUpsertResult> {
  const { seed, workspaceId, allowedToolIds, readPrompt } = args;
  const { data: existing, error: lookupErr } = await client
    .from('agents')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('name', seed.name)
    .maybeSingle();
  if (lookupErr) throw new Error(`agent lookup failed: ${lookupErr.message}`);

  if (existing) {
    const { error } = await client
      .from('agents')
      .update({
        role_description: seed.roleDescription,
        allowed_tool_ids: allowedToolIds,
        model: seed.model,
      })
      .eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`agent update failed: ${error.message}`);
    return { status: 'updated', id: (existing as { id: string }).id, systemPromptPreserved: true };
  }

  const systemPrompt = readPrompt(seed.promptFile);
  const { data: inserted, error } = await client
    .from('agents')
    .insert({
      workspace_id: workspaceId,
      name: seed.name,
      role_description: seed.roleDescription,
      system_prompt: systemPrompt,
      allowed_tool_ids: allowedToolIds,
      model: seed.model,
    })
    .select('id')
    .single();
  if (error || !inserted) throw new Error(`agent insert failed: ${error?.message}`);
  return { status: 'created', id: (inserted as { id: string }).id, systemPromptPreserved: false };
}

export interface SyncResult {
  name: string;
  status: 'updated' | 'unchanged' | 'missing';
  prevWords: number;
  nextWords: number;
}

function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) ?? []).length;
}

// Push a markdown prompt to a single agent. Returns a structured
// result so the CLI can render a diff summary.
export async function syncOneAgentPrompt(
  client: SupabaseClient,
  args: { workspaceId: string; agentName: string; nextPrompt: string; dryRun?: boolean },
): Promise<SyncResult> {
  const { data, error } = await client
    .from('agents')
    .select('id, name, system_prompt')
    .eq('workspace_id', args.workspaceId)
    .eq('name', args.agentName)
    .maybeSingle();
  if (error) throw new Error(`agent lookup failed: ${error.message}`);
  if (!data) {
    return { name: args.agentName, status: 'missing', prevWords: 0, nextWords: wordCount(args.nextPrompt) };
  }
  const row = data as { id: string; name: string; system_prompt: string | null };
  const prev = row.system_prompt ?? '';
  if (prev === args.nextPrompt) {
    return { name: row.name, status: 'unchanged', prevWords: wordCount(prev), nextWords: wordCount(args.nextPrompt) };
  }
  if (!args.dryRun) {
    const { error: uerr } = await client.from('agents').update({ system_prompt: args.nextPrompt }).eq('id', row.id);
    if (uerr) throw new Error(`prompt update failed: ${uerr.message}`);
  }
  return { name: row.name, status: 'updated', prevWords: wordCount(prev), nextWords: wordCount(args.nextPrompt) };
}
