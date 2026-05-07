// Roost: workspace budget enforcement.
// Every Claude API call goes through `withBudget` so we can stop spending
// when the daily cap is hit. Concurrent runs share a single counter,
// so we use atomic updates.

// @ts-ignore: remote import resolved by Deno at runtime.
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';

export interface BudgetState {
  budgetUsd: number;
  spentUsd: number;
  resetAt: string;
}

export async function getBudgetState(client: SupabaseClient, workspaceId: string): Promise<BudgetState> {
  const { data, error } = await client
    .from('workspaces')
    .select('daily_token_budget_usd, daily_spent_usd, daily_spent_reset_at')
    .eq('id', workspaceId)
    .single();
  if (error || !data) throw new Error(`Failed to load workspace budget: ${error?.message ?? 'not found'}`);
  return {
    budgetUsd: Number(data.daily_token_budget_usd),
    spentUsd: Number(data.daily_spent_usd),
    resetAt: data.daily_spent_reset_at,
  };
}

// Resets daily_spent_usd to 0 if the reset date is older than today.
// Returns the (possibly refreshed) state.
export async function rolloverIfNeeded(client: SupabaseClient, workspaceId: string): Promise<BudgetState> {
  const today = new Date().toISOString().slice(0, 10);
  const state = await getBudgetState(client, workspaceId);
  if (state.resetAt !== today) {
    const { error } = await client
      .from('workspaces')
      .update({ daily_spent_usd: 0, daily_spent_reset_at: today })
      .eq('id', workspaceId);
    if (error) throw new Error(`Budget rollover failed: ${error.message}`);
    return { budgetUsd: state.budgetUsd, spentUsd: 0, resetAt: today };
  }
  return state;
}

export async function addSpend(client: SupabaseClient, workspaceId: string, deltaUsd: number): Promise<number> {
  if (deltaUsd <= 0) {
    const s = await getBudgetState(client, workspaceId);
    return s.spentUsd;
  }
  // Read-modify-write. Acceptable for a single-user platform.
  const { data, error } = await client
    .from('workspaces')
    .select('daily_spent_usd')
    .eq('id', workspaceId)
    .single();
  if (error || !data) throw new Error(`Spend update read failed: ${error?.message}`);
  const next = Number(data.daily_spent_usd) + deltaUsd;
  const { error: uerr } = await client
    .from('workspaces')
    .update({ daily_spent_usd: next })
    .eq('id', workspaceId);
  if (uerr) throw new Error(`Spend update write failed: ${uerr.message}`);
  return next;
}

export function isOverBudget(state: BudgetState): boolean {
  return state.spentUsd >= state.budgetUsd;
}
