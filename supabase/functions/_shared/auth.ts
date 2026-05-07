// Edge Function helper: extract and verify a Supabase JWT from a request.
// Returns the user id, or throws an HttpError with an `unauthorized` code.

// @ts-ignore: remote import resolved by Deno at runtime.
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';
import { userClient } from './supabase.ts';
import { HttpError } from './errors.ts';

export interface AuthContext {
  userId: string;
  jwt: string;
  client: SupabaseClient;
}

export async function requireAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'unauthorized', 'Missing bearer token.');
  }
  const jwt = header.slice('bearer '.length).trim();
  const client = userClient(jwt);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired token.');
  }
  return { userId: data.user.id, jwt, client };
}
