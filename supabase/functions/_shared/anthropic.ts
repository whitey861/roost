// Roost: thin Anthropic client + streaming wrapper.
// Returns an async iterable of high-level events that the chat runtime
// can act on: text deltas, tool_use blocks (with parsed input), and
// final usage/stop_reason.

// @ts-ignore: npm specifier resolved by Deno at runtime.
import Anthropic from 'npm:@anthropic-ai/sdk@0.40.1';
import { env } from './env.ts';
import type { AnthropicToolDef } from './types.ts';

export type AnthropicMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

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
  | {
      type: 'message_complete';
      stopReason: string | null;
      content: AnthropicMessageContent[];
      usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
    };

export interface AnthropicClient {
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

// Default real client. Tests override by passing a custom AnthropicClient.
export function defaultAnthropicClient(): AnthropicClient {
  // deno-lint-ignore no-explicit-any
  const client = new (Anthropic as any)({ apiKey: env('ANTHROPIC_API_KEY') });
  return {
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      const stream = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages: req.messages,
        tools: req.tools,
        stream: true,
      });

      // Track current content blocks by index.
      const blocks: Record<number, { type: 'text' | 'tool_use'; text?: string; id?: string; name?: string; partialJson?: string }> = {};
      const finalContent: AnthropicMessageContent[] = [];
      let stopReason: string | null = null;
      const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

      for await (const event of stream) {
        // deno-lint-ignore no-explicit-any
        const e = event as any;
        if (e.type === 'message_start') {
          const u = e.message?.usage ?? {};
          usage.inputTokens += u.input_tokens ?? 0;
          usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
          usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
          continue;
        }
        if (e.type === 'content_block_start') {
          const idx = e.index as number;
          const cb = e.content_block;
          if (cb.type === 'text') {
            blocks[idx] = { type: 'text', text: '' };
          } else if (cb.type === 'tool_use') {
            blocks[idx] = { type: 'tool_use', id: cb.id, name: cb.name, partialJson: '' };
          }
          continue;
        }
        if (e.type === 'content_block_delta') {
          const idx = e.index as number;
          const block = blocks[idx];
          if (!block) continue;
          if (e.delta.type === 'text_delta' && block.type === 'text') {
            block.text = (block.text ?? '') + e.delta.text;
            yield { type: 'text_delta', text: e.delta.text };
          } else if (e.delta.type === 'input_json_delta' && block.type === 'tool_use') {
            block.partialJson = (block.partialJson ?? '') + (e.delta.partial_json ?? '');
          }
          continue;
        }
        if (e.type === 'content_block_stop') {
          const idx = e.index as number;
          const block = blocks[idx];
          if (!block) continue;
          if (block.type === 'text') {
            finalContent.push({ type: 'text', text: block.text ?? '' });
          } else if (block.type === 'tool_use') {
            const id = block.id ?? '';
            const name = block.name ?? '';
            const raw = block.partialJson ?? '';
            let input: Record<string, unknown> = {};
            if (raw.length > 0) {
              try {
                input = JSON.parse(raw);
              } catch {
                input = { _raw: raw };
              }
            }
            finalContent.push({ type: 'tool_use', id, name, input });
            yield { type: 'tool_use_complete', id, name, input };
          }
          continue;
        }
        if (e.type === 'message_delta') {
          stopReason = e.delta?.stop_reason ?? stopReason;
          if (e.usage) {
            usage.outputTokens += e.usage.output_tokens ?? 0;
          }
          continue;
        }
        if (e.type === 'message_stop') {
          break;
        }
      }
      yield {
        type: 'message_complete',
        stopReason,
        content: finalContent,
        usage,
      };
    },
  };
}
