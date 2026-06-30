# LLM Trace Database and Admin UI Plan

## Goal

Replace the current optional markdown-only LLM trace mechanism with database-backed trace storage in the user SQLite database. Add an admin-only `/trace` page and `/api/trace` endpoints to inspect trace sessions.

The new trace model should preserve the same conceptual granularity as the old markdown files: one complete LLM conversation per trace session, including system/user prompts, assistant responses, tool calls, tool results, injected budget info, reasoning, and final reply.

## Constraints

- Store trace data in `users.sqlite`.
- Add three new tables: `trace_sessions`, `client_sent`, and `client_received`.
- Do not associate trace sessions with `parse_records`; traces are debugging data only.
- Keep only traces from the last 30 days.
- The trace UI is admin-only and can be simple.
- Left trace list does not need pagination for now; use a simple reverse chronological scroll list.
- Detail data should load only after clicking a left-side item.
- Image content must not be stored as base64. Store only minimal placeholders such as `[image]`.
- Reasoning content must be stored.
- Only store final assistant messages, not streaming chunks.
- Store incomplete and failed traces when possible.

## Existing Code Facts

- Current markdown logger is `server/src/services/logger.ts`.
- Current log directory is runtime output at `server/src/log`.
- `CHAT_LOG` is configured in `server/src/config/env.ts` and defaults to disabled.
- Current logger calls are scattered at the end of public agent methods, for example `MainAgent.parse`, `ChatAgent.chat`, `ImageParseAgent.parse`, `LayoutAgent.parse`, and sub-agent methods.
- The best common instrumentation point is `server/src/agents/base.ts`, especially `BaseAgent.run()`.
- User database setup is in `server/src/db/users.ts` via `CREATE TABLE IF NOT EXISTS` statements during startup.
- Admin-only API pattern already exists in `server/src/routes/debug.ts` with `requireAdmin`.
- Admin-only frontend route pattern already exists in `client/src/App.tsx` with `AdminGuard`.
- `/history` provides the desired left/right UI pattern in `client/src/pages/HistoryPage.tsx` and `HistoryPage.css`.
- Frontend already has `react-markdown` and `remark-gfm`; no markdown-rendering dependency is needed.

## Trace Concepts

### Session Granularity

One `trace_sessions` row corresponds to one complete LLM conversation at the same granularity as a previous markdown log file.

Examples:

- A top-level `MainAgent` run started by `/api/table-parse` is one session.
- A `BatchSearchAgent` invoked as a dispatch tool by `MainAgent` is another session.
- A `ChatAgent` run started by `/api/chat` is one session.
- An `ImageParseAgent` run started by `/api/image-parse` is one session.
- A `LayoutAgent` run started by `/api/layout/parse-image` is one session.

### Parent Relationship

Only `parent_tool_call_id` is needed to connect a sub-agent session back to the parent conversation. For example, when `MainAgent` calls `dispatchBatchSearch`, the created `BatchSearchAgent` session stores the dispatch call ID in `parent_tool_call_id`.

No separate tree table is needed.

### Main Agent vs Actual Agent

- `main_agent`: top-level entry agent or product feature context, such as `MainAgent`, `ChatAgent`, `ImageParseAgent`, or `LayoutAgent`.
- `agent_name`: actual agent class for this session, such as `BatchSearchAgent` or `PreciseSearchAgent`.

For top-level sessions, `main_agent` and `agent_name` can be the same.

For sub-agent sessions, `main_agent` remains the original top-level agent, while `agent_name` becomes the sub-agent class.

## Database Schema

### `trace_sessions`

