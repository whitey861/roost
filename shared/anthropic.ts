// Roost: Anthropic streaming interface used by the chat runtime.
// Defines the injection seam: tests pass a fake AnthropicClient.
// The real Edge Function client implementation lives in
// supabase/functions/_shared/anthropic.ts.

import type { AnthropicToolDef } from './types.js';

export type AnthropicMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicMessageContent[];
}

export interface StreamRequest {
  model: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools: AnthropicToolDef[];
  maxTokens: number;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_complete'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'server_tool_use_complete'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'server_tool_result_complete'; tool_use_id: string; toolName: string; content: unknown }
  | {
      type: 'message_complete';
      stopReason: string | null;
      content: AnthropicMessageContent[];
      usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
    };

export interface AnthropicClient {
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}
