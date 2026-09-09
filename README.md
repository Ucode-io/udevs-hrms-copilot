# udevs-hrms-copilot

Conversational copilot for udevs HRMS. Answers questions about HR data and performs
changes, by calling table-agnostic tools against the ucode backend.

Read [CONTEXT.md](./CONTEXT.md) first — it defines the vocabulary this codebase uses.

## How it fits together

```
HRMS admin SPA ──POST /copilot/chat (SSE, caller's Bearer)──▶ this service
                                                                   │
                                       caller's Bearer + companies_id
                                                                   ▼
                                                     api.admin.u-code.io
```

This service owns no database. Conversations and the audit trail are ucode collections
in the HRMS project itself.

## Run locally

```sh
cp .env.example .env    # fill ANTHROPIC_API_KEY + UCODE_SERVICE_API_KEY
npm install
npm run start:dev
```

## Endpoints

| Method | Path | Returns |
|---|---|---|
| POST | `/copilot/chat` | SSE stream of copilot events |
| POST | `/copilot/confirm` | SSE stream (approve/reject a pending action) |
| GET | `/copilot/conversations` | Recent conversations for the caller |
| GET | `/copilot/conversations/:id` | One conversation, replayed |
| GET | `/health` | Liveness |

Every endpoint requires `Authorization: Bearer <ucode token>`.

## One-time setup in ucode

The service stores its own bookkeeping in the HRMS ucode project. Create two
collections in the ucode admin before deploying, then put an API key with write
access to them in `UCODE_SERVICE_API_KEY`.

**`copilot_conversations`**

| field | type | note |
|---|---|---|
| `guid` | UUID | primary key |
| `user_id` | string | who owns the Conversation |
| `companies_id` | string | tenant |
| `title` | string | first message, truncated |
| `thread` | JSON | raw Anthropic messages |
| `pending_action` | JSON | destructive action awaiting confirmation |
| `artifacts` | JSON | charts/tables/links keyed by tool_use id |
| `created_at`, `updated_at` | datetime | |

**`copilot_audit`** (append-only)

| field | type |
|---|---|
| `guid` | UUID |
| `user_id`, `companies_id`, `conversation_id` | string |
| `tool_name`, `risk`, `summary`, `error` | string |
| `input` | JSON (secret-masked) |
| `proposed`, `executed`, `ok` | boolean |
| `created_at` | datetime |

Without `UCODE_SERVICE_API_KEY` the service starts in memory mode: history dies
with the process and nothing is audited. It logs a warning at boot and is only
appropriate for local development.

## Known limits

- **Single replica.** The Claim that stops a double-approved action from running
  twice is in-process (`ConversationStore.claim`). Scaling out needs a shared
  claim first — the ucode item API has no conditional update to build one from.
- **No history replay yet.** `GET /copilot/conversations` lists past
  Conversations, but reopening one does not yet rebuild its messages; the
  `artifacts` and `thread` columns hold everything needed to add it.
- **Filter operators are limited by the backend**, not by choice: `eq`,
  `contains`, `in`, `gt`, `gte`, `lt`, `lte`. There is no not-equals and no
  is-null, and `eq` on a text column is a substring match.
