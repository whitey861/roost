# Roost dev-agent worker

A small Node.js service that polls `dev_jobs`, leases work atomically, runs
Claude Code headlessly against a target GitHub repo, opens a PR, and posts a
Telegram notification with the PR link.

The worker is part of the larger Roost backend repo. It deploys
independently to DigitalOcean App Platform and shares the Supabase database
with the chat Edge Functions.

## Layout

```
worker/
  src/
    main.ts          worker boot + main loop
    lease.ts         atomic lease, heartbeat, crash recovery
    job-handler.ts   per-job workflow (clone, run Claude, push, PR)
    prompt.ts        prompt template + result parser
    notify.ts        Telegram delivery dispatcher
    exec.ts          child_process wrapper with timeout + log capture
    types.ts         dev_jobs / dev_job_notifications row shapes
    env.ts           env-var helpers
  Dockerfile         node:20-bullseye-slim + git + gh + claude CLIs
  package.json
  tsconfig.json
  .do/app.yaml       DigitalOcean App Platform spec
```

## Lifecycle

1. Boot. Recover any leases left stranded by previous crashes
   (`recoverExpiredLeases`).
2. Loop forever:
   - Reclaim any newly stuck jobs.
   - Try to lease one queued job atomically.
   - If we got one, run a heartbeat keepalive in parallel and execute the job.
   - Run one notification dispatch pass.
   - Sleep `WORKER_POLL_INTERVAL_MS` (default 10000ms).

The lease pattern uses a two-step "select candidate, conditional update"
approach: two workers can race on the candidate, but only one will succeed
in flipping the row's status from `queued` to `running`. The conditional
predicate (`status = 'queued'`) is the contention point.

Heartbeats extend `lease_expires_at` every 60 seconds while the job is
running. If the worker crashes, the lease expires after 5 minutes and the
next iteration picks the job back up.

## Required env

| Var | Source |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `ANTHROPIC_API_KEY` | Anthropic API key (used by Claude Code CLI) |
| `GITHUB_PAT` | Fine-grained PAT scoped to one repo (Contents + PRs read/write) |
| `TELEGRAM_BOT_TOKEN` | Same bot used by the Roost Telegram channel |
| `WORKER_INSTANCE_ID` | Optional. Defaults to `worker-<uuid>` per process |
| `WORKER_POLL_INTERVAL_MS` | Optional. Defaults to 10000 |

## Phase 5 stub jobs

A `task_spec` starting with `__test__:` is treated as a stub: the worker
sleeps for the indicated duration, marks the job completed, and queues a
notification. The shape:

```
__test__: 10s sleep
```

Use this to smoke-test the worker end to end before wiring up Claude Code
or the GitHub PAT.

## Local development

```bash
cd worker
npm install
npm run typecheck
npm test
```

The worker uses ESM. `npm run dev` runs the loop against whatever Supabase
project the env vars point at; for local testing, point at
`supabase start`'s local stack.

## Building and deploying

```bash
docker build -t roost-worker -f worker/Dockerfile .
```

DigitalOcean auto-deploys on push to `main` once the app is created with
`doctl apps create --spec worker/.do/app.yaml`.

## Sandbox notes

- Per-job `/tmp/job-<id>/` directory, deleted on exit (success or failure).
- The worker runs as the non-root `worker` user inside the container.
- Secrets aren't passed to Claude Code child processes beyond
  `ANTHROPIC_API_KEY` and `PATH`. The PAT and Telegram token never reach
  Claude Code's environment.
- The PAT is fine-grained and scoped to a single throwaway repo for the MVP.

Before extending to production repos: add per-job network egress
restrictions, hard FS quotas, and audit logging of every shell command.
