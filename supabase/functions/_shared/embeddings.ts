// Roost: Voyage AI embedding client (Deno copy for Edge Functions).
// Mirror of shared/embeddings.ts. Uses native fetch and reads
// VOYAGE_API_KEY from Deno.env.
//
// API: https://docs.voyageai.com/reference/embeddings-api

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
const MAX_BATCH_SIZE = 128;
const EMBEDDING_DIM = 1024;

export interface EmbedOptions {
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class VoyageError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retriable = false) {
    super(message);
  }
}

function resolveApiKey(opts: EmbedOptions): string | null {
  if (opts.apiKey) return opts.apiKey;
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).process?.env;
  if (env?.VOYAGE_API_KEY) return env.VOYAGE_API_KEY;
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv?.get) {
    const v = denoEnv.get('VOYAGE_API_KEY');
    if (v) return v;
  }
  return null;
}

interface VoyageBatchResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

async function callVoyage(
  texts: string[],
  inputType: 'document' | 'query',
  apiKey: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<VoyageBatchResponse> {
  const maxRetries = 4;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
      signal,
    });
    if (res.ok) return (await res.json()) as VoyageBatchResponse;

    const bodyText = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new VoyageError(
        `Voyage authentication failed (${res.status}). Check VOYAGE_API_KEY. Body: ${bodyText.slice(0, 200)}`,
        res.status,
        false,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      const delay = 500 * 2 ** attempt;
      lastErr = new VoyageError(`Voyage retriable error ${res.status}: ${bodyText.slice(0, 200)}`, res.status, true);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    }
    throw new VoyageError(`Voyage error ${res.status}: ${bodyText.slice(0, 200)}`, res.status, false);
  }
  throw lastErr ?? new VoyageError('Voyage call failed for unknown reason');
}

async function embedBatched(
  texts: string[],
  inputType: 'document' | 'query',
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = resolveApiKey(opts);
  if (!apiKey) throw new VoyageError('VOYAGE_API_KEY is not set.');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const slice = texts.slice(i, i + MAX_BATCH_SIZE);
    const res = await callVoyage(slice, inputType, apiKey, fetchImpl, opts.signal);
    for (const item of res.data) {
      const idx = i + item.index;
      if (item.embedding.length !== EMBEDDING_DIM) {
        throw new VoyageError(`Unexpected embedding dimension ${item.embedding.length}, expected ${EMBEDDING_DIM}`);
      }
      out[idx] = item.embedding;
    }
  }
  return out;
}

export function embedTexts(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  return embedBatched(texts, 'document', opts);
}

export async function embedQuery(query: string, opts: EmbedOptions = {}): Promise<number[]> {
  const arr = await embedBatched([query], 'query', opts);
  if (arr.length === 0 || !arr[0]) throw new VoyageError('Voyage returned no embedding for query.');
  return arr[0];
}

export const EMBEDDINGS_DIM = EMBEDDING_DIM;
export const EMBEDDINGS_MODEL = MODEL;
export const EMBEDDINGS_MAX_BATCH = MAX_BATCH_SIZE;
