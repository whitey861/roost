-- Roost: add 'anthropic_server' to tool_handler_type for server-side tools
-- executed by Anthropic (e.g. web_search_20250305). The runtime declares
-- these in the tools array but does not dispatch them; Anthropic returns
-- server_tool_use and *_tool_result blocks inline in the assistant message.
--
-- Idempotent: `ADD VALUE IF NOT EXISTS` is a no-op when the label exists.

alter type tool_handler_type add value if not exists 'anthropic_server';
