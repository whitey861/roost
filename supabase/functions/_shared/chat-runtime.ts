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
import { approvalRequired, loadAgentTools, runMockTool, toAnthropicToolDefs, type ToolRow } from './tools.ts';
import type { AnthropicClient, AnthropicMessage, AnthropicMessageContent, StreamRequest } from './anthropic.ts';
import { costUsd } from './pricing.ts';

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
  userMessage: string;
  maxToolIterations?: number;
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
    const { data, error } = await client.from('sessions').select('id').eq('id', args.sessionId).single();
    if (error || !data) throw new Error(`Session not found: ${args.sessionId}`);
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
      content: string | null;
      tool_call_id: string | null;
      tool_name: string | null;
      tool_input: Record<string, unknown> | null;
      tool_output: Record<string, unknown> | null;
    }>,
  );
}

// Pure: turn ordered DB rows into Claude-shaped message history.
export function reconstructHistory(rows: Array<{
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  tool_output: Record<string, unknown> | null;
}>): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  let pendingAssistant: AnthropicMessageContent[] | null = null;
  let pendingToolResults: AnthropicMessageContent[] | null = null;

  for (const m of rows) {
    if (m.role === 'user') {
      if (pendingAssistant) { messages.push({ role: 'assistant', content: pendingAssistant }); pendingAssistant = null; }
      if (pendingToolResults) { messages.push({ role: 'user', content: pendingToolResults }); pendingToolResults = null; }
      messages.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      if (pendingToolResults) { messages.push({ role: 'user', content: pendingToolResults }); pendingToolResults = null; }
      pendingAssistant = pendingAssistant ?? [];
      pendingAssistant.push({ type: 'text', text: m.content ?? '' });
    } else if (m.role === 'tool_call') {
      pendingAssistant = pendingAssistant ?? [];
      pendingAssistant.push({
        type: 'tool_use',
        id: m.tool_call_id ?? '',
        name: m.tool_name ?? '',
        input: (m.tool_input ?? {}) as Record<string, unknown>,
      });
    } else if (m.role === 'tool_result') {
      if (pendingAssistant) { messages.push({ role: 'assistant', content: pendingAssistant }); pendingAssistant = null; }
      pendingToolResults = pendingToolResults ?? [];
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: JSON.stringify(m.tool_output ?? {}),
      });
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
    } else if (block.type === 'tool_use') {
      await client.from('messages').insert({
        session_id: sessionId,
        role: 'tool_call',
        tool_call_id: block.id,
        tool_name: block.name,
        tool_input: block.input,
        model,
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

async function persistUserMessage(client: SupabaseClient, sessionId: string, text: string): Promise<void> {
  await client.from('messages').insert({ session_id: sessionId, role: 'user', content: text });
}

async function touchSession(client: SupabaseClient, sessionId: string): Promise<void> {
  await client.from('sessions').update({ last_message_at: new Date().toISOString() }).eq('id', sessionId);
}

export async function* runChat(params: RunChatParams): AsyncIterable<ChatStreamEvent> {
  const { client, anthropic } = params;
  const { workspace, agent, tools } = await loadContext(client, params.workspaceId, params.agentId);

  const sessionId = await loadOrCreateSession(client, {
    workspaceId: workspace.id,
    userId: params.userId,
    agentId: agent.id,
    channel: params.channel,
    channelIdentifier: params.channelIdentifier,
    sessionId: params.sessionId,
    firstMessage: params.userMessage,
  });
  yield { type: 'session', session_id: sessionId };

  const initialState = await rolloverIfNeeded(client, workspace.id);
  if (isOverBudget(initialState)) {
    yield { type: 'budget_exceeded', spent_usd: initialState.spentUsd, budget_usd: initialState.budgetUsd };
    return;
  }

  await persistUserMessage(client, sessionId, params.userMessage);

  const history = await loadHistory(client, sessionId);
  const messages: AnthropicMessage[] = [...history];
  if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: params.userMessage });
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
      systemPrompt: agent.system_prompt,
      messages: [...messages],
      tools: toolDefs,
      maxTokens: 1024,
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
        out = runMockTool(tu.name, tu.input);
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
