// Scripted fake of AnthropicClient. Each call to stream() pops the next
// scripted response off the queue and replays it as a stream of events.

import type { AnthropicClient, AnthropicMessageContent, StreamEvent, StreamRequest } from '../../shared/anthropic.js';

export interface ScriptedResponse {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  inputTokens?: number;
  outputTokens?: number;
}

export class FakeAnthropic implements AnthropicClient {
  public calls: StreamRequest[] = [];
  constructor(private readonly script: ScriptedResponse[]) {}

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) {
      throw new Error('FakeAnthropic: no more scripted responses');
    }
    const content: AnthropicMessageContent[] = [];
    if (next.text) {
      // emit each character as a delta to exercise the streaming path
      for (const ch of next.text) yield { type: 'text_delta', text: ch };
      content.push({ type: 'text', text: next.text });
    }
    if (next.toolUses) {
      for (const tu of next.toolUses) {
        content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
        yield { type: 'tool_use_complete', id: tu.id, name: tu.name, input: tu.input };
      }
    }
    yield {
      type: 'message_complete',
      stopReason: next.stopReason,
      content,
      usage: { inputTokens: next.inputTokens ?? 100, outputTokens: next.outputTokens ?? 50 },
    };
  }
}
