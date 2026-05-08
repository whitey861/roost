// Roost: shared TypeScript types.
// Mirrors the Postgres schema. Hand-maintained; keep in sync with migrations.

export type WorkspaceApprovalMode = 'all_outbound' | 'allowlist' | 'autonomous';
export type WorkspaceRole = 'owner' | 'admin' | 'approver' | 'member' | 'viewer';
export type ToolHandlerType = 'mock' | 'internal' | 'http' | 'edge_function' | 'anthropic_server';
export type ChannelType = 'web' | 'telegram';
export type MessageRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system_event';
export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'awaiting_approval';
export type ArtifactType = 'draft' | 'report' | 'code' | 'data' | 'file';
export type OutboundActionStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export type AuditActorType = 'user' | 'agent' | 'system';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  approval_mode: WorkspaceApprovalMode;
  daily_token_budget_usd: string | number;
  daily_spent_usd: string | number;
  daily_spent_reset_at: string;
  active: boolean;
  created_at: string;
}

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  role_description: string | null;
  system_prompt: string;
  model: string;
  allowed_tool_ids: string[];
  max_runtime_minutes: number;
  max_cost_per_run_usd: string | number;
  active: boolean;
  created_at: string;
}

export interface ToolRow {
  id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  handler_type: ToolHandlerType;
  handler_config: Record<string, unknown>;
  requires_approval_default: boolean;
  is_outbound: boolean;
  workspace_scope: string[];
  created_at: string;
}

export interface Session {
  id: string;
  workspace_id: string;
  user_id: string;
  agent_id: string;
  channel_type: ChannelType;
  channel_identifier: string | null;
  title: string | null;
  closed: boolean;
  created_at: string;
  last_message_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  tool_output: Record<string, unknown> | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | number | null;
  model: string | null;
  created_at: string;
}

export interface OutboundAction {
  id: string;
  workspace_id: string;
  session_id: string | null;
  job_id: string | null;
  action_type: string;
  target: string | null;
  payload: Record<string, unknown>;
  requires_approval: boolean;
  status: OutboundActionStatus;
  requested_at: string;
  decided_at: string | null;
  executed_at: string | null;
  decided_by_user_id: string | null;
  decided_via_channel: string | null;
  decision_note: string | null;
  result: Record<string, unknown> | null;
}

export interface TelegramLink {
  id: string;
  user_id: string;
  telegram_user_id: number;
  telegram_username: string | null;
  telegram_chat_id: number | null;
  default_workspace_id: string | null;
  current_workspace_id: string | null;
  current_session_id: string | null;
  linked_at: string;
  active: boolean;
}

// Anthropic-shaped tool definition we send to Claude. Either a custom tool
// (name/description/input_schema) executed by our runtime, or a server tool
// (type/name/max_uses) executed by Anthropic.
export type AnthropicToolDef =
  | { name: string; description: string; input_schema: Record<string, unknown> }
  | { type: string; name: string; max_uses?: number };

// Wire format for SSE events the chat function emits.
export type ChatStreamEvent =
  | { type: 'session'; session_id: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; tool_call_id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_call_id: string; output: Record<string, unknown>; queued_for_approval?: boolean; action_id?: string }
  | { type: 'budget_exceeded'; spent_usd: number; budget_usd: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; cost_usd: number; tokens_in: number; tokens_out: number };
