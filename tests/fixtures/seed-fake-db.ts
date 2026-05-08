// Seeds the FakeDb with a workspace, agent, tools, and a user so chat tests
// can exercise the runtime end-to-end without real Supabase.

import { randomUUID } from 'node:crypto';
import { FakeDb } from '../fakes/fake-supabase.js';
import { TOOLS } from '../../shared/tools.js';

export interface FakeFixture {
  db: FakeDb;
  workspaceId: string;
  agentId: string;
  userId: string;
  toolIds: Record<string, string>;
}

export function seedFakeDb(opts: { approvalMode?: 'all_outbound' | 'autonomous' | 'allowlist'; budget?: number; spent?: number; resetAt?: string } = {}): FakeFixture {
  const db = new FakeDb();

  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const userId = randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  db.seedTable('workspaces', [
    {
      id: workspaceId,
      slug: 'test',
      name: 'Test Workspace',
      description: 'Unit test workspace.',
      approval_mode: opts.approvalMode ?? 'all_outbound',
      daily_token_budget_usd: opts.budget ?? 5,
      daily_spent_usd: opts.spent ?? 0,
      daily_spent_reset_at: opts.resetAt ?? today,
      active: true,
      created_at: new Date().toISOString(),
    },
  ]);

  db.seedTable('workspace_members', [
    { workspace_id: workspaceId, user_id: userId, role: 'owner', created_at: new Date().toISOString() },
  ]);

  const toolRows = TOOLS.map((t) => ({
    id: randomUUID(),
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    handler_type: t.handlerType,
    handler_config: t.handlerConfig,
    requires_approval_default: t.requiresApprovalDefault,
    is_outbound: t.isOutbound,
    workspace_scope: t.workspaceScope,
    created_at: new Date().toISOString(),
  }));
  db.seedTable('tools', toolRows);
  const toolIds: Record<string, string> = {};
  for (const t of toolRows) toolIds[t.name as string] = t.id as string;

  db.seedTable('agents', [
    {
      id: agentId,
      workspace_id: workspaceId,
      name: 'Test Agent',
      role_description: 'Test',
      system_prompt: 'You are a test agent.',
      model: 'claude-haiku-4-5-20251001',
      allowed_tool_ids: toolRows.map((t) => t.id),
      max_runtime_minutes: 30,
      max_cost_per_run_usd: 1,
      active: true,
      created_at: new Date().toISOString(),
    },
  ]);

  db.seedTable('messages', []);
  db.seedTable('sessions', []);
  db.seedTable('outbound_actions', []);
  db.seedTable('agent_tool_overrides', []);
  db.seedTable('telegram_links', []);
  db.seedTable('knowledge_documents', []);
  db.seedTable('knowledge_chunks', []);

  return { db, workspaceId, agentId, userId, toolIds };
}
