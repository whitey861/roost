// Roost: Claude.ai conversations export ingestion (parser + classifier).
//
// Used by scripts/ingest-claude-export.ts. Pure modules: tests pass
// a fake classifier and a fake embedder; the CLI wires up the real ones.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestDocument, type EmbedderFn, type IngestResult } from './ingest-core.js';
import { WORKSPACES } from './agents.js';

// ---------- Parser ----------

export interface ParsedMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  text: string;
  created_at: string | null;
}

export interface ParsedConversation {
  uuid: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  messages: ParsedMessage[];
}

interface RawContentBlock {
  type?: string;
  text?: string;
}

interface RawMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: RawContentBlock[];
  created_at?: string;
}

interface RawConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: RawMessage[];
}

// Pull message text out of either `text` or `content[].text` (preferring
// `text` when both present). Returns trimmed text or '' if nothing usable.
export function extractMessageText(msg: RawMessage): string {
  if (typeof msg.text === 'string' && msg.text.trim().length > 0) {
    return msg.text.trim();
  }
  if (Array.isArray(msg.content)) {
    const parts = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b.text ?? '').trim())
      .filter((s) => s.length > 0);
    return parts.join('\n\n');
  }
  return '';
}

export function parseConversations(raw: unknown): ParsedConversation[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedConversation[] = [];
  for (const c of raw as RawConversation[]) {
    if (!c || typeof c.uuid !== 'string') continue;
    const messages: ParsedMessage[] = [];
    for (const m of c.chat_messages ?? []) {
      const text = extractMessageText(m);
      if (text.length === 0) continue;
      const senderRaw = m.sender ?? 'human';
      const sender = senderRaw === 'assistant' ? 'assistant' : 'human';
      messages.push({
        uuid: m.uuid ?? '',
        sender,
        text,
        created_at: m.created_at ?? null,
      });
    }
    if (messages.length === 0) continue;
    out.push({
      uuid: c.uuid,
      name: (c.name ?? '').trim() || `Conversation ${c.uuid.slice(0, 8)}`,
      created_at: c.created_at ?? null,
      updated_at: c.updated_at ?? c.created_at ?? null,
      messages,
    });
  }
  return out;
}

// ---------- Markdown renderer ----------

// Build a markdown document the existing chunker can split on `##`
// headers. Each message becomes a section. Code blocks are preserved
// verbatim (don't strip fences).
export function renderConversationMarkdown(conv: ParsedConversation): string {
  const shortUuid = conv.uuid.slice(0, 8);
  const updated = conv.updated_at ?? conv.created_at ?? 'unknown';
  const lines: string[] = [];
  lines.push(`# ${conv.name}`);
  lines.push('');
  lines.push(`_Source: Claude.ai export, conversation ${shortUuid}, last updated ${updated}_`);
  lines.push('');
  conv.messages.forEach((m, i) => {
    const who = m.sender === 'assistant' ? 'Assistant' : 'Paul';
    lines.push(`## Message ${i + 1}: ${who}`);
    lines.push('');
    lines.push(m.text);
    lines.push('');
  });
  return lines.join('\n');
}

// ---------- Classifier ----------

export type WorkspaceClassification =
  | { workspace: 'pmhc' | 'kca' | 'personal' | 'budget' | 'dev'; confidence: number; reasoning?: string }
  | { workspace: 'multiple'; primary: 'pmhc' | 'kca' | 'personal' | 'budget' | 'dev'; workspaces: string[]; confidence: number; reasoning?: string }
  | { workspace: 'none'; reasoning?: string };

export interface ClassifierUsage {
  inputTokens: number;
  outputTokens: number;
}

export type Classifier = (input: { systemPrompt: string; userPrompt: string }) => Promise<{ text: string; usage: ClassifierUsage }>;

const VALID_WORKSPACES = ['pmhc', 'kca', 'personal', 'budget', 'dev'] as const;

