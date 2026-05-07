import { describe, it, expect } from 'vitest';
import { runMockTool } from '../shared/tools.js';
import { approvalDecisionPure } from '../shared/tools-runtime.js';

describe('mock tools', () => {
  it('mock_echo returns input verbatim', () => {
    expect(runMockTool('mock_echo', { text: 'hello' })).toEqual({ echoed: 'hello' });
  });

  it('mock_search returns three results', () => {
    const out = runMockTool('mock_search', { query: 'roost' }) as { results: unknown[]; query: string };
    expect(out.query).toBe('roost');
    expect(out.results).toHaveLength(3);
  });

  it('returns ok:false for unknown tool', () => {
    expect(runMockTool('nope', {})).toEqual({ ok: false, error: 'Unknown mock tool: nope' });
  });
});

describe('approvalDecisionPure', () => {
  it('override true wins over everything', () => {
    const d = approvalDecisionPure(true, false, false, 'autonomous');
    expect(d).toEqual({ requiresApproval: true, reason: 'override' });
  });
  it('override false wins over tool default', () => {
    const d = approvalDecisionPure(false, true, true, 'all_outbound');
    expect(d).toEqual({ requiresApproval: false, reason: 'override' });
  });
  it('tool default true forces approval', () => {
    const d = approvalDecisionPure(null, true, false, 'autonomous');
    expect(d).toEqual({ requiresApproval: true, reason: 'tool_default' });
  });
  it('autonomous mode skips approval for non-default tools', () => {
    const d = approvalDecisionPure(null, false, true, 'autonomous');
    expect(d).toEqual({ requiresApproval: false, reason: 'autonomous' });
  });
  it('all_outbound + outbound tool requires approval', () => {
    const d = approvalDecisionPure(null, false, true, 'all_outbound');
    expect(d).toEqual({ requiresApproval: true, reason: 'workspace_all_outbound' });
  });
  it('all_outbound + non-outbound tool does not require approval', () => {
    const d = approvalDecisionPure(null, false, false, 'all_outbound');
    expect(d).toEqual({ requiresApproval: false, reason: 'allowlist' });
  });
});
