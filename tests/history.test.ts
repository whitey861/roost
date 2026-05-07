import { describe, it, expect } from 'vitest';
import { reconstructHistory } from '../shared/chat-runtime.js';

describe('reconstructHistory', () => {
  it('groups assistant tool_use + tool_result correctly', () => {
    const rows = [
      { role: 'user', content: 'hi', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'assistant', content: 'thinking', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'tool_call', content: null, tool_call_id: 'tc1', tool_name: 'mock_search', tool_input: { query: 'x' }, tool_output: null },
      { role: 'tool_result', content: null, tool_call_id: 'tc1', tool_name: 'mock_search', tool_input: null, tool_output: { results: [] } },
      { role: 'assistant', content: 'done', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
    ];
    const messages = reconstructHistory(rows);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[1]?.role).toBe('assistant');
    const aBlocks = messages[1]!.content as Array<{ type: string }>;
    expect(aBlocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(messages[2]?.role).toBe('user');
    const trBlocks = messages[2]!.content as Array<{ type: string }>;
    expect(trBlocks[0]?.type).toBe('tool_result');
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  });

  it('returns an empty array for no rows', () => {
    expect(reconstructHistory([])).toEqual([]);
  });
});
