// Roost: seed definitions for the five workspaces and their default agents.
// `scripts/seed.ts` reads this file to populate the database.
//
// System prompts now live as plain markdown in `prompts/<slug>.md`. The
// seed reads them on INSERT only and never overwrites a manual edit on
// existing agents. Use `scripts/sync-prompts.ts` to push edited prompts
// to the database explicitly.

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

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-6';

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

export const AGENTS: AgentSeed[] = WORKSPACES.map((ws) => ({
  workspaceSlug: ws.slug,
  name: `${ws.name} Assistant`,
  roleDescription: `Default assistant for the ${ws.name} workspace.`,
  promptFile: `prompts/${ws.slug}.md`,
  model: DEFAULT_AGENT_MODEL,
  toolNames: ['mock_echo', 'mock_search', 'search_knowledge'],
}));