const CLASSIFIER_SYSTEM_PROMPT = `You are classifying a conversation into one of Paul White's Roost workspaces.

Workspaces:
- pmhc: Port Macquarie-Hastings Council work (Paul is CIO; council programs, ELT, Beacon, Civica, AI Strategy)
- kca: Koala Conservation Australia (Paul is Acting GM and Board Director; hospital build, Guulabaa, board governance, fundraising)
- personal: family, household, foster care, JP duties, household admin
- budget: household finances, Float app, savings buckets, spending
- dev: Adevus product development (Vox, Beacon, Vigil, Roost etc; Lovable + Supabase + AWS stack)
- none: not relevant to any workspace (general knowledge, unrelated topics, one-off questions)
- multiple: spans more than one workspace clearly

Respond with JSON only:
{ "workspace": "pmhc" | "kca" | "personal" | "budget" | "dev" | "none" | "multiple", "confidence": 0.0-1.0, "reasoning": "1-sentence reason" }

For "multiple", also include "workspaces": ["...","..."] and "primary": "<one of the workspaces>".
Do not include any text outside the JSON object.`;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '...';
}

export function buildClassifierPrompts(conv: ParsedConversation): { systemPrompt: string; userPrompt: string } {
  const firstUser = conv.messages.find((m) => m.sender === 'human');
  const firstAssistant = conv.messages.find((m) => m.sender === 'assistant');
  const userPrompt = [
    `Title: ${conv.name}`,
    `First user message: ${truncate(firstUser?.text ?? '(none)', 500)}`,
    `First assistant message: ${truncate(firstAssistant?.text ?? '(none)', 500)}`,
  ].join('\n');
  return { systemPrompt: CLASSIFIER_SYSTEM_PROMPT, userPrompt };
}

// Defensive JSON extractor: tolerates markdown code fences and stray
// prose around the JSON object.
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  // Strip ```json ... ``` fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1]! : trimmed;
  // Find the first '{' and the last '}' to handle leading/trailing prose.
  const i = candidate.indexOf('{');
  const j = candidate.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  const slice = candidate.slice(i, j + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function isValidWorkspace(v: unknown): v is (typeof VALID_WORKSPACES)[number] {
  return typeof v === 'string' && (VALID_WORKSPACES as readonly string[]).includes(v);
}

function parseClassification(raw: unknown): WorkspaceClassification | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ws = r.workspace;
  const reasoning = typeof r.reasoning === 'string' ? r.reasoning : undefined;
  const confRaw = typeof r.confidence === 'number' ? r.confidence : 1;
  const confidence = Math.max(0, Math.min(1, confRaw));

  if (ws === 'none') return { workspace: 'none', reasoning };
  if (ws === 'multiple') {
    const primary = isValidWorkspace(r.primary) ? r.primary : null;
    const workspaces = Array.isArray(r.workspaces) ? r.workspaces.filter(isValidWorkspace) : [];
    if (!primary || workspaces.length < 2) {
      return { workspace: 'none', reasoning: 'multiple with bad primary/workspaces' };
    }
    return { workspace: 'multiple', primary, workspaces, confidence, reasoning };
  }
  if (isValidWorkspace(ws)) {
    return { workspace: ws, confidence, reasoning };
  }
  return null;
}

export interface ClassifyResult {
  classification: WorkspaceClassification;
  usage: ClassifierUsage;
}

export async function classifyConversation(
  conv: ParsedConversation,
  classifier: Classifier,
  options: { lowConfidenceThreshold?: number } = {},
): Promise<ClassifyResult> {
  const threshold = options.lowConfidenceThreshold ?? 0.5;
  const { systemPrompt, userPrompt } = buildClassifierPrompts(conv);
  let lastUsage: ClassifierUsage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await classifier({ systemPrompt, userPrompt });
    lastUsage = { inputTokens: lastUsage.inputTokens + usage.inputTokens, outputTokens: lastUsage.outputTokens + usage.outputTokens };
    const json = extractJson(text);
    const parsed = parseClassification(json);
    if (parsed) {
      // Treat low confidence as none, but keep multiple as-is (it has its
      // own confidence semantics).
      if (parsed.workspace !== 'none' && parsed.workspace !== 'multiple') {
        if (parsed.confidence < threshold) {
          return {
            classification: { workspace: 'none', reasoning: `low confidence (${parsed.confidence.toFixed(2)}) for ${parsed.workspace}` },
            usage: lastUsage,
          };
        }
      }
      return { classification: parsed, usage: lastUsage };
    }
  }
  return {
    classification: { workspace: 'none', reasoning: 'classifier returned unparseable output twice' },
    usage: lastUsage,
  };
}

