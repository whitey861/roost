// Roost: Recraft image-generation handler (Node).
//
// Called from the chat runtime when the agent invokes `generate_image`.
// Returns the public image URL plus credits used and the model name.
// Recraft URLs are HTTPS and publicly reachable for a period after
// generation, so Telegram and web chat can embed them directly without a
// re-upload.
//
// Paired with supabase/functions/_shared/tool-handlers/generate-image.ts.
// Keep both copies in sync.

const RECRAFT_BASE = 'https://external.api.recraft.ai/v1';
const RECRAFT_MODEL = 'recraftv3';
const DEFAULT_STYLE = 'digital_illustration/hand_drawn';
const DEFAULT_SIZE = '1024x1024';

export type RecraftSize =
  | '1024x1024'
  | '1365x1024'
  | '1024x1365'
  | '1536x1024'
  | '1024x1536';

export interface GenerateImageInput {
  prompt: string;
  style_id?: string;
  size?: RecraftSize;
}

export interface GenerateImageResult {
  image_url: string;
  credits_used: number;
  model: string;
}

export interface GenerateImageOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

function resolveApiKey(opts: GenerateImageOptions): string | null {
  if (opts.apiKey) return opts.apiKey;
  // Node:
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).process?.env;
  if (env?.RECRAFT_API_KEY) return env.RECRAFT_API_KEY;
  // Deno:
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv?.get) {
    const v = denoEnv.get('RECRAFT_API_KEY');
    if (v) return v;
  }
  return null;
}

interface RecraftResponse {
  data?: Array<{ url?: string }>;
  meta?: { usage?: { credits_used?: number } };
}

export async function generateImage(
  input: GenerateImageInput,
  options: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  if (!input || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new Error('generate_image: prompt is required');
  }
  const apiKey = resolveApiKey(options);
  if (!apiKey) throw new Error('RECRAFT_API_KEY is not set');

  const body: Record<string, unknown> = {
    prompt: input.prompt,
    model: RECRAFT_MODEL,
    size: input.size ?? DEFAULT_SIZE,
  };
  if (input.style_id) {
    body.style_id = input.style_id;
  } else {
    body.style = DEFAULT_STYLE;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${RECRAFT_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Recraft API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as RecraftResponse;
  const url = data.data?.[0]?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Recraft response missing image URL');
  }

  return {
    image_url: url,
    credits_used: typeof data.meta?.usage?.credits_used === 'number' ? data.meta!.usage!.credits_used! : 0,
    model: RECRAFT_MODEL,
  };
}
