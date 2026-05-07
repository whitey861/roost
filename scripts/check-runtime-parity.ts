#!/usr/bin/env tsx
// Roost: runtime parity check.
// Confirms the canonical sections of both chat-runtime files are
// byte-equivalent (modulo comments and whitespace). Fails CI if they drift.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const FILES = [
  'shared/chat-runtime.ts',
  'supabase/functions/_shared/chat-runtime.ts',
];

export const START_MARKER = '// SHARED_RUNTIME_START';
export const END_MARKER = '// SHARED_RUNTIME_END';

export function extractCanonical(filePath: string): string {
  const content = readFileSync(resolve(filePath), 'utf-8');
  return extractCanonicalFromString(content, filePath);
}

export function extractCanonicalFromString(content: string, label = '<input>'): string {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `${label} is missing parity markers (${START_MARKER} / ${END_MARKER})`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`${label} has markers in the wrong order`);
  }

  let section = content.slice(startIdx + START_MARKER.length, endIdx);

  // Strip block comments.
  section = section.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments.
  section = section.replace(/\/\/.*$/gm, '');
  // Normalise whitespace.
  section = section.replace(/\s+/g, ' ').trim();

  return section;
}

export function hashSection(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function main(): void {
  const sections = FILES.map((f) => {
    const content = extractCanonical(f);
    return { file: f, content, hash: hashSection(content) };
  });

  console.log('Runtime parity check:');
  for (const s of sections) {
    console.log(`  ${s.hash}  ${s.file}`);
  }

  const uniqueHashes = new Set(sections.map((s) => s.hash));
  if (uniqueHashes.size > 1) {
    console.error('');
    console.error('FAIL: Runtime files have diverged.');
    console.error(
      `Both chat-runtime.ts files must contain identical logic between ${START_MARKER} and ${END_MARKER} markers (modulo comments and whitespace).`,
    );
    console.error(
      'If this divergence is intentional, update both files to match.',
    );
    process.exit(1);
  }

  console.log('');
  console.log('OK: All runtime files in sync.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