Purpose: store one row per full conversation/session and provide efficient list/detail lookup, cleanup, status tracking, and parent linkage.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Internal database key. |
| `conversation_id` | `TEXT NOT NULL UNIQUE` | Stable public session ID for one conversation. |
| `user_id` | `INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE` | User who triggered this trace. |
| `username` | `TEXT NOT NULL` | Username snapshot for easy admin display. |
| `main_agent` | `TEXT NOT NULL` | Top-level agent context. |
| `agent_name` | `TEXT NOT NULL` | Actual agent class for this session. |
| `parent_tool_call_id` | `TEXT` | Tool call ID that created this sub-agent session, if any. |
| `route` | `TEXT` | API route that started the top-level request, for example `/api/table-parse`. |
| `provider` | `TEXT` | Provider name, for example `deepseek` or `openrouter`. |
| `model` | `TEXT` | Model name. |
| `status` | `TEXT NOT NULL DEFAULT 'running'` | `running`, `completed`, or `error`. |
| `error` | `TEXT` | Session-level error summary, if any. |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | Session start time. |
| `completed_at` | `TEXT` | Session completion or failure time. |

Indexes:

- `idx_trace_sessions_created_at` on `created_at DESC`.
- `idx_trace_sessions_user_created` on `(user_id, created_at DESC)`.
- `idx_trace_sessions_parent_tool_call` on `parent_tool_call_id`.
- `idx_trace_sessions_conversation_id` on `conversation_id`.

### `client_sent`

Purpose: store structured messages and tool/schema data that the client sends to the LLM, or that is sent back to the LLM as tool output.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Internal key. |
| `conversation_id` | `TEXT NOT NULL REFERENCES trace_sessions(conversation_id) ON DELETE CASCADE` | Session ID. |
| `message_index` | `INTEGER NOT NULL` | Message order within this conversation, matching markdown-style sequence. |
| `role` | `TEXT NOT NULL` | `system`, `user`, `tool`, or `tool_schema`. |
| `name` | `TEXT` | Tool name or schema name. |
| `tool_call_id` | `TEXT` | Tool result call ID. |
| `parent_tool_call_id` | `TEXT` | Optional duplicate for easier filtering/debugging. |
| `content_text` | `TEXT` | Text or markdown content. |
| `content_json` | `TEXT` | JSON payload as string when content is naturally JSON. |
| `content_format` | `TEXT NOT NULL DEFAULT 'text'` | `text`, `markdown`, `json`, or `multimodal_placeholder`. |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | Creation/start time. |
| `completed_at` | `TEXT` | Completion time for tool results when available. |
| `error` | `TEXT` | Tool execution or serialization error. |

Indexes:

- `idx_client_sent_conversation` on `(conversation_id, message_index, id)`.
- `idx_client_sent_tool_call` on `tool_call_id`.

### `client_received`

Purpose: store final assistant messages returned by the LLM, including reply, reasoning, tool calls, injected budget info, and errors.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Internal key. |
| `conversation_id` | `TEXT NOT NULL REFERENCES trace_sessions(conversation_id) ON DELETE CASCADE` | Session ID. |
| `message_index` | `INTEGER NOT NULL` | Assistant message order within this conversation. |
| `finish_reason` | `TEXT` | `stop`, `tool_calls`, `length`, `content_filter`, etc. |
| `reply` | `TEXT` | Assistant content. |
| `reasoning` | `TEXT` | Reasoning content. |
| `tool_calls_json` | `TEXT` | JSON string of tool call array. |
| `tool_call_ids_json` | `TEXT` | JSON string of extracted tool call IDs. |
| `source` | `TEXT NOT NULL DEFAULT 'llm'` | `llm` or `injected`. `_budget_info` uses `injected`. |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | LLM call start or injected message creation time. |
| `completed_at` | `TEXT` | Final assistant message completion time. |
| `error` | `TEXT` | LLM call failure or serialization error. |

Indexes:

- `idx_client_received_conversation` on `(conversation_id, message_index, id)`.
- `idx_client_received_created` on `created_at DESC`.

## Cleanup Policy

Keep only trace sessions from the last 30 days.

Implementation options:

- Run cleanup once during startup after user DB initialization.
- Also optionally run cleanup opportunistically when creating a new trace session.

Cleanup SQL should delete from `trace_sessions` where `created_at < datetime('now', '-30 days')`. Because `client_sent` and `client_received` reference `trace_sessions(conversation_id) ON DELETE CASCADE`, child rows should be deleted automatically.

