// Deterministic 1024-dim query embedder used by chat-runtime tests so
// they don't need a fetch stub or a real VOYAGE_API_KEY. Returns the same
// vector regardless of input.

import { EMBEDDINGS_DIM } from '../../shared/embeddings.js';
import type { QueryEmbedder } from '../../shared/retrieval.js';

const FAKE_VEC: number[] = Array.from({ length: EMBEDDINGS_DIM }, () => 0.001);

export const fakeQueryEmbedder: QueryEmbedder = async () => FAKE_VEC;
