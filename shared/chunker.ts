// Roost: markdown-aware chunker.
//
// Splits a markdown document into ~600-token chunks with ~50-token
// overlap. Preserves section context (## headers) by prefixing
// chunks with `[Section: <title>] ...`. Pure: no I/O, no env access.

const TARGET_CHUNK_TOKENS = 600;
const CHUNK_OVERLAP_TOKENS = 50;
const TOKENS_PER_WORD = 1.3;

export interface Chunk {
  content: string;
  tokens: number;
  metadata: {
    section_title?: string;
    section_index?: number;
    has_section?: boolean;
  };
}

// Cheap tokenizer estimate. Avoids pulling in tiktoken just for ingestion.
// Empirically ~1.3 tokens per word in English markdown. Good enough for
// chunk-size budgeting; Voyage also returns exact token usage on the
// embeddings response if we ever need precise numbers.
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length * TOKENS_PER_WORD);
}

interface Section {
  title: string | null;
  body: string;
}

// Split a markdown document into sections by ## headers.
// `#` is treated as the doc title and ignored at this level.
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let current: Section = { title: null, body: '' };

  const push = (): void => {
    if (current.body.trim().length > 0 || current.title) {
      sections.push({ title: current.title, body: current.body.trim() });
    }
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      push();
      current = { title: m[1] ?? null, body: '' };
      continue;
    }
    // Skip the document-level # title from the body.
    if (/^#\s+/.test(line)) continue;
    current.body += line + '\n';
  }
  push();

  return sections;
}

interface ParaSpan {
  text: string;
  tokens: number;
}

function splitParagraphs(body: string): ParaSpan[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((text) => ({ text, tokens: estimateTokens(text) }));
}

function chunksFromParas(
  paras: ParaSpan[],
  prefix: string,
  baseMeta: Chunk['metadata'],
): Chunk[] {
  if (paras.length === 0) return [];
  const out: Chunk[] = [];
  let current = '';
  let currentTokens = 0;

  const flush = (): void => {
    if (current.trim().length === 0) return;
    const content = prefix ? `${prefix}${current.trim()}` : current.trim();
    out.push({ content, tokens: estimateTokens(content), metadata: { ...baseMeta } });
  };

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;

    if (p.tokens > TARGET_CHUNK_TOKENS) {
      // Paragraph alone exceeds budget. Hard-split by words.
      flush();
      current = '';
      currentTokens = 0;
      const words = p.text.split(/\s+/);
      const wordsPerChunk = Math.max(1, Math.floor(TARGET_CHUNK_TOKENS / TOKENS_PER_WORD));
      const wordOverlap = Math.max(0, Math.floor(CHUNK_OVERLAP_TOKENS / TOKENS_PER_WORD));
      let start = 0;
      while (start < words.length) {
        const slice = words.slice(start, start + wordsPerChunk).join(' ');
        const content = prefix ? `${prefix}${slice.trim()}` : slice.trim();
        out.push({ content, tokens: estimateTokens(content), metadata: { ...baseMeta } });
        if (start + wordsPerChunk >= words.length) break;
        start += wordsPerChunk - wordOverlap;
      }
      continue;
    }

    if (currentTokens + p.tokens > TARGET_CHUNK_TOKENS && currentTokens > 0) {
      flush();
      // Build overlap from the tail of the just-flushed chunk.
      const overlap = takeTailWords(current.trim(), CHUNK_OVERLAP_TOKENS);
      current = overlap.length > 0 ? overlap + '\n\n' : '';
      currentTokens = estimateTokens(current);
    }

    current += (current.length > 0 ? '\n\n' : '') + p.text;
    currentTokens = estimateTokens(current);
  }

  flush();
  return out;
}

function takeTailWords(text: string, targetTokens: number): string {
  if (targetTokens <= 0) return '';
  const words = text.split(/\s+/);
  const targetWords = Math.max(1, Math.floor(targetTokens / TOKENS_PER_WORD));
  if (words.length <= targetWords) return text;
  return words.slice(words.length - targetWords).join(' ');
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const sections = splitSections(markdown);
  const chunks: Chunk[] = [];
  let sectionIndex = 0;
  let anySection = false;

  for (const section of sections) {
    const paras = splitParagraphs(section.body);
    if (paras.length === 0) continue;

    if (section.title) {
      anySection = true;
      const prefix = `[Section: ${section.title}] `;
      const built = chunksFromParas(paras, prefix, {
        section_title: section.title,
        section_index: sectionIndex,
        has_section: true,
      });
      chunks.push(...built);
      sectionIndex += 1;
    } else {
      const built = chunksFromParas(paras, '', { has_section: false });
      chunks.push(...built);
    }
  }

  if (!anySection && chunks.length === 0 && markdown.trim().length > 0) {
    // Document with no headers and no paragraph breaks. Treat as one
    // long body and run through the same word-splitter.
    return chunksFromParas([{ text: markdown.trim(), tokens: estimateTokens(markdown) }], '', { has_section: false });
  }

  return chunks;
}

export const CHUNK_TARGET_TOKENS = TARGET_CHUNK_TOKENS;
export const CHUNK_OVERLAP = CHUNK_OVERLAP_TOKENS;
