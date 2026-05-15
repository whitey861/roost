// Roost: shared chat runtime (Deno copy for Edge Functions).
//
// Paired with shared/chat-runtime.ts (Node, used by Vitest). Business logic
// between SHARED_RUNTIME_START / SHARED_RUNTIME_END must stay byte-equivalent
// (modulo comments and whitespace) to the Node copy. Run `npm run check:parity`.
//
// Used by:
//  - /chat (web): emits ChatStreamEvent over SSE.
//  - /telegram-webhook: consumes events and edits a Telegram message.

// @ts-ignore: remote import resolved by Deno at runtime.
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';
import type { ChatStreamEvent, ChannelType, WorkspaceApprovalMode } from './types.ts';
import { addSpend, getBudgetState, isOverBudget, rolloverIfNeeded } from './budget.ts';
import { approvalRequired, loadAgentTools, runMockTool, SERVER_TOOL_NAMES, toAnthropicToolDefs, type ToolRow } from './tools.ts';
import { generateImage, type GenerateImageInput } from './tool-handlers/generate-image.ts';
import { createGithubRepo, type CreateGithubRepoInput } from './tool-handlers/create-github-repo.ts';
import type { AnthropicClient, AnthropicMessage, AnthropicMessageContent, StreamRequest } from './anthropic.ts';
import { costUsd } from './pricing.ts';
import { formatKnowledgeBlock, retrieveTopK, type KnowledgeHit, type QueryEmbedder } from './retrieval.ts';

// SHARED_RUNTIME_START

export interface RunChatParams {
  client: SupabaseClient;
  anthropic: AnthropicClient;
  workspaceId: string;
  userId: string;
  agentId?: string;
  sessionId?: string;
  channel: ChannelType;
  channelIdentifier?: string;
  userMessage: string | AnthropicMessageContent[];
  maxToolIterations?: number;
  embedQueryFn?: QueryEmbedder;
}

