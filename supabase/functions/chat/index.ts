// Roost: POST /chat
// Authenticated, member-only entrypoint for the web chat. Streams SSE
// events back to the client. Body shape:
//   { workspace_id: uuid, session_id?: uuid, agent_id?: uuid, message: string }

import { requireAuth } from '../_shared/auth.ts';
import { serviceRoleClient } from '../_shared/supabase.ts';
import { jsonError, corsHeaders, HttpError } from '../_shared/errors.ts';
import { defaultAnthropicClient } from '../_shared/anthropic.ts';
import { runChat } from '../_shared/chat-runtime.ts';
import type { ChatStreamEvent } from '../_shared/types.ts';

interface ChatRequestBody {
  workspace_id?: string;
  session_id?: string;
  agent_id?: string;
  message?: string;
}

function sseLine(ev: ChatStreamEvent): Uint8Array {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  return new TextEncoder().encode(payload);
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', 'Use POST.');
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.code, err.message);
    return jsonError(401, 'unauthorized', 'Authentication failed.');
  }

  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', 'Body must be valid JSON.');
  }

  if (!body.workspace_id || typeof body.workspace_id !== 'string') {
    return jsonError(400, 'invalid_request', 'workspace_id is required.');
  }
  if (!body.message || typeof body.message !== 'string') {
    return jsonError(400, 'invalid_request', 'message is required.');
  }

  const service = serviceRoleClient();

  // Membership check (the JWT user must belong to the workspace).
  const { data: membership, error: mErr } = await service
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', body.workspace_id)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (mErr) return jsonError(500, 'membership_lookup_failed', mErr.message);
  if (!membership) return jsonError(403, 'forbidden', 'You are not a member of this workspace.');

  const anthropic = defaultAnthropicClient();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of runChat({
          client: service,
          anthropic,
          workspaceId: body.workspace_id!,
          userId: auth.userId,
          agentId: body.agent_id,
          sessionId: body.session_id,
          channel: 'web',
          userMessage: body.message!,
        })) {
          controller.enqueue(sseLine(ev));
          if (ev.type === 'budget_exceeded' || ev.type === 'error') break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseLine({ type: 'error', code: 'runtime_error', message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve(handle);
