// Roost: idempotent seed script.
// Creates the admin user, the five workspaces, mock tools, and a default
// agent per workspace. Safe to re-run.
//
// Usage: pnpm seed
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { WORKSPACES, AGENTS } from '../shared/agents.js';
import { TOOLS } from '../shared/tools.js';

loadEnv();

const ADMIN_EMAIL = 'paul@roost.local';
const ADMIN_PASSWORD = 'roost-dev-password-change-me';
const ADMIN_DISPLAY_NAME = 'Paul';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`Missing env var: ${key}. Copy .env.example to .env and fill in values.`);
  }
  return v;
}

async function ensureAdminUser(client: SupabaseClient): Promise<string> {
  // Look for existing user by listing (Supabase admin API does not expose
  // get-by-email). We page until we find a match or exhaust the list.
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (found) {
      console.log(`Admin user exists: ${found.id}`);
      return found.id;
    }
    if (data.users.length < 200) break;
    page += 1;
  }

  const { data, error } = await client.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: ADMIN_DISPLAY_NAME },
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  console.log(`Created admin user: ${data.user.id}`);
  return data.user.id;
}

async function ensureProfile(client: SupabaseClient, userId: string): Promise<void> {
  const { error } = await client
    .from('profiles')
    .upsert({ id: userId, display_name: ADMIN_DISPLAY_NAME }, { onConflict: 'id' });
  if (error) throw new Error(`profile upsert failed: ${error.message}`);
}

async function ensureWorkspaces(client: SupabaseClient): Promise<Record<string, string>> {
  const slugToId: Record<string, string> = {};
  for (const ws of WORKSPACES) {
    const { data, error } = await client
      .from('workspaces')
      .upsert(
        { slug: ws.slug, name: ws.name, description: ws.description },
        { onConflict: 'slug' },
      )
      .select('id')
      .single();
    if (error || !data) throw new Error(`workspace upsert ${ws.slug} failed: ${error?.message}`);
    slugToId[ws.slug] = data.id as string;
    console.log(`Workspace ${ws.slug}: ${data.id}`);
  }
  return slugToId;
}

async function ensureMembership(client: SupabaseClient, userId: string, workspaceIds: string[]): Promise<void> {
  for (const wsId of workspaceIds) {
    const { error } = await client
      .from('workspace_members')
      .upsert(
        { workspace_id: wsId, user_id: userId, role: 'owner' },
        { onConflict: 'workspace_id,user_id' },
      );
    if (error) throw new Error(`membership upsert failed: ${error.message}`);
  }
}

async function ensureTools(client: SupabaseClient): Promise<Record<string, string>> {
  const nameToId: Record<string, string> = {};
  for (const t of TOOLS) {
    const { data, error } = await client
      .from('tools')
      .upsert(
        {
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          handler_type: t.handlerType,
          handler_config: t.handlerConfig,
          requires_approval_default: t.requiresApprovalDefault,
          is_outbound: t.isOutbound,
          workspace_scope: t.workspaceScope,
        },
        { onConflict: 'name' },
      )
      .select('id')
      .single();
    if (error || !data) throw new Error(`tool upsert ${t.name} failed: ${error?.message}`);
    nameToId[t.name] = data.id as string;
    console.log(`Tool ${t.name}: ${data.id}`);
  }
  return nameToId;
}

async function ensureAgents(
  client: SupabaseClient,
  workspaceIds: Record<string, string>,
  toolIds: Record<string, string>,
): Promise<void> {
  for (const a of AGENTS) {
    const wsId = workspaceIds[a.workspaceSlug];
    if (!wsId) throw new Error(`Missing workspace: ${a.workspaceSlug}`);
    const allowedToolIds = a.toolNames
      .map((n) => toolIds[n])
      .filter((id): id is string => Boolean(id));

    // Look for an existing agent by (workspace_id, name).
    const { data: existing, error: lookupErr } = await client
      .from('agents')
      .select('id')
      .eq('workspace_id', wsId)
      .eq('name', a.name)
      .maybeSingle();
    if (lookupErr) throw new Error(`agent lookup failed: ${lookupErr.message}`);

    if (existing) {
      const { error } = await client
        .from('agents')
        .update({
          role_description: a.roleDescription,
          system_prompt: a.systemPrompt,
          allowed_tool_ids: allowedToolIds,
        })
        .eq('id', existing.id);
      if (error) throw new Error(`agent update failed: ${error.message}`);
      console.log(`Agent ${a.name}: updated`);
    } else {
      const { error } = await client.from('agents').insert({
        workspace_id: wsId,
        name: a.name,
        role_description: a.roleDescription,
        system_prompt: a.systemPrompt,
        allowed_tool_ids: allowedToolIds,
      });
      if (error) throw new Error(`agent insert failed: ${error.message}`);
      console.log(`Agent ${a.name}: created`);
    }
  }
}

async function main(): Promise<void> {
  const url = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userId = await ensureAdminUser(client);
  await ensureProfile(client, userId);
  const workspaceIds = await ensureWorkspaces(client);
  await ensureMembership(client, userId, Object.values(workspaceIds));
  const toolIds = await ensureTools(client);
  await ensureAgents(client, workspaceIds, toolIds);

  console.log('\nSeed complete.');
  console.log(`Admin email: ${ADMIN_EMAIL}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