// ---------- Live classifier (Claude Haiku via fetch) ----------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicClassifierOptions {
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function makeAnthropicClassifier(opts: AnthropicClassifierOptions = {}): Classifier {
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).process?.env ?? {};
  const apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  const model = opts.model ?? env.CLAUDE_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async ({ systemPrompt, userPrompt }) => {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; cannot classify Claude.ai conversations.');
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic classify ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const usage: ClassifierUsage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
    return { text, usage };
  };
}

// ---------- Ingest pipeline ----------

export interface IngestPipelineOptions {
  force?: boolean;
  dryRun?: boolean;
  excludePersonal?: boolean;
}

export interface ConversationRunReport {
  uuid: string;
  title: string;
  outcome: 'skip-existing' | 'skip-none' | 'skip-low-confidence' | 'skip-personal-excluded' | 'ingested-dry' | 'ingested';
  classification?: WorkspaceClassification;
  workspaceSlug?: string;
  result?: IngestResult;
  classifierUsage?: ClassifierUsage;
  error?: string;
}

export interface PipelineSummary {
  byWorkspace: Record<string, { conversations: number; chunks: number; tokens: number }>;
  skippedNone: number;
  skippedExisting: number;
  classifierInputTokens: number;
  classifierOutputTokens: number;
  totalIngestedConversations: number;
  totalChunks: number;
  totalEmbedTokens: number;
}

const ALL_SLUGS = WORKSPACES.map((w) => w.slug);

export async function loadWorkspaceIdMap(client: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await client.from('workspaces').select('id, slug').in('slug', ALL_SLUGS);
  if (error) throw new Error(`workspaces lookup failed: ${error.message}`);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ id: string; slug: string }>) out[row.slug] = row.id;
  return out;
}

async function existingDocByRef(client: SupabaseClient, sourceRef: string): Promise<{ id: string; workspace_id: string } | null> {
  const { data, error } = await client
    .from('knowledge_documents')
    .select('id, workspace_id')
    .eq('source_ref', sourceRef)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id: string; workspace_id: string } | null) ?? null;
}

export async function ingestOneConversation(
  client: SupabaseClient,
  embed: EmbedderFn,
  classifier: Classifier,
  workspaceIds: Record<string, string>,
  conv: ParsedConversation,
  opts: IngestPipelineOptions,
): Promise<ConversationRunReport> {
  const sourceRef = `claude_export:${conv.uuid}`;

  if (!opts.force) {
    const existing = await existingDocByRef(client, sourceRef);
    if (existing) {
      return { uuid: conv.uuid, title: conv.name, outcome: 'skip-existing' };
    }
  }

  const { classification, usage: classifierUsage } = await classifyConversation(conv, classifier);

  if (classification.workspace === 'none') {
    return { uuid: conv.uuid, title: conv.name, outcome: 'skip-none', classification, classifierUsage };
  }

  let workspaceSlug: string;
  let secondaryWorkspaces: string[] = [];
  if (classification.workspace === 'multiple') {
    workspaceSlug = classification.primary;
    secondaryWorkspaces = classification.workspaces.filter((w) => w !== classification.primary);
  } else {
    workspaceSlug = classification.workspace;
  }

  if (opts.excludePersonal && workspaceSlug === 'personal') {
    return {
      uuid: conv.uuid,
      title: conv.name,
      outcome: 'skip-personal-excluded',
      classification,
      classifierUsage,
    };
  }

  const workspaceId = workspaceIds[workspaceSlug];
  if (!workspaceId) {
    return {
      uuid: conv.uuid,
      title: conv.name,
      outcome: 'skip-none',
      classification,
      classifierUsage,
      error: `Unknown workspace slug "${workspaceSlug}". Run npm run seed first.`,
    };
  }

  if (opts.dryRun) {
    return {
      uuid: conv.uuid,
      title: conv.name,
      outcome: 'ingested-dry',
      classification,
      workspaceSlug,
      classifierUsage,
    };
  }

  // If --force, also clean up any rows in OTHER workspaces for this
  // source_ref (rare; happens after re-classification across workspaces).
  if (opts.force) {
    await client.from('knowledge_documents').delete()
      .eq('source_ref', sourceRef)
      .neq('workspace_id', workspaceId);
  }

  const markdown = renderConversationMarkdown(conv);
  const updatedAtMs = conv.updated_at ? Date.parse(conv.updated_at) : Date.now();

  // Bake the conversation date into a YAML frontmatter block so the
  // existing ingest-core picks up title, tags, source_url cleanly.
  const tags = ['claude_export', workspaceSlug];
  if (secondaryWorkspaces.length > 0) tags.push(...secondaryWorkspaces.map((s) => `also:${s}`));
  const frontmatter = [
    '---',
    `title: ${conv.name.replace(/\n/g, ' ').slice(0, 200)}`,
    `tags: [${tags.join(', ')}]`,
    'source_type: claude_export',
    '---',
    '',
  ].join('\n');
  const raw = frontmatter + markdown;

  const result = await ingestDocument(client, embed, {
    workspaceId,
    workspaceSlug,
    sourceRef,
    fileMtimeMs: Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
    raw,
    defaultTitle: conv.name,
    force: true,
  });

  // Stamp the metadata column with secondary workspaces if any.
  if (secondaryWorkspaces.length > 0) {
    await client
      .from('knowledge_documents')
      .update({ metadata: { secondary_workspaces: secondaryWorkspaces } })
      .eq('id', result.documentId);
  }

  return {
    uuid: conv.uuid,
    title: conv.name,
    outcome: 'ingested',
    classification,
    workspaceSlug,
    result,
    classifierUsage,
  };
}

