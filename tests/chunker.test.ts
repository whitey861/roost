import { describe, it, expect } from 'vitest';
import { chunkMarkdown, splitSections, estimateTokens } from '../shared/chunker.js';

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('grows with word count', () => {
    expect(estimateTokens('one two three four five')).toBeGreaterThan(0);
    expect(estimateTokens('one two three four five six seven eight nine ten')).toBeGreaterThan(estimateTokens('one two'));
  });
});

describe('splitSections', () => {
  it('splits on ## headers and drops # title', () => {
    const md = `# Doc Title

Intro paragraph.

## Section A

A1 content.

## Section B

B1 content.
`;
    const sections = splitSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0]?.title).toBeNull();
    expect(sections[0]?.body).toContain('Intro paragraph');
    expect(sections[1]?.title).toBe('Section A');
    expect(sections[2]?.title).toBe('Section B');
  });
});

describe('chunkMarkdown', () => {
  it('produces non-empty chunks for a 3-section doc', () => {
    const para = (n: number) => Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + ` paragraph ${n}.`;
    const md = `# Title

## AI Strategy

${para(1)}

${para(2)}

${para(3)}

## Beacon platform overview

${para(4)}

${para(5)}

## Contractor management

${para(6)}
`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(c.tokens).toBeGreaterThan(0);
    }
  });

  it('prefixes chunk content with the section title', () => {
    const md = `## AI Strategy

Some content about strategy.
`;
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.content.startsWith('[Section: AI Strategy]')).toBe(true);
    expect(chunks[0]?.metadata.section_title).toBe('AI Strategy');
    expect(chunks[0]?.metadata.has_section).toBe(true);
  });

  it('overlap is non-zero between adjacent chunks within the same section', () => {
    const lots = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(30)}`).join('\n\n');
    const md = `## Big Section\n\n${lots}\n`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap detection: at least one trailing word from chunk[0] should appear at the start of chunk[1].
    const a = chunks[0]!.content;
    const b = chunks[1]!.content;
    const aWords = a.split(/\s+/).slice(-15);
    const bStart = b.split(/\s+/).slice(0, 30).join(' ');
    const overlapHits = aWords.filter((w) => bStart.includes(w));
    expect(overlapHits.length).toBeGreaterThan(2);
  });

  it('does not bleed overlap across section boundaries', () => {
    const md = `## Section A

Content A only paragraph one. Apple banana cherry.

## Section B

Content B only paragraph one. Mango orange peach.
`;
    const chunks = chunkMarkdown(md);
    const aChunks = chunks.filter((c) => c.metadata.section_title === 'Section A');
    const bChunks = chunks.filter((c) => c.metadata.section_title === 'Section B');
    for (const c of aChunks) expect(c.content).not.toContain('Mango');
    for (const c of bChunks) expect(c.content).not.toContain('Apple');
  });

  it('handles documents with no headers', () => {
    const md = Array.from({ length: 5 }, () => 'sentence here.').join(' ') + '\n';
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.metadata.has_section).toBe(false);
      expect(c.content.startsWith('[Section:')).toBe(false);
    }
  });
});
