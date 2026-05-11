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
    name: 'spawn_dev_agent',
    description:
      'Queue an autonomous dev job. The dev agent will clone a repo, do the requested work using Claude Code, run tests, and open a PR for human review. Use this when the user asks for code to be written, a bug fixed, a feature built, or any work that should result in a PR. The agent works asynchronously and notifies via the configured channel when done. Always confirm scope with the user before invoking.',
    inputSchema: {
      type: 'object',
      required: ['task_spec', 'target_repo'],
      properties: {
        task_spec: {
          type: 'string',
          description:
            'The full task description for the dev agent. Be specific. Include acceptance criteria, constraints, file targets if known. The dev agent has no other context, so this is everything it gets.',
        },
        target_repo: {
          type: 'string',
          description:
            'GitHub repo in owner/name format. Must be one Roost has been granted push access to.',
        },
        target_branch: {
          type: 'string',
          description: 'Base branch to cut the dev branch from. Defaults to main.',
          default: 'main',
        },
        max_cost_usd: {
          type: 'number',
          description: 'Maximum spend on Claude Code tokens for this job. Default 5.00.',
          default: 5.0,
        },
        max_runtime_minutes: {
          type: 'integer',
          description: 'Wall-clock minutes before the job is killed. Default 120.',
          default: 120,
        },
      },
    },
    handlerType: 'worker_job',
    handlerConfig: { provider: 'claude_code' },
    requiresApprovalDefault: false,
    isOutbound: true,
    workspaceScope: ['dev'],
  },
  {
    name: 'check_dev_jobs',
    description:
      "List the current user's recent dev_jobs in this workspace. Use when Paul asks about job status (\"is it building?\", \"any progress?\", \"what's still queued?\"). Returns each job's id, status, target repo and branch, a truncated task spec, when it was created/leased/completed, elapsed minutes (running so far, or total runtime), iterations used vs the cap, cost so far vs the cap, and the PR url if there is one. Filter by status if Paul only cares about running or completed work.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum jobs to return, newest first.',
          default: 5,
          minimum: 1,
          maximum: 20,
        },
        status: {
          type: 'string',
          description: 'Optional status filter.',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout'],
        },
      },
    },
    handlerType: 'internal',
    handlerConfig: {},
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['dev'],
  },
  {
    name: 'generate_image',
    description:
      'Generate an image using Recraft based on a text prompt. Optionally takes a Recraft style_id to apply a trained brand style. Returns a public image URL the assistant should embed in the reply using markdown image syntax: ![alt](url).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The image prompt.' },
        style_id: {
          type: 'string',
          description: 'Optional Recraft trained brand-style UUID.',
        },
        size: {
          type: 'string',
          description: 'Image size. Defaults to 1024x1024.',
          enum: ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536'],
        },
      },
      required: ['prompt'],
    },
    handlerType: 'internal',
    handlerConfig: {},
    requiresApprovalDefault: false,
    isOutbound: false,
    workspaceScope: ['oarfish'],
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
