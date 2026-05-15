// Roost: GitHub repo creation handler (Node).
//
// Called from the chat runtime when the agent invokes `create_github_repo`.
// Creates a new repository under the authenticated user (POST /user/repos) or
// under an organization (POST /orgs/{owner}/repos) and returns the minimal
// shape the buildit flow needs to spawn a dev agent against the new repo.
//
// Paired with supabase/functions/_shared/tool-handlers/create-github-repo.ts.
// Keep both copies in sync.

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'roost-agent';

export interface CreateGithubRepoInput {
  name: string;
  description?: string;
  private?: boolean;
  owner?: string;
}

export interface CreateGithubRepoResult {
  full_name: string;
  clone_url: string;
  html_url: string;
}

export interface CreateGithubRepoOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

function resolveToken(opts: CreateGithubRepoOptions): string | null {
  if (opts.token) return opts.token;
  // Node:
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).process?.env;
  if (env?.GITHUB_REPO_CREATE_TOKEN) return env.GITHUB_REPO_CREATE_TOKEN;
  // Deno:
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv?.get) {
    const v = denoEnv.get('GITHUB_REPO_CREATE_TOKEN');
    if (v) return v;
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

interface GithubRepoResponse {
  full_name?: string;
  clone_url?: string;
  html_url?: string;
  message?: string;
  errors?: Array<{ message?: string; code?: string; field?: string }>;
}

interface GithubUserResponse {
  type?: string;
  login?: string;
}

async function ownerIsOrg(
  owner: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/users/${encodeURIComponent(owner)}`, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    // If we can't resolve the owner (404, etc.), fall back to /user/repos so
    // the caller still gets a sensible error from the create attempt.
    return false;
  }
  const data = (await response.json()) as GithubUserResponse;
  return data.type === 'Organization';
}

function formatErrorMessage(status: number, data: GithubRepoResponse | null, raw: string): string {
  const parts: string[] = [`GitHub API error ${status}`];
  if (data?.message) parts.push(data.message);
  const fieldErrors = (data?.errors ?? [])
    .map((e) => [e.field, e.code, e.message].filter(Boolean).join(' '))
    .filter((s) => s.length > 0);
  if (fieldErrors.length > 0) parts.push(fieldErrors.join('; '));
  if (parts.length === 1 && raw) parts.push(raw);
  return parts.join(': ');
}

export async function createGithubRepo(
  input: CreateGithubRepoInput,
  options: CreateGithubRepoOptions = {},
): Promise<CreateGithubRepoResult> {
  if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('create_github_repo: name is required');
  }
  const token = resolveToken(options);
  if (!token) throw new Error('GITHUB_REPO_CREATE_TOKEN is not set');

  const fetchImpl = options.fetchImpl ?? fetch;

  const body: Record<string, unknown> = {
    name: input.name,
    private: input.private ?? true,
  };
  if (typeof input.description === 'string' && input.description.length > 0) {
    body.description = input.description;
  }

  let endpoint = `${GITHUB_API_BASE}/user/repos`;
  if (typeof input.owner === 'string' && input.owner.length > 0) {
    if (await ownerIsOrg(input.owner, token, fetchImpl)) {
      endpoint = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(input.owner)}/repos`;
    }
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let data: GithubRepoResponse | null = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw) as GithubRepoResponse;
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new Error(formatErrorMessage(response.status, data, raw));
  }
  if (!data || typeof data.full_name !== 'string' || typeof data.clone_url !== 'string' || typeof data.html_url !== 'string') {
    throw new Error('GitHub response missing repo fields');
  }

  return {
    full_name: data.full_name,
    clone_url: data.clone_url,
    html_url: data.html_url,
  };
}
