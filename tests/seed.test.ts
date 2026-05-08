// Static checks on seed definitions. Behavioural seed runs hit a real
// Supabase, which is out of scope for unit tests.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACES, AGENTS, DEFAULT_AGENT_MODEL } from '../shared/agents.js';
import { TOOLS } from '../shared/tools.js';

const REPO_ROOT = join(__dirname, '..');

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

  it('every agent has a markdown prompt file that exists on disk', () => {
    for (const a of AGENTS) {
      const path = join(REPO_ROOT, a.promptFile);
      expect(existsSync(path), `missing ${a.promptFile}`).toBe(true);
    }
  });

  it('agent prompt files include the workspace description', () => {
    for (const a of AGENTS) {
      const ws = WORKSPACES.find((w) => w.slug === a.workspaceSlug)!;
      const content = readFileSync(join(REPO_ROOT, a.promptFile), 'utf8');
      expect(content).toContain(ws.description);
    }
  });

  it('agent prompt files contain no em dashes', () => {
    for (const a of AGENTS) {
      const content = readFileSync(join(REPO_ROOT, a.promptFile), 'utf8');
      expect(content.includes('—'), `${a.promptFile} contains em dash`).toBe(false);
    }
  });

  it('all default agents use Sonnet 4.6', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-sonnet-4-6');
    for (const a of AGENTS) expect(a.model).toBe('claude-sonnet-4-6');
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
