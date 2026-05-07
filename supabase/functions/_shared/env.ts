// Edge Function helper: read environment variables in Deno.
// In tests we polyfill Deno.env via globalThis so this still works.

interface DenoLike {
  env: { get: (k: string) => string | undefined };
}

function getDeno(): DenoLike | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  return g.Deno;
}

export function env(key: string): string {
  const d = getDeno();
  const v = d?.env.get(key);
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export function envOptional(key: string): string | undefined {
  return getDeno()?.env.get(key);
}