## Trace Context Propagation

Create a trace context object passed into agents.

Suggested fields:

| Field | Purpose |
| --- | --- |
| `conversationId` | Current session ID. |
| `userId` | Triggering user. |
| `username` | Username snapshot. |
| `mainAgent` | Top-level agent. |
| `agentName` | Actual agent. |
| `parentToolCallId` | Parent dispatch tool call ID, if any. |
| `route` | Top-level API route. |
| `provider` | Provider name. |
| `model` | Model name. |
| `enabled` | Allows tracing to be on by default or toggled later. |

Top-level routes create a root trace context before calling the agent. Sub-agent creation copies the root fields, changes `conversationId` and `agentName`, and sets `parentToolCallId` to the dispatch call ID.

## Instrumentation Plan

### Top-Level Routes

Affected routes:

- `server/src/routes/tableParse.ts`
- `server/src/routes/chat.ts`
- `server/src/routes/imageParse.ts`
- `server/src/routes/layoutParseImage.ts`

Each route should:

1. Create a new `conversation_id` before the agent run.
2. Insert a `trace_sessions` row with `status = 'running'`.
3. Pass trace context to the agent.
4. Mark session `completed` on success.
5. Mark session `error` on failure, preserving the error message.

### BaseAgent

Primary instrumentation point: `BaseAgent.run()`.

Responsibilities:

1. Record initial `system` and `user` messages as `client_sent` rows.
2. Replace multimodal images with `[image]` placeholders before persistence.
3. Record available tool schemas as `client_sent` rows with `role = 'tool_schema'`, preferably once per conversation or once when they change.
4. Before each LLM call, remember call start time.
5. After the final assistant message is assembled, insert one `client_received` row containing reply, reasoning, finish reason, and tool calls.
6. Do not store stream chunks.
7. When a real tool result is produced, insert one `client_sent` row with `role = 'tool'`, `tool_call_id`, tool name, content, and completion time.
8. On tool failure, insert a `client_sent` row with `error`.
9. On LLM failure, insert a `client_received` row with `error` and update the session status to `error`.
10. Preserve incomplete traces whenever possible.

### `_budget_info`

Current behavior injects a virtual assistant/tool pair after tool execution.

Storage behavior:

- Store the virtual assistant tool call in `client_received` with `source = 'injected'`.
- Store the virtual tool result in `client_sent` with `role = 'tool'` and name `_budget_info`.
- In UI grouping, attach `_budget_info` to the previous real assistant/tool group by sequence, not by needing a separate relationship table.

### Sub-Agent Dispatch

Affected code is in `MainAgent.executeTool()` for dispatch tools:

- `dispatchBatchSearch`
- `dispatchPreciseSearch`
- `dispatchGlassDoorCalc`

When constructing each sub-agent:

1. Create a new `conversation_id`.
2. Insert a new `trace_sessions` row.
3. Copy `user_id`, `username`, `main_agent`, `route`, `provider`, and `model` from parent context.
4. Set `agent_name` to the sub-agent class.
5. Set `parent_tool_call_id` to the dispatch tool call ID.

## API Plan

Add `server/src/routes/trace.ts`.

All routes must use `requireAdmin`.

### `GET /api/trace`

Returns trace session summaries from the last 30 days, ordered by `created_at DESC`.

Response fields:

- `conversation_id`
- `username`
- `user_id`
- `main_agent`
- `agent_name`
- `parent_tool_call_id`
- `route`
- `provider`
- `model`
- `status`
- `error`
- `created_at`
- `completed_at`

No pagination initially.

### `GET /api/trace/:conversationId`

Returns one session plus all sent/received rows ordered by message index and ID.

Response shape:

```json
{
  "session": {},
  "sent": [],
  "received": []
}
```

The frontend will perform grouping.

## Frontend Plan

Add a new admin-only `/trace` page.

Files likely needed:

