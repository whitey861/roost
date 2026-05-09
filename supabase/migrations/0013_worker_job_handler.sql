-- Roost Phase 5: add 'worker_job' to tool_handler_type.
--
-- Tools with handler_type='worker_job' don't run inline in the chat
-- runtime; they insert a row into dev_jobs and return a queued tool
-- result. A separate worker process picks up the job and reports
-- back via dev_job_notifications.
--
-- Idempotent: ADD VALUE IF NOT EXISTS is a no-op when the label exists.

alter type tool_handler_type add value if not exists 'worker_job';