export interface ChatRunResult {
  sessionId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

async function loadContext(client: SupabaseClient, workspaceId: string, agentId?: string) {
  const { data: ws, error: wsErr } = await client
    .from('workspaces')
    .select('id, slug, name, approval_mode, active')
    .eq('id', workspaceId)
    .single();
  if (wsErr || !ws) throw new Error(`Workspace not found: ${workspaceId}`);
  const wsTyped = ws as { id: string; slug: string; name: string; approval_mode: WorkspaceApprovalMode; active: boolean };
  if (!wsTyped.active) throw new Error(`Workspace is inactive: ${wsTyped.slug}`);

  let agentQuery = client.from('agents').select('*').eq('workspace_id', workspaceId).eq('active', true);
  if (agentId) agentQuery = agentQuery.eq('id', agentId);
  const { data: agents, error: aErr } = await agentQuery.order('created_at', { ascending: true }).limit(1);
  if (aErr) throw new Error(`Agent lookup failed: ${aErr.message}`);
  const agent = agents?.[0] as { id: string; system_prompt: string; model: string; allowed_tool_ids: string[] } | undefined;
  if (!agent) throw new Error('No active agent found for workspace.');

  const tools = await loadAgentTools(client, agent.id, agent.allowed_tool_ids ?? []);
  return { workspace: wsTyped, agent, tools };
}

async function loadOrCreateSession(
  client: SupabaseClient,
  args: { workspaceId: string; userId: string; agentId: string; channel: ChannelType; channelIdentifier?: string; sessionId?: string; firstMessage: string },
): Promise<string> {
  if (args.sessionId) {
    const { data, error } = await client
      .from('sessions')
      .select('id, workspace_id, user_id')
      .eq('id', args.sessionId)
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .maybeSingle();
    if (error) {
      console.log(JSON.stringify({
        at: 'chat.session_resolution.lookup_error',
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        user_id: args.userId,
        error: error.message,
      }));
      throw new Error(`Session lookup failed: ${error.message}`);
    }
    if (!data) {
      console.log(JSON.stringify({
        at: 'chat.session_resolution.not_found_or_not_owned',
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        user_id: args.userId,
      }));
      throw new Error(`Session not found or not owned by caller: ${args.sessionId}`);
    }
    console.log(JSON.stringify({
      at: 'chat.session_resolution.continued',
      session_id: (data as { id: string }).id,
      workspace_id: args.workspaceId,
      user_id: args.userId,
    }));
    return (data as { id: string }).id;
  }
  const title = args.firstMessage.slice(0, 60);
  const { data, error } = await client
    .from('sessions')
    .insert({
      workspace_id: args.workspaceId,
      user_id: args.userId,
      agent_id: args.agentId,
      channel_type: args.channel,
      channel_identifier: args.channelIdentifier ?? null,
      title,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Session create failed: ${error?.message}`);
  console.log(JSON.stringify({
    at: 'chat.session_resolution.created',
    session_id: (data as { id: string }).id,
    workspace_id: args.workspaceId,
    user_id: args.userId,
    channel: args.channel,
  }));
  return (data as { id: string }).id;
}

export async function loadHistory(client: SupabaseClient, sessionId: string): Promise<AnthropicMessage[]> {
  const { data, error } = await client
    .from('messages')
    .select('role, content, tool_call_id, tool_name, tool_input, tool_output')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`History load failed: ${error.message}`);
  return reconstructHistory(
    (data ?? []) as Array<{
      role: string;
      content: unknown;
      tool_call_id: string | null;
      tool_name: string | null;
      tool_input: Record<string, unknown> | null;
      tool_output: Record<string, unknown> | null;
    }>,
  );
}

// Normalise messages.content reads. The column is jsonb so values come back
// as either a string (plain text user/assistant message) or an array of
// content blocks (multimodal user message with image + text). Older rows
// pre-jsonb migration may also surface as raw strings. Mirrors the pattern
// used in normaliseWebSearchResultContent: be permissive on reads.
export function normaliseUserMessageContent(stored: unknown): string | AnthropicMessageContent[] {
  if (stored == null) return '';
  if (typeof stored === 'string') return stored;
  if (Array.isArray(stored)) return stored as AnthropicMessageContent[];
  if (typeof stored === 'object') {
    const maybeText = (stored as Record<string, unknown>).text;
    if (typeof maybeText === 'string') return maybeText;
  }
  return '';
}

// Extract the plain-text portion of a user message for purposes that need a
// string (session title, knowledge retrieval query, logging). For an array
// of content blocks, joins all `text` blocks; non-text blocks are ignored.
export function userMessageText(content: string | AnthropicMessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<AnthropicMessageContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

// Normalise the persisted tool_output for a web_search server tool back into
// the array shape Anthropic's API expects for web_search_tool_result.content.
// Persistence stores { content: <array> }, but older rows or future write-path
// drift may leave content as a stringified JSON array, a single object, or
// missing entirely. Anthropic rejects anything other than an array of
// RequestWebSearchResultBlock with a 400.
export function normaliseWebSearchResultContent(stored: unknown): unknown[] {
  let content: unknown = stored;
  if (content && typeof content === 'object' && !Array.isArray(content)
      && 'content' in (content as Record<string, unknown>)) {
    content = (content as Record<string, unknown>).content;
  }
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (content == null) return [];
  if (Array.isArray(content)) return content;
  return [content];
}

// Pure: turn ordered DB rows into Claude-shaped message history.
// Server-side tool calls (handler_type='anthropic_server') and their results
// belong inside the assistant message's content (Anthropic generated both),
// so they go into pendingAssistant rather than pendingToolResults.
export function reconstructHistory(rows: Array<{
  role: string;
  content: unknown;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  tool_output: Record<string, unknown> | null;
}>): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  let pendingAssistant: AnthropicMessageContent[] | null = null;
  let pendingToolResults: AnthropicMessageContent[] | null = null;

  for (const m of rows) {
    const isServerTool = m.tool_name !== null && SERVER_TOOL_NAMES.has(m.tool_name);
    if (m.role === 'user') {
      if (pendingAssistant) { messages.push({ role: 'assistant', content: pendingAssistant }); pendingAssistant = null; }
      if (pendingToolResults) { messages.push({ role: 'user', content: pendingToolResults }); pendingToolResults = null; }
      messages.push({ role: 'user', content: normaliseUserMessageContent(m.content) });
    } else if (m.role === 'assistant') {
      if (pendingToolResults) { messages.push({ role: 'user', content: pendingToolResults }); pendingToolResults = null; }
      pendingAssistant = pendingAssistant ?? [];
      const text = userMessageText(normaliseUserMessageContent(m.content));
      pendingAssistant.push({ type: 'text', text });
    } else if (m.role === 'tool_call') {
      pendingAssistant = pendingAssistant ?? [];
      if (isServerTool) {
        pendingAssistant.push({
          type: 'server_tool_use',
          id: m.tool_call_id ?? '',
          name: m.tool_name ?? '',
          input: (m.tool_input ?? {}) as Record<string, unknown>,
        });
      } else {
        pendingAssistant.push({
          type: 'tool_use',
          id: m.tool_call_id ?? '',
          name: m.tool_name ?? '',
          input: (m.tool_input ?? {}) as Record<string, unknown>,
        });
      }
    } else if (m.role === 'tool_result') {
      if (isServerTool) {
        pendingAssistant = pendingAssistant ?? [];
        pendingAssistant.push({
          type: 'web_search_tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: normaliseWebSearchResultContent(m.tool_output),
        });
      } else {
        if (pendingAssistant) { messages.push({ role: 'assistant', content: pendingAssistant }); pendingAssistant = null; }
        pendingToolResults = pendingToolResults ?? [];
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: JSON.stringify(m.tool_output ?? {}),
        });
      }
    }
  }
  if (pendingAssistant) messages.push({ role: 'assistant', content: pendingAssistant });
  if (pendingToolResults) messages.push({ role: 'user', content: pendingToolResults });
  return messages;
}

async function persistAssistantTurn(
  client: SupabaseClient,
  sessionId: string,
  model: string,
  content: AnthropicMessageContent[],
  usage: { inputTokens: number; outputTokens: number },
  thisCallCost: number,
): Promise<void> {
  for (const block of content) {
    if (block.type === 'text') {
      if (!block.text) continue;
      await client.from('messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: block.text,
        model,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_usd: thisCallCost,
      });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      await client.from('messages').insert({
        session_id: sessionId,
        role: 'tool_call',
        tool_call_id: block.id,
        tool_name: block.name,
        tool_input: block.input,
        model,
      });
    } else if (block.type === 'web_search_tool_result') {
      await client.from('messages').insert({
        session_id: sessionId,
        role: 'tool_result',
        tool_call_id: block.tool_use_id,
        tool_name: 'web_search',
        tool_output: { content: block.content } as Record<string, unknown>,
      });
    }
  }
}

async function persistToolResult(
  client: SupabaseClient,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  output: Record<string, unknown>,
): Promise<void> {
  await client.from('messages').insert({
    session_id: sessionId,
    role: 'tool_result',
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_output: output,
  });
}

async function persistUserMessage(
  client: SupabaseClient,
  sessionId: string,
  content: string | AnthropicMessageContent[],
): Promise<void> {
  await client.from('messages').insert({ session_id: sessionId, role: 'user', content });
}

async function touchSession(client: SupabaseClient, sessionId: string): Promise<void> {
  await client.from('sessions').update({ last_message_at: new Date().toISOString() }).eq('id', sessionId);
}

export async function* runChat(params: RunChatParams): AsyncIterable<ChatStreamEvent> {
  const { client, anthropic } = params;
  const { workspace, agent, tools } = await loadContext(client, params.workspaceId, params.agentId);

  const userMessageContent = params.userMessage;
  const userMessagePlainText = userMessageText(userMessageContent);

  const sessionId = await loadOrCreateSession(client, {
    workspaceId: workspace.id,
    userId: params.userId,
    agentId: agent.id,
    channel: params.channel,
    channelIdentifier: params.channelIdentifier,
    sessionId: params.sessionId,
    firstMessage: userMessagePlainText,
  });
  yield { type: 'session', session_id: sessionId };

  const initialState = await rolloverIfNeeded(client, workspace.id);
  if (isOverBudget(initialState)) {
    yield { type: 'budget_exceeded', spent_usd: initialState.spentUsd, budget_usd: initialState.budgetUsd };
    return;
  }

  await persistUserMessage(client, sessionId, userMessageContent);

  // Knowledge auto-injection: retrieve top hits relevant to the user's
  // message and prepend them to the system prompt for this run.
  // retrieveTopK no-ops gracefully when Voyage isn't configured or when
  // no chunks meet the similarity threshold.
  let knowledgeHits: KnowledgeHit[] = [];
  try {
    knowledgeHits = await retrieveTopK(client, workspace.id, userMessagePlainText, 4, 0.4, { embedQueryFn: params.embedQueryFn });
  } catch {
    knowledgeHits = [];
  }
  const knowledgeContext = knowledgeHits.length > 0 ? formatKnowledgeBlock(knowledgeHits) : '';
  const effectiveSystemPrompt = knowledgeContext.length > 0
    ? `${knowledgeContext}\n\n${agent.system_prompt}`
    : agent.system_prompt;

  const history = await loadHistory(client, sessionId);
  const messages: AnthropicMessage[] = [...history];
  if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: userMessageContent });
  }

  const toolDefs = toAnthropicToolDefs(tools);
  const maxIters = params.maxToolIterations ?? 6;

  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let iter = 0; iter < maxIters; iter++) {
    const state = await getBudgetState(client, workspace.id);
    if (isOverBudget(state)) {
      yield { type: 'budget_exceeded', spent_usd: state.spentUsd, budget_usd: state.budgetUsd };
      break;
    }

    const req: StreamRequest = {
      model: agent.model,
      systemPrompt: effectiveSystemPrompt,
      messages: [...messages],
      tools: toolDefs,
      // Generous cap so a long preamble plus a long tool_use input (e.g.
      // spawn_dev_agent's task_spec) can both fit in one turn. 1024 was
      // truncating multi-paragraph spec queues before the tool_use block.
      maxTokens: 16384,
    };

    let stopReason: string | null = null;
    let assistantContent: AnthropicMessageContent[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

    try {
      for await (const ev of anthropic.stream(req)) {
        if (ev.type === 'text_delta') {
          yield { type: 'token', text: ev.text };
        } else if (ev.type === 'tool_use_complete') {
          yield { type: 'tool_call', tool_call_id: ev.id, name: ev.name, input: ev.input };
        } else if (ev.type === 'server_tool_use_complete') {
          yield { type: 'tool_call', tool_call_id: ev.id, name: ev.name, input: ev.input };
        } else if (ev.type === 'server_tool_result_complete') {
          yield { type: 'tool_result', tool_call_id: ev.tool_use_id, output: { content: ev.content } as Record<string, unknown> };
        } else if (ev.type === 'message_complete') {
          stopReason = ev.stopReason;
          assistantContent = ev.content;
          usage = {
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
            cacheCreationInputTokens: ev.usage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: ev.usage.cacheReadInputTokens ?? 0,
          };
        }
      }
    } catch (err) {
      yield { type: 'error', code: 'anthropic_error', message: err instanceof Error ? err.message : String(err) };
      break;
    }

    const thisCallCost = costUsd(agent.model, usage);
    totalCost += thisCallCost;
    totalIn += usage.inputTokens;
    totalOut += usage.outputTokens;

    await persistAssistantTurn(client, sessionId, agent.model, assistantContent, usage, thisCallCost);
    await addSpend(client, workspace.id, thisCallCost);

    messages.push({ role: 'assistant', content: assistantContent });

    const toolUses = assistantContent.filter(
      (b): b is Extract<AnthropicMessageContent, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    if (stopReason !== 'tool_use' || toolUses.length === 0) break;

    const toolResultBlocks: AnthropicMessageContent[] = [];

    for (const tu of toolUses) {
      const toolRow = tools.find((t: ToolRow) => t.name === tu.name);
      if (!toolRow) {
        const out = { ok: false, error: `Tool not allowed: ${tu.name}` };
        yield { type: 'tool_result', tool_call_id: tu.id, output: out };
        await persistToolResult(client, sessionId, tu.id, tu.name, out);
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: true });
        continue;
      }

      // worker_job tools don't run inline. They insert a dev_jobs row and
      // return a queued tool_result. A separate worker process picks the job
      // up and posts a notification when the PR is ready. The PR review is
      // the approval gate, so we skip the outbound approval queue here.
      if (toolRow.handler_type === 'worker_job') {
        const cfg = (toolRow.handler_config ?? {}) as Record<string, unknown>;
        const provider = typeof cfg.provider === 'string' ? cfg.provider : 'claude_code';
        const taskSpec = String(tu.input.task_spec ?? '');
        const targetRepo = String(tu.input.target_repo ?? '');
        const targetBranch = typeof tu.input.target_branch === 'string' ? tu.input.target_branch : 'main';
        const maxCostUsd = typeof tu.input.max_cost_usd === 'number' ? tu.input.max_cost_usd : 5.0;
        const maxRuntimeMinutes = typeof tu.input.max_runtime_minutes === 'number' ? tu.input.max_runtime_minutes : 120;
        const { data: jobRow, error: jerr } = await client
          .from('dev_jobs')
          .insert({
            workspace_id: workspace.id,
            agent_id: agent.id,
            session_id: sessionId,
            user_id: params.userId,
            task_spec: taskSpec,
            target_repo: targetRepo,
            target_branch: targetBranch,
            max_cost_usd: maxCostUsd,
            max_runtime_minutes: maxRuntimeMinutes,
            agent_provider: provider,
            agent_provider_config: cfg,
            status: 'queued',
          })
          .select('id')
          .single();
        if (jerr || !jobRow) {
          const out = { ok: false, error: `Failed to queue dev job: ${jerr?.message ?? 'unknown'}` };
          yield { type: 'tool_result', tool_call_id: tu.id, output: out };
          await persistToolResult(client, sessionId, tu.id, tu.name, out);
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: true });
          continue;
        }
        const jobId = (jobRow as { id: string }).id;
        const out = {
          status: 'queued',
          job_id: jobId,
          message: `Queued dev job ${jobId}. The dev agent will work on this asynchronously and notify you via Telegram when the PR is ready. Estimated runtime 30-60 minutes.`,
        };
        yield { type: 'tool_result', tool_call_id: tu.id, output: out };
        await persistToolResult(client, sessionId, tu.id, tu.name, out);
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
        continue;
      }

      const decision = await approvalRequired(client, agent.id, toolRow, workspace.approval_mode);

      if (decision.requiresApproval) {
        const { data: action, error: aerr } = await client
          .from('outbound_actions')
          .insert({
            workspace_id: workspace.id,
            session_id: sessionId,
            action_type: tu.name,
            target: typeof tu.input.to === 'string' ? tu.input.to : null,
            payload: tu.input,
            requires_approval: true,
            status: 'pending',
          })
          .select('id')
          .single();
        if (aerr || !action) {
          const out = { ok: false, error: `Failed to queue action: ${aerr?.message}` };
          yield { type: 'tool_result', tool_call_id: tu.id, output: out };
          await persistToolResult(client, sessionId, tu.id, tu.name, out);
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: true });
          continue;
        }
        const actionId = (action as { id: string }).id;
        const out = { status: 'queued_for_approval', action_id: actionId };
        yield { type: 'tool_result', tool_call_id: tu.id, output: out, queued_for_approval: true, action_id: actionId };
        await persistToolResult(client, sessionId, tu.id, tu.name, out);
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
        continue;
      }

      let out: Record<string, unknown>;
      try {
        if (toolRow.handler_type === 'internal' && tu.name === 'search_knowledge') {
          const q = String(tu.input.query ?? '');
          const max = Math.min(10, Math.max(1, Number(tu.input.max_results ?? 5)));
          const hits = await retrieveTopK(client, workspace.id, q, max, 0.3, { embedQueryFn: params.embedQueryFn });
          out = { hits };
        } else if (toolRow.handler_type === 'internal' && tu.name === 'generate_image') {
          const result = await generateImage(tu.input as unknown as GenerateImageInput);
          out = result as unknown as Record<string, unknown>;
        } else if (toolRow.handler_type === 'internal' && tu.name === 'create_github_repo') {
          const result = await createGithubRepo(tu.input as unknown as CreateGithubRepoInput);
          out = result as unknown as Record<string, unknown>;
        } else if (toolRow.handler_type === 'internal' && tu.name === 'check_dev_jobs') {
          const limit = Math.min(20, Math.max(1, Number(tu.input.limit ?? 5)));
          const statusFilter = typeof tu.input.status === 'string' ? tu.input.status : null;
          let djq = client
            .from('dev_jobs')
            .select('id, task_spec, target_repo, target_branch, status, branch_name, pr_url, pr_number, iterations_used, max_iterations, runtime_seconds, max_runtime_minutes, cost_usd, max_cost_usd, error_message, agent_summary, files_changed, tests_passed, tests_summary, created_at, leased_at, completed_at')
            .eq('workspace_id', workspace.id)
            .eq('user_id', params.userId);
          if (statusFilter) djq = djq.eq('status', statusFilter);
          const { data: jobRows, error: djErr } = await djq.order('created_at', { ascending: false }).limit(limit);
          if (djErr) {
            out = { ok: false, error: `Failed to fetch dev_jobs: ${djErr.message}` };
          } else {
            const now = Date.now();
            const jobs = ((jobRows ?? []) as Array<Record<string, unknown>>).map((j) => {
              const createdAtMs = typeof j.created_at === 'string' ? new Date(j.created_at).getTime() : null;
              const leasedAtMs = typeof j.leased_at === 'string' ? new Date(j.leased_at).getTime() : null;
              const completedAtMs = typeof j.completed_at === 'string' ? new Date(j.completed_at).getTime() : null;
              const startMs = leasedAtMs ?? createdAtMs;
              let elapsedMinutes: number | null = null;
              if (j.status === 'running' && startMs !== null) {
                elapsedMinutes = Math.max(0, Math.round((now - startMs) / 60000));
              } else if (j.status === 'queued' && createdAtMs !== null) {
                elapsedMinutes = Math.max(0, Math.round((now - createdAtMs) / 60000));
              } else if (completedAtMs !== null && startMs !== null) {
                elapsedMinutes = Math.max(0, Math.round((completedAtMs - startMs) / 60000));
              } else if (typeof j.runtime_seconds === 'number') {
                elapsedMinutes = Math.round(j.runtime_seconds / 60);
              }
              const spec = typeof j.task_spec === 'string' ? j.task_spec : '';
              const taskSpecPreview = spec.length > 240 ? spec.slice(0, 240) + '...' : spec;
              return {
                id: j.id,
                status: j.status,
                target_repo: j.target_repo,
                target_branch: j.target_branch,
                task_spec_preview: taskSpecPreview,
                branch_name: j.branch_name ?? null,
                pr_url: j.pr_url ?? null,
                pr_number: j.pr_number ?? null,
                iterations_used: j.iterations_used ?? null,
                max_iterations: j.max_iterations ?? null,
                cost_usd: j.cost_usd ?? null,
                max_cost_usd: j.max_cost_usd ?? null,
                files_changed: j.files_changed ?? null,
                tests_passed: j.tests_passed ?? null,
                tests_summary: j.tests_summary ?? null,
                agent_summary: j.agent_summary ?? null,
                error_message: j.error_message ?? null,
                created_at: j.created_at ?? null,
                leased_at: j.leased_at ?? null,
                completed_at: j.completed_at ?? null,
                elapsed_minutes: elapsedMinutes,
              };
            });
            out = { jobs, count: jobs.length };
          }
        } else {
          out = runMockTool(tu.name, tu.input);
        }
      } catch (err) {
        out = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      yield { type: 'tool_result', tool_call_id: tu.id, output: out };
      await persistToolResult(client, sessionId, tu.id, tu.name, out);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  await touchSession(client, sessionId);
  yield { type: 'done', cost_usd: Number(totalCost.toFixed(6)), tokens_in: totalIn, tokens_out: totalOut };
}

// Convenience: drive runChat to completion and collect final assistant text.
export async function runChatCollecting(
  params: RunChatParams,
  onEvent: (e: ChatStreamEvent) => void | Promise<void>,
): Promise<{ result: ChatRunResult; finalText: string }> {
  let sessionId = params.sessionId ?? '';
  let totalCost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let finalText = '';

  for await (const ev of runChat(params)) {
    await onEvent(ev);
    if (ev.type === 'session') sessionId = ev.session_id;
    if (ev.type === 'token') finalText += ev.text;
    if (ev.type === 'done') {
      totalCost = ev.cost_usd;
      tokensIn = ev.tokens_in;
      tokensOut = ev.tokens_out;
    }
  }
  return {
    result: { sessionId, costUsd: totalCost, tokensIn, tokensOut },
    finalText,
  };
}

// SHARED_RUNTIME_END
