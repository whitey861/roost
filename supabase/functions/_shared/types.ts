// Re-export shared types so Edge Functions can import via local relative path.
// We duplicate the type definitions rather than importing from ../../../shared
// because Deno cannot resolve outside the function bundle on deploy.
// Single source of truth for runtime values: shared/. Edits here must be
// mirrored from shared/types.ts.

export type WorkspaceApprovalMode = 'all_outbound' | 'allowlist' | 'autonomous';
export type ChannelType = 'web' | 'telegram';
export type MessageRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system_event';
export type OutboundActionStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ChatStreamEvent =
  | { type: 'session'; session_id: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; tool_call_id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_call_id: string; output: Record<string, unknown>; queued_for_approval?: boolean; action_id?: string }
  | { type: 'budget_exceeded'; spent_usd: number; budget_usd: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; cost_usd: number; tokens_in: number; tokens_out: number };
