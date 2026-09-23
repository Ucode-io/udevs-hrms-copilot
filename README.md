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

Every endpoint requires `Authorization: Bearer <ucode token>`, and takes an
optional `Project-Id: <uuid>` naming the ucode project to read HRMS data from —
the panel sends its own, and `UCODE_PROJECT_ID` is what a request without one
falls back to. ucode authorizes the header against the caller's token, so it
reaches nothing that token does not already open.

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
| `telegram_chat_id` | string | the bot chat this Conversation is held in, empty for the panel's own. Add it before turning the bot on: without the column ucode drops the filter that looks it up, and every message in Telegram starts a new Conversation that forgets the last one. |
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

## Deploying

Push to `main` and `Ucode-io/ci-cd` builds the image, then rewrites `image.tag`
in `Ucode-io/deployments` at
`clusters/cluster-prod/ucode-prod/udevs-hrms-copilot/values.yaml`. ArgoCD syncs
from there. The folder name must equal this repository's name — `deploy.yml`
derives it from `github.event.repository.name`.

`k8s/values.yaml` and `k8s/config.json` are the two files to copy into that
repository, into that same folder. `config.json` names the Helm chart the
folder is rendered with (`microservice_v2`); every neighbour in `ucode-prod`
carries one, and the sync has nothing to render without it.

### Configuration

Everything except `PORT` comes from Vault, injected as `/app/.env` and read by
`--env-file-if-exists` (see the Dockerfile). One path holds it all:

```sh
vault kv put secret/k8s/ucode-prod/hrms-copilot \
  ANTHROPIC_API_KEY="sk-ant-..." \
  UCODE_SERVICE_API_KEY="..." \
  HRMS_EMPLOYEE_ROLE_ID="52e5168d-660b-4339-9ec4-9c02ae226345" \
  UCODE_BASE_URL="https://api.admin.u-code.io" \
  UCODE_PROJECT_ID="9a462573-ce11-4288-928a-a6ba754b6998" \
  UCODE_ENVIRONMENT_ID="2f73835f-3a29-46c8-951e-75119db9bfc0" \
  CORS_ORIGINS="https://hrms.ucode.co" \
  COPILOT_MODEL="claude-sonnet-5" \
  COPILOT_EFFORT="high"
```

Five of these are worth a second look:

- **`UCODE_SERVICE_API_KEY` must be its own key.** It writes
  `copilot_conversations` and `copilot_audit` under the service's identity
  rather than the caller's — an audit trail its subject can delete is not an
  audit trail. Do not reuse the key the admin panel ships in its bundle, which
  every user of the panel already has.
- **`CORS_ORIGINS` must match the panel's origin exactly** — scheme, host and
  port. A trailing slash is stripped for you, since an `Origin` header never has
  one; anything else wrong and the browser reports a CORS failure that reads as
  the service being down. The panel answers on two hosts, `hrms.ucode.co` and
  `hrms-admin.u-code.io`; whichever one people open has to be listed here.
- **`UCODE_PROJECT_ID` is a fallback, not the project.** The panel sends its own
  in a `Project-Id` header and that wins; this is what a request without one
  gets, which keeps the service deployable ahead of a panel rebuild. It also
  stays the fixed project of `copilot_conversations` and `copilot_audit`, whose
  API key is issued against it — bookkeeping does not follow the caller.
- **`HRMS_EMPLOYEE_ROLE_ID`** is the same id the panel uses as
  `VITE_EMPLOYEE_ROLE_ID`. Without it, every headcount silently counts
  non-employees.
- **Missing keys do not stop the pod.** It starts, passes its health check, and
  answers errors; without the service key it also keeps history in memory, where
  it dies on the next restart. The only sign is one line at boot:
  `No UCODE_SERVICE_API_KEY`.

Check that the `ucode-prod` Vault role's policy grants read on this path before
the first deploy — the pod annotations authenticate as that role, and a policy
that does not cover the new path fails the injection rather than the pod.

## The Telegram bot

The same Copilot, reachable in a private chat with the HRMS bot (`src/telegram`).
A question there runs the same loop, tools and Conversations as one from the
panel — the module only translates between Telegram and the event stream.

What is different, and deliberate:

- **The bot has no HRMS session to borrow, so its HRMS reads go under the
  service API key** (`CallerContext.service`). That removes ucode's per-role
  permission checks on this path: in Telegram an ordinary employee can read
  anything their Company holds, salaries included. Accepted by the product owner
  on 2026-09-16 — a borrowed session expires after a day
  (`AccessTokenExpiresInTime = 1440m`), which would make the bot go blind every
  night. `companies_id` is still derived from the employee record, never
  supplied, so the boundary between companies holds.
- **Private chats only.** An answer in a group is read by everyone in the room,
  and nothing here narrows what an answer may contain. Groups keep getting
  notifications and binding, exactly as before.
- **One Conversation per chat, idle for 12 hours ends it.** A chat has no
  conversation list to pick from; `/new` ends it sooner, `/company` switches
  company and starts a fresh one.
- **Binding still belongs to hickvision.** `/start`, a shared contact and
  anything from a group are forwarded to its `telegram_updates` method
  untouched. Only the transport moved.
- **Replies are HTML, converted from the markdown the model writes** for the
  panel — bold, inline code, bullets, headings (flattened to bold) and links.
  A `kb:<guid>` citation becomes a panel link, or plain text when `HRMS_WEB_URL`
  is unset: Telegram rejects the whole message over one unusable href.
- **One message per answer.** It starts as a progress line that follows the tool
  calls ("Открываю отчёт…") and is rewritten into the answer. Streaming the text
  instead was considered and skipped: the wait is tool calls, not typing, so
  streaming would show nothing until the last seconds and cost hundreds of
  edits against Telegram's rate limit.

Turning it on is four steps, in this order, because the bot has a single update
queue and hickvision polls it today:

1. **deploy hickvision first**, with its `telegram_updates` method but polling
   still on. The webhook forwards binding updates to that method, so it has to
   exist *before* the webhook does — otherwise the window between step 2 and
   step 3 is one where polling is dead and the forward has nothing to call, and
   group binding is simply down;
2. deploy this service with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`;
3. `node dist/telegram/set-webhook.js https://<host>/telegram/webhook` — from
   here on `getUpdates` returns 409 for everyone, permanently;
4. redeploy hickvision with `TELEGRAM_POLLING=0`, which only silences a cron
   that can no longer do anything but log conflicts.

Do not set `TELEGRAM_POLLING=0` in step 1: between then and step 3 polling is
the only thing binding groups.

To roll back, `deleteWebhook` and drop `TELEGRAM_POLLING`; polling resumes on the
next five-minute tick.

## Known limits

- **Single replica.** The Claim that stops a double-approved action from running
  twice is in-process (`ConversationStore.claim`), and so is the "which company?"
  question a bot chat is waiting on (`TelegramService.awaitingCompany`). Scaling
  out needs a shared claim first — the ucode item API has no conditional update
  to build one from.
- **The bot answers text only.** The Copilot reads attachments, but a document
  sent to the bot is refused with a line saying so: pulling a file out of
  Telegram is a second API and a size limit of its own, and nobody has asked.
- **Charts are not drawn in Telegram.** A chart becomes the numbers in the text
  plus a button into the panel. Rendering one means either shipping HR data to
  an image service or a headless browser in the pod.
- **Filter operators are limited by the backend**, not by choice: `eq`,
  `contains`, `in`, `gt`, `gte`, `lt`, `lte`. There is no not-equals and no
  is-null, and `eq` on a text column is a substring match.
