// Roost: tool runtime helpers (Node-side mirror).
// Mirrors supabase/functions/_shared/tools.ts. Keep both in sync.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnthropicToolDef, WorkspaceApprovalMode } from './types.js';

export interface ToolRow {
  id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  handler_type: 'mock' | 'internal' | 'http' | 'edge_function' | 'anthropic_server' | 'worker_job';
  handler_config: Record<string, unknown>;
  requires_approval_default: boolean;
  is_outbound: boolean;
  workspace_scope: string[];
}

export async function loadAgentTools(client: SupabaseClient, _agentId: string, allowedToolIds: string[]): Promise<ToolRow[]> {
  if (allowedToolIds.length === 0) return [];
  const { data, error } = await client
    .from('tools')
    .select('id, name, description, input_schema, handler_type, handler_config, requires_approval_default, is_outbound, workspace_scope')
    .in('id', allowedToolIds);
  if (error) throw new Error(`Failed to load tools: ${error.message}`);
  return (data ?? []) as ToolRow[];
}

export function toAnthropicToolDefs(rows: ToolRow[]): AnthropicToolDef[] {
  return rows.map((t) => {
    if (t.handler_type === 'anthropic_server') {
      const cfg = t.handler_config ?? {};
      const serverType = String((cfg as Record<string, unknown>).server_tool_type ?? '');
      const def: { type: string; name: string; max_uses?: number } = {
        type: serverType,
        name: t.name,
      };
      const maxUses = (cfg as Record<string, unknown>).max_uses;
      if (typeof maxUses === 'number') def.max_uses = maxUses;
      return def;
    }
    return {
      name: t.name,
      description: t.description ?? '',
      input_schema: t.input_schema,
    };
  });
}

export interface ApprovalDecision {
  requiresApproval: boolean;
  reason: 'override' | 'tool_default' | 'workspace_all_outbound' | 'autonomous' | 'allowlist';
}

export async function approvalRequired(
  client: SupabaseClient,
  agentId: string,
  tool: ToolRow,
  workspaceMode: WorkspaceApprovalMode,
): Promise<ApprovalDecision> {
  const { data, error } = await client
    .from('agent_tool_overrides')
    .select('requires_approval')
    .eq('agent_id', agentId)
    .eq('tool_id', tool.id)
    .maybeSingle();
  if (error) throw new Error(`Override lookup failed: ${error.message}`);
  if (data) return { requiresApproval: (data as { requires_approval: boolean }).requires_approval, reason: 'override' };
  if (tool.requires_approval_default) return { requiresApproval: true, reason: 'tool_default' };
  if (workspaceMode === 'autonomous') return { requiresApproval: false, reason: 'autonomous' };
  if (workspaceMode === 'all_outbound' && tool.is_outbound) return { requiresApproval: true, reason: 'workspace_all_outbound' };
  return { requiresApproval: false, reason: 'allowlist' };
}

// Pure approval decision useful when overrides have already been resolved.
export function approvalDecisionPure(
  override: boolean | null,
  toolDefault: boolean,
  isOutbound: boolean,
  workspaceMode: WorkspaceApprovalMode,
): ApprovalDecision {
  if (override !== null) return { requiresApproval: override, reason: 'override' };
  if (toolDefault) return { requiresApproval: true, reason: 'tool_default' };
  if (workspaceMode === 'autonomous') return { requiresApproval: false, reason: 'autonomous' };
  if (workspaceMode === 'all_outbound' && isOutbound) return { requiresApproval: true, reason: 'workspace_all_outbound' };
  return { requiresApproval: false, reason: 'allowlist' };
}
