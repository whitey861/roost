import { describe, it, expect } from 'vitest';
import { embedTexts, embedQuery, VoyageError, EMBEDDINGS_DIM, EMBEDDINGS_MAX_BATCH } from '../shared/embeddings.js';

interface Call {
  url: string;
  body: { input: string[]; input_type: 'document' | 'query'; model: string };
}

function fakeFetch(opts: { responses: Array<Response | (() => Response)> }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const body = JSON.parse(String(init?.body ?? '{}')) as Call['body'];
    calls.push({ url: u, body });
    const next = opts.responses[i++];
    if (!next) throw new Error('no response scripted');
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function vecResp(count: number): Response {
  const data = Array.from({ length: count }, (_, idx) => ({
    embedding: Array.from({ length: EMBEDDINGS_DIM }, () => 0.01),
    index: idx,
  }));
  return new Response(JSON.stringify({ data, usage: { total_tokens: 10 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('embedTexts', () => {
  it('embeds a single batch and returns one vector per text', async () => {
    const { fetchImpl, calls } = fakeFetch({ responses: [vecResp(3)] });
    const out = await embedTexts(['a', 'b', 'c'], { apiKey: 'k', fetchImpl });
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(EMBEDDINGS_DIM);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.input).toEqual(['a', 'b', 'c']);
    expect(calls[0]?.body.input_type).toBe('document');
  });

  it('batches at 128 per request', async () => {
    const total = 200;
    const texts = Array.from({ length: total }, (_, i) => `t${i}`);
    const { fetchImpl, calls } = fakeFetch({ responses: [vecResp(EMBEDDINGS_MAX_BATCH), vecResp(total - EMBEDDINGS_MAX_BATCH)] });
    const out = await embedTexts(texts, { apiKey: 'k', fetchImpl });
    expect(out).toHaveLength(total);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.input.length).toBe(EMBEDDINGS_MAX_BATCH);
    expect(calls[1]?.body.input.length).toBe(total - EMBEDDINGS_MAX_BATCH);
  });

  it('retries on 429', async () => {
    const { fetchImpl, calls } = fakeFetch({
      responses: [
        new Response('rate limited', { status: 429 }),
        vecResp(1),
      ],
    });
    const out = await embedTexts(['a'], { apiKey: 'k', fetchImpl });
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(2);
  }, 10000);

  it('throws clearly on auth failure with no retry', async () => {
    const { fetchImpl, calls } = fakeFetch({
      responses: [new Response('forbidden', { status: 401 })],
    });
    await expect(embedTexts(['a'], { apiKey: 'bad', fetchImpl })).rejects.toThrow(VoyageError);
    expect(calls).toHaveLength(1);
  });

  it('throws when VOYAGE_API_KEY is unavailable and no key is passed', async () => {
    const old = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      await expect(embedTexts(['a'])).rejects.toThrow(/VOYAGE_API_KEY/);
    } finally {
      if (old !== undefined) process.env.VOYAGE_API_KEY = old;
    }
  });
});

describe('embedQuery', () => {
  it('uses input_type: "query"', async () => {
    const { fetchImpl, calls } = fakeFetch({ responses: [vecResp(1)] });
    const v = await embedQuery('hello', { apiKey: 'k', fetchImpl });
    expect(v).toHaveLength(EMBEDDINGS_DIM);
    expect(calls[0]?.body.input_type).toBe('query');
  });
});