- `client/src/pages/TracePage.tsx`
- `client/src/pages/TracePage.css`
- Update `client/src/App.tsx` to register `/trace` under `AdminGuard`.
- Add trace types to `client/src/types.ts` or local page types.

### Layout

Follow `/history` left/right structure:

- Header with title and button back to home.
- Left panel: reverse chronological trace session list.
- Right panel: selected trace details.

### Left List

Each item shows:

- Timestamp as primary label.
- Username.
- Main agent / actual agent.
- Status.
- Parent marker if `parent_tool_call_id` exists.

### Right Detail Header

Show:

- User ID and username.
- Main agent.
- Actual agent.
- Parent tool call ID if present.
- Route.
- Provider/model.
- Created/completed time.
- Status/error.

### Message Rendering

Render a markdown-like outline using collapsible sections:

- Level 2: each message block, similar to `## 3. assistant message`.
- Level 3: assistant subsections such as `reply`, `reasoning`, `tool_call`, and attached `tool` results.
- Assistant messages followed by tool messages should display those tool messages as children of the assistant.
- `_budget_info` should display under the previous real assistant/tool group.

### JSON Formatter

Implement a small recursive JSON viewer using native `<details>`.

Requirements:

- Objects and arrays can collapse.
- Primitive values render inline.
- Invalid JSON falls back to raw text.
- No new dependency required.

### Markdown Viewer

For markdown content:

- Provide a toggle between raw source and rendered view.
- Rendered view uses existing `ReactMarkdown` and `remarkGfm`.

## UI Grouping Algorithm

Input: sorted `sent` and `received` arrays.

Suggested approach:

1. Treat `system` and `user` rows from `client_sent` as top-level sent messages.
2. Treat each `client_received` row as an assistant top-level message.
3. Match real tool result rows from `client_sent` where `role = 'tool'` to the nearest preceding assistant whose `tool_call_ids_json` contains `tool_call_id`.
4. For `_budget_info`, attach by sequence to the previous real assistant/tool group.
5. Tool schemas can be shown in a compact collapsible section near the top, or hidden behind a `Tool schemas` section.

## Migration and Backward Compatibility

No separate migration framework exists. Add `CREATE TABLE IF NOT EXISTS` and index creation to `initUserDB()`.

Existing users and records should be unaffected.

The old markdown logs do not need to be imported.

After the DB trace is implemented, old `writeChatLog` usage can be removed or left unused behind `CHAT_LOG`. Prefer removing scattered markdown writes once DB trace is verified, to avoid duplicated debugging systems.

## Verification Plan

Backend checks:

1. Run TypeScript build for server.
2. Start app locally.
3. Trigger `/api/table-parse` as a normal user.
4. Confirm `trace_sessions` has one top-level `MainAgent` session and sub-agent sessions with `parent_tool_call_id`.
5. Confirm `client_sent` includes system/user/tool rows but no base64 images.
6. Confirm `client_received` includes reply, reasoning, finish reason, and tool calls.
7. Force or simulate a tool/LLM error and confirm partial trace is retained.
8. Confirm cleanup removes records older than 30 days.

Frontend checks:

1. Run client build.
2. Confirm non-admin users cannot access `/trace`.
3. Confirm admin users can open `/trace`.
4. Confirm left list loads without loading details for every row.
5. Confirm clicking one row loads and renders only that detail.
6. Confirm JSON blocks collapse and expand.
7. Confirm markdown raw/rendered toggle works.
8. Confirm tool messages are nested under the appropriate assistant message.
9. Confirm `_budget_info` appears under the previous real tool/assistant group.

## Open Implementation Decisions

- Whether to keep a global trace toggle similar to `CHAT_LOG` or always record traces. The current requirement implies always recording for admin debugging, with 30-day retention.
- Whether tool schemas should be recorded once per conversation or each round. To minimize redundancy while preserving useful debug info, record once per conversation unless available tools change due to budget filtering.
- Whether `provider` should be added explicitly to `LlmProvider` or supplied by the provider factory into trace context. The minimal approach is to pass provider name from the route/factory call site.
