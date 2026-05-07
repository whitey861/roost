// Static checks on seed definitions. Behavioural seed runs hit a real
// Supabase, which is out of scope for unit tests.

import { describe, it, expect } from 'vitest';
import { WORKSPACES, AGENTS } from '../shared/agents.js';
import { TOOLS } from '../shared/tools.js';

describe('seed: workspaces and agents', () => {
  it('seeds the five expected workspaces', () => {
    const slugs = WORKSPACES.map((w) => w.slug).sort();
    expect(slugs).toEqual(['budget', 'dev', 'kca', 'personal', 'pmhc']);
  });

  it('every workspace has exactly one default agent', () => {
    for (const ws of WORKSPACES) {
      const agents = AGENTS.filter((a) => a.workspaceSlug === ws.slug);
      expect(agents).toHaveLength(1);
    }
  });

  it('agent system prompts include the workspace context', () => {
    for (const a of AGENTS) {
      const ws = WORKSPACES.find((w) => w.slug === a.workspaceSlug)!;
      expect(a.systemPrompt).toContain(ws.description);
    }
  });

  it('agent system prompts contain no em dashes', () => {
    for (const a of AGENTS) {
      expect(a.systemPrompt.includes('—')).toBe(false);
    }
  });
});

describe('seed: tools', () => {
  it('includes the mock tools used by the chat runtime', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('mock_echo');
    expect(names).toContain('mock_search');
    expect(names).toContain('mock_send_email');
  });

  it('mock_send_email is outbound and requires approval by default', () => {
    const t = TOOLS.find((x) => x.name === 'mock_send_email')!;
    expect(t.isOutbound).toBe(true);
    expect(t.requiresApprovalDefault).toBe(true);
  });
});
