// Shapes the worker reads from / writes to Supabase. Hand-maintained mirror
// of the dev_jobs / dev_job_notifications schema in 0012_dev_jobs.sql.

export type DevJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface DevJob {
  id: string;
  workspace_id: string;
  agent_id: string;
  session_id: string | null;
  user_id: string;

  task_spec: string;
  target_repo: string;
  target_branch: string | null;
  agent_provider: string;
  agent_provider_config: Record<string, unknown>;
  max_iterations: number | null;
  max_cost_usd: number | string | null;
  max_runtime_minutes: number | null;

  status: DevJobStatus;
  leased_by: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;

  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  files_changed: number | null;
  tests_passed: boolean | null;
  tests_summary: string | null;
  cost_usd: number | string | null;
  iterations_used: number | null;
  runtime_seconds: number | null;
  agent_summary: string | null;
  worker_log: string | null;
  error_message: string | null;

  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ClaudeCodeResult {
  prTitle: string;
  prBody: string;
  commitMessage: string;
  filesChanged: number;
  summary: string;
  testCommand: string | null;
  iterations: number;
  cost_usd: number;
}

export interface JobOutcome {
  status: 'completed' | 'failed' | 'timeout';
  branch_name?: string;
  pr_url?: string;
  pr_number?: number | null;
  files_changed?: number;
  tests_passed?: boolean | null;
  tests_summary?: string | null;
  cost_usd?: number;
  iterations_used?: number;
  agent_summary?: string;
  error_message?: string;
}
