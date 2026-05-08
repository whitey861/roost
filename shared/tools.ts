// Roost: tool registry. Defines tool metadata and mock handlers used in
// Phase 1 and Phase 2. Real handlers (Gmail, Drive, etc.) land in Phase 3.

import type { ToolHandlerType, AnthropicToolDef } from './types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handlerType: ToolHandlerType;
  handlerConfig: Record<string, unknown>;
  requiresApprovalDefault: boolean;
  isOutbound: boolean;
  workspaceScope: string[];
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'mock_echo',
    description: 'Echoes the input verbatim. Useful for testing the tool loop.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back.' },
      },
      required: ['text'],
    },
    handlerType: 'mock',
    handlerConfig: {},
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['*'],
  },
  {
    name: 'mock_search',
    description: 'Returns three fake search results for the given query. Use this when the user asks to search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    handlerType: 'mock',
    handlerConfig: {},
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['*'],
  },
  {
    name: 'mock_send_email',
    description: 'Sends an email. Always queued for approval in this phase. Use when the user explicitly asks to send an email.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body text.' },
      },
      required: ['to', 'subject', 'body'],
    },
    handlerType: 'mock',
    handlerConfig: {},
    requiresApprovalDefault: true,
    isOutbound: true,
    workspaceScope: ['*'],
  },
  {
    name: 'search_knowledge',
    description:
      "Search this workspace's knowledge base for information relevant to a query. Use this when you need additional context beyond what's already in the conversation, or to find specific facts about projects, people, or decisions in this workspace.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for. Use natural language.' },
        max_results: { type: 'integer', default: 5, minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    handlerType: 'internal',
    handlerConfig: {},
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['*'],
  },
  {
    name: 'web_search',
    description:
      'Search the web for current information, news, facts, or anything not in your knowledge base. Use when the user asks about current events, recent developments, or specific facts you need to verify. Executed server-side by Anthropic; results are returned inline with citations.',
    // input_schema is informational for anthropic_server tools — Anthropic
    // determines actual usage server-side.
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
    handlerType: 'anthropic_server',
    handlerConfig: {
      server_tool_type: 'web_search_20250305',
      max_uses: 5,
    },
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['*'],
  },
];

// Names of tools whose handler_type is 'anthropic_server'. The runtime uses
// this to thread server-tool blocks through history reconstruction without
// needing to re-query the tools table.
export const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search']);

export function toAnthropicToolDef(t: { name: string; description: string | null; input_schema: Record<string, unknown> }): AnthropicToolDef {
  return {
    name: t.name,
    description: t.description ?? '',
    input_schema: t.input_schema,
  };
}

// Mock handler dispatch. Pure: takes a tool name and input, returns output.
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
