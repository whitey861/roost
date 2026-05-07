// Roost: seed definitions for the five workspaces and their default agents.
// `scripts/seed.ts` reads this file to populate the database.

export interface WorkspaceSeed {
  slug: string;
  name: string;
  description: string;
}

export interface AgentSeed {
  workspaceSlug: string;
  name: string;
  roleDescription: string;
  systemPrompt: string;
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

const baseGuardrails = [
  'You are part of Roost, a personal AI agent platform.',
  'Be concise. Use plain Australian English.',
  'Do not use em dashes. Prefer commas, colons, or shorter sentences.',
  'When the user asks for an outbound action like sending an email, posting a message, or writing to an external system, propose it clearly and let the platform handle approval.',
  'If a tool result indicates the action was queued for approval, tell the user it is queued and what they need to do.',
].join(' ');

function prompt(workspace: WorkspaceSeed): string {
  return [
    `You are the ${workspace.name} Assistant.`,
    `Domain context: ${workspace.description}`,
    baseGuardrails,
  ].join('\n\n');
}

export const AGENTS: AgentSeed[] = WORKSPACES.map((ws) => ({
  workspaceSlug: ws.slug,
  name: `${ws.name} Assistant`,
  roleDescription: `Default assistant for the ${ws.name} workspace.`,
  systemPrompt: prompt(ws),
  toolNames: ['mock_echo', 'mock_search'],
}));
