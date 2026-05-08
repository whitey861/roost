// Roost: tool registry helpers for Edge Functions.
// Loads tool rows from DB, exposes mock handler dispatch, and applies
// the approval rule to decide whether a tool call should be queued.

// @ts-ignore: remote import resolved by Deno at runtime.
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';
import type { AnthropicToolDef, WorkspaceApprovalMode } from './types.ts';

export interface ToolRow {
  id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  handler_type: 'mock' | 'internal' | 'http' | 'edge_function' | 'anthropic_server';
  handler_config: Record<string, unknown>;
  requires_approval_default: boolean;
  is_outbound: boolean;
  workspace_scope: string[];
}

export async function loadAgentTools(client: SupabaseClient, agentId: string, allowedToolIds: string[]): Promise<ToolRow[]> {
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

// Decide whether a single tool invocation should be queued for approval.
// Precedence: per-agent override beats tool default beats workspace mode.
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
  if (data) return { requiresApproval: data.requires_approval, reason: 'override' };

  if (tool.requires_approval_default) {
    return { requiresApproval: true, reason: 'tool_default' };
  }
  if (workspaceMode === 'autonomous') {
    return { requiresApproval: false, reason: 'autonomous' };
  }
  if (workspaceMode === 'all_outbound' && tool.is_outbound) {
    return { requiresApproval: true, reason: 'workspace_all_outbound' };
  }
  // 'allowlist' mode: in this phase treat as no approval needed unless tool flagged.
  return { requiresApproval: false, reason: 'allowlist' };
}

// Names of tools whose handler_type is 'anthropic_server'. The runtime uses
// this to thread server-tool blocks through history reconstruction without
// needing to re-query the tools table. Mirrors shared/tools.ts.
export const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search']);

// Mock handler dispatch. Real handlers wired in Phase 3.
export function runMockTool(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name === 'mock_echo') {
    return { echoed: input.text ?? '' };
  }
  if (name === 'mock_search') {
    const query = String(input.query ?? '');
    return {
      query,
      results: [
        { title: `Result 1 for ${query}`, url: 'https://example.com/1', snippet: 'First fake result.' },
        { title: `Result 2 for ${query}`, url: 'https://example.com/2', snippet: 'Second fake result.' },
        { title: `Result 3 for ${query}`, url: 'https://example.com/3', snippet: 'Third fake result.' },
      ],
    };
  }
  if (name === 'mock_send_email') {
    return { sent: true, to: input.to, subject: input.subject };
  }
  return { ok: false, error: `Unknown mock tool: ${name}` };
}