export function summarise(reports: ConversationRunReport[]): PipelineSummary {
  const summary: PipelineSummary = {
    byWorkspace: {},
    skippedNone: 0,
    skippedExisting: 0,
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    totalIngestedConversations: 0,
    totalChunks: 0,
    totalEmbedTokens: 0,
  };

  for (const r of reports) {
    if (r.classifierUsage) {
      summary.classifierInputTokens += r.classifierUsage.inputTokens;
      summary.classifierOutputTokens += r.classifierUsage.outputTokens;
    }
    if (r.outcome === 'skip-existing') {
      summary.skippedExisting += 1;
      continue;
    }
    if (r.outcome === 'skip-none' || r.outcome === 'skip-low-confidence' || r.outcome === 'skip-personal-excluded') {
      summary.skippedNone += 1;
      continue;
    }
    if (r.outcome === 'ingested' || r.outcome === 'ingested-dry') {
      const slug = r.workspaceSlug ?? 'unknown';
      const cell = summary.byWorkspace[slug] ?? { conversations: 0, chunks: 0, tokens: 0 };
      cell.conversations += 1;
      if (r.result) {
        cell.chunks += r.result.chunkCount;
        cell.tokens += r.result.totalTokens;
        summary.totalChunks += r.result.chunkCount;
        summary.totalEmbedTokens += r.result.totalTokens;
      }
      summary.byWorkspace[slug] = cell;
      summary.totalIngestedConversations += 1;
    }
  }
  return summary;
}

// Voyage embeds at ~$0.06 / M; Haiku 4.5 at $1/M input + $5/M output.
const VOYAGE_USD_PER_M = 0.06;
const HAIKU_INPUT_USD_PER_M = 1.0;
const HAIKU_OUTPUT_USD_PER_M = 5.0;

export interface CostBreakdown {
  voyageUsd: number;
  classifierUsd: number;
  totalUsd: number;
}

export function estimateCost(summary: PipelineSummary): CostBreakdown {
  const voyageUsd = (summary.totalEmbedTokens / 1_000_000) * VOYAGE_USD_PER_M;
  const classifierUsd =
    (summary.classifierInputTokens / 1_000_000) * HAIKU_INPUT_USD_PER_M +
    (summary.classifierOutputTokens / 1_000_000) * HAIKU_OUTPUT_USD_PER_M;
  return {
    voyageUsd: Number(voyageUsd.toFixed(6)),
    classifierUsd: Number(classifierUsd.toFixed(6)),
    totalUsd: Number((voyageUsd + classifierUsd).toFixed(6)),
  };
}
