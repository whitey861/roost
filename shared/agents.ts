// Roost: seed definitions for the five workspaces and their default agents.
// `scripts/seed.ts` reads this file to populate the database.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkspaceSeed {
  slug: string;
  name: string;
  description: string;
}

export interface AgentSeed {
  workspaceSlug: string;
  name: string;
  roleDescription: string;
  promptFile: string;
  model: string;
  toolNames: string[];
}

export const WORKSPACES: WorkspaceSeed[] = [
  {
    slug: 'pmhc',
    name: 'PMHC',
    description: 'Primary mental health care work, clinical operations, KPIs, and reporting.',
  },
  {
    slug: 'kca',
    name: 'KCA',
    description: 'Kids Cancer Australia: program planning, fundraising, partner communications.',
  },
  {
    slug: 'personal',
    name: 'Personal',
    description: 'Day to day life: admin, errands, communications, calendar, and household.',
  },
  {
    slug: 'budget',
    name: 'Budget',
    description: 'Finances: budgets, transactions, savings goals, and spending analysis.',
  },
  {
    slug: 'dev',
    name: 'Dev',
    description: 'Engineering: code reviews, architecture, automation, and tooling.',
  },
];

// Default model for newly seeded agents. Sonnet 4.6 covers the bulk of Roost
// work at ~5x lower cost than Opus 4.7. Switch a specific agent back to Opus
// only when the quality lift is worth the cost (long-form writing, deep
// analysis):
//   update agents set model = 'claude-opus-4-7' where name = '...';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Tool allow-list per agent. The dev workspace gets spawn_dev_agent on top
// of the standard set; everything else stays generic.
function toolNamesForWorkspace(slug: string): string[] {
  const base = ['mock_echo', 'mock_search', 'search_knowledge', 'web_search'];
  if (slug === 'dev') return [...base, 'spawn_dev_agent', 'check_dev_jobs'];
  return base;
}

export const AGENTS: AgentSeed[] = WORKSPACES.map((ws) => ({
  workspaceSlug: ws.slug,
  name: `${ws.name} Assistant`,
  roleDescription: `Default assistant for the ${ws.name} workspace.`,
  promptFile: `prompts/${ws.slug}.md`,
  model: DEFAULT_MODEL,
  toolNames: toolNamesForWorkspace(ws.slug),
}));

// Resolve a prompt file path relative to the repository root, regardless of
// where the caller is running from. shared/agents.ts lives at <root>/shared/.
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..');
}

export function readPromptFile(promptFile: string): string {
  const abs = join(repoRoot(), promptFile);
  return readFileSync(abs, 'utf8');
}

// Returns the system prompt content for an agent at seed time.
// Throws if the prompt file is missing: a missing prompt file is a seed bug,
// not a silent fall-back to a generic prompt.
export function loadSystemPrompt(agent: AgentSeed): string {
  const text = readPromptFile(agent.promptFile);
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(`Empty prompt file: ${agent.promptFile}`);
  }
  return trimmed;
}
