import { randomUUID } from "crypto";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { UcodeClient } from "../ucode/ucode.client";
import { compactAttachments } from "./attachment";
import type { CallerContext } from "../ucode/ucode.types";
import type { CopilotArtifactBundle, CopilotPendingAction } from "./tools/tool.types";

export const CONVERSATIONS_TABLE = "copilot_conversations";
export const AUDIT_TABLE = "copilot_audit";

/** How many recent Conversations the history list surfaces per person. */
const HISTORY_LIMIT = 10;

export interface Conversation {
  id: string;
  userId: string;
  companiesId: string;
  /**
   * The Telegram chat this Conversation is being held in, or null for the ones
   * the browser opened.
   *
   * Telegram has no list of conversations to pick from — a chat is one endless
   * ribbon — so the chat id is what stands in for "the Conversation I am in",
   * and the
   * Company the person picked with a button rides along on `companiesId`.
   */
  telegramChatId: string | null;
  title: string | null;
  /** The Thread: raw Anthropic messages, the source of truth for a replay. */
  thread: Anthropic.MessageParam[];
  pendingAction: CopilotPendingAction | null;
  /** Artifacts keyed by tool_use id, deliberately kept outside the Thread. */
  artifacts: Record<string, CopilotArtifactBundle>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  conversationId: string;
  toolName: string;
  risk: string;
  input: Record<string, unknown>;
  proposed: boolean;
  executed: boolean;
  ok: boolean;
  summary: string | null;
  error: string | null;
}

/**
 * Where Conversations live.
 *
 * The Copilot has no database of its own: HRMS is already a ucode project, so
 * its own bookkeeping goes in two collections there. Writes use the service key
 * rather than the Caller's token — an audit trail a person can delete is not an
 * audit trail.
 *
 * `memory` mode exists because those collections have to be created in the ucode
 * admin before this service can persist anything, and a developer should be able
 * to run the Copilot before that happens. It is a deliberate, logged choice
 * rather than a silent fallback: in memory mode history dies with the process
 * and nothing is audited, which is fine locally and never fine in production.
 */
@Injectable()
export class ConversationStore {
  private readonly logger = new Logger(ConversationStore.name);
  private readonly memory = new Map<string, Conversation>();
  private readonly mode: "ucode" | "memory";

  /**
   * Pending actions already handed to an executor, by actionId.
   *
   * ponytail: in-process Claim. It makes a double-clicked approval run once on
   * one instance, which is why the deployment is pinned to a single replica.
   * Scaling out needs a shared claim (Redis SETNX on the actionId) first — the
   * ucode item API has no conditional update to build one from.
   */
  private readonly claimed = new Set<string>();

  constructor(
    private readonly ucode: UcodeClient,
    @Inject(CONFIG) config: CopilotConfig,
  ) {
    this.mode = config.ucode.serviceApiKey ? "ucode" : "memory";
    if (this.mode === "memory") {
      this.logger.warn(
        "No UCODE_SERVICE_API_KEY: conversations are kept in memory and nothing is audited. Do not run production like this.",
      );
    }
  }

  async create(
    caller: CallerContext,
    firstMessage: string,
    telegramChatId: string | null = null,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      userId: caller.userId,
      companiesId: caller.companiesId,
      telegramChatId,
      title: firstMessage.slice(0, 80),
      thread: [],
      pendingAction: null,
      artifacts: {},
      createdAt: now,
      updatedAt: now,
    };

    if (this.mode === "ucode") {
      await this.write("POST", `/v2/items/${CONVERSATIONS_TABLE}`, {
        data: this.toRow(conversation),
      });
    } else {
      this.memory.set(conversation.id, conversation);
    }
    return conversation;
  }

  /**
   * Loads a Conversation for continuation, scoped to the person who owns it.
   * A Conversation is personal: it can contain any HRMS data the owner asked
   * about, so another admin must not be able to open it by guessing its id.
   */
  async load(caller: CallerContext, id: string): Promise<Conversation> {
    const conversation =
      this.mode === "ucode" ? await this.readOne(id) : this.memory.get(id) ?? null;

    if (!conversation || !this.owns(caller, conversation)) {
      throw new NotFoundException("Conversation not found");
    }
    return conversation;
  }

  async save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = new Date().toISOString();

    // Attachments are compacted out of the stored copy, never out of the live
    // Thread the loop is still working with this turn. Storing the copy in
    // memory mode too keeps the two modes behaving the same on the next load.
    const stored: Conversation = {
      ...conversation,
      thread: compactAttachments(conversation.thread),
    };

    if (this.mode === "ucode") {
      await this.write("PUT", `/v2/items/${CONVERSATIONS_TABLE}`, {
        data: this.toRow(stored),
      });
    } else {
      this.memory.set(conversation.id, stored);
    }
  }

  async list(caller: CallerContext): Promise<Conversation[]> {
    if (this.mode === "memory") {
      return [...this.memory.values()]
        .filter((c) => this.owns(caller, c) && c.thread.length > 0)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, HISTORY_LIMIT);
    }

    const body = await this.write(
      "GET",
      `/v2/items/${CONVERSATIONS_TABLE}`,
      undefined,
      {
        data: JSON.stringify({
          limit: HISTORY_LIMIT,
          offset: 0,
          user_id: caller.userId,
          companies_id: caller.companiesId,
          order: { updated_at: -1 },
        }),
      },
    );
    // The filter above is sent to ucode, but ucode SILENTLY DROPS a filter
    // naming a column the table does not have — so a drifted or misspelled
    // column would widen this to every conversation in the collection, under
    // the service key, and hand back other people's titles. Re-check ownership
    // on the way out, exactly as `load` does: the request is a hint, this is
    // the guarantee.
    const rows = extractRows(body);
    return rows
      .map(fromRow)
      .filter((c) => this.owns(caller, c) && c.thread.length > 0);
  }

  /**
   * The Conversation a Telegram chat is currently in, or null to start a new
   * one.
   *
   * "Currently" is the whole point: a chat has no visible conversation list, so
   * yesterday's thread would otherwise be dragged into today's question forever.
   * Anything idle past `maxAgeMs` is treated as finished and left behind — the
   * row stays for the audit trail, it is simply no longer continued.
   *
   * Scoped to the Caller as well as the chat. One Telegram account can hold
   * several employee records (one per Company, see the 2026-09-15 migration
   * that dropped the unique index), and each Company's thread is its own.
   */
  async findActiveByChat(
    caller: CallerContext,
    chatId: string,
    maxAgeMs: number,
  ): Promise<Conversation | null> {
    const fresh = (c: Conversation): boolean =>
      Date.now() - Date.parse(c.updatedAt) < maxAgeMs;

    if (this.mode === "memory") {
      return (
        [...this.memory.values()]
          .filter(
            (c) =>
              c.telegramChatId === chatId && this.owns(caller, c) && fresh(c),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
      );
    }

    const body = await this.write(
      "GET",
      `/v2/items/${CONVERSATIONS_TABLE}`,
      undefined,
      {
        data: JSON.stringify({
          limit: 1,
          offset: 0,
          telegram_chat_id: chatId,
          user_id: caller.userId,
          companies_id: caller.companiesId,
          order: { updated_at: -1 },
        }),
      },
    );
    // Re-checked on the way out for the reason `list` spells out: ucode SILENTLY
    // DROPS a filter naming a column the table does not have. Here that failure
    // mode is worse than a wrong list — before the column exists in the ucode
    // admin, every filter above is dropped and the newest conversation in the
    // whole collection comes back, which would splice a stranger's thread into
    // this chat.
    const conversation = extractRows(body).map(fromRow)[0];
    if (!conversation) return null;
    const mine =
      conversation.telegramChatId === chatId && this.owns(caller, conversation);
    return mine && fresh(conversation) ? conversation : null;
  }

  /** A Conversation belongs to one person in one Company, and to nobody else. */
  private owns(caller: CallerContext, c: Conversation): boolean {
    return (
      c.userId === caller.userId && c.companiesId === caller.companiesId
    );
  }

  /**
   * Removes a Conversation, once its owner is proven by `load`.
   *
   * A transcript can hold anything the person asked about — salaries, a
   * dismissal, someone's phone number — so being able to take one back is part
   * of the feature, not an extra. There is no retention sweep behind this:
   * deletion is deliberate, by the person whose conversation it was.
   */
  async remove(caller: CallerContext, id: string): Promise<void> {
    const conversation = await this.load(caller, id);
    if (this.mode === "memory") {
      this.memory.delete(conversation.id);
      return;
    }
    await this.write("DELETE", `/v2/items/${CONVERSATIONS_TABLE}`, {
      ids: [conversation.id],
    });
  }

  /**
   * Takes exclusive ownership of a pending action so an approval that arrives
   * twice — a double click, a client retry — executes once.
   */
  claim(actionId: string): boolean {
    if (this.claimed.has(actionId)) return false;
    this.claimed.add(actionId);
    // A Conversation is short-lived and an actionId is a uuid, so the set stays
    // small; trim it if a long-running process ever accumulates enough to matter.
    if (this.claimed.size > 10_000) this.claimed.clear();
    return true;
  }

  async audit(caller: CallerContext, entry: AuditEntry): Promise<void> {
    if (this.mode === "memory") return;
    try {
      await this.write("POST", `/v2/items/${AUDIT_TABLE}`, {
        data: {
          guid: randomUUID(),
          user_id: caller.userId,
          companies_id: caller.companiesId,
          conversation_id: entry.conversationId,
          tool_name: entry.toolName,
          risk: entry.risk,
          input: JSON.stringify(entry.input),
          proposed: entry.proposed,
          executed: entry.executed,
          ok: entry.ok,
          summary: entry.summary,
          error: entry.error,
          created_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      // A failed audit write must not take down an answer that already ran, but
      // it is worth shouting about — this is the record of who changed what.
      this.logger.error(
        `Failed to write copilot audit: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private toRow(c: Conversation): Record<string, unknown> {
    return {
      guid: c.id,
      user_id: c.userId,
      companies_id: c.companiesId,
      telegram_chat_id: c.telegramChatId,
      title: c.title,
      // jsonb-shaped columns in ucode are written as strings, which is also how
      // the HRMS SPA stores its own JSON columns (see user_base.custom_data).
      thread: JSON.stringify(c.thread),
      pending_action: c.pendingAction ? JSON.stringify(c.pendingAction) : null,
      artifacts: JSON.stringify(c.artifacts),
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    };
  }

  private async readOne(id: string): Promise<Conversation | null> {
    const body = await this.write(
      "GET",
      `/v2/items/${CONVERSATIONS_TABLE}/${encodeURIComponent(id)}`,
    );
    const row = extractOne(body);
    return row ? fromRow(row) : null;
  }

  /** One request under the service key — never the Caller's token. */
  private write(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    return this.ucode.request(null, method, path, body, query, { serviceKey: true });
  }
}

// ─── Row mapping ────────────────────────────────────────────────────────────

const unwrap = (body: unknown): unknown => {
  const b = body as { data?: { data?: unknown } } | null;
  return b?.data?.data ?? b?.data ?? body;
};

const extractRows = (body: unknown): Array<Record<string, unknown>> => {
  const payload = unwrap(body) as { response?: unknown };
  return Array.isArray(payload?.response)
    ? (payload.response as Array<Record<string, unknown>>)
    : [];
};

const extractOne = (body: unknown): Record<string, unknown> | null => {
  const payload = unwrap(body) as { response?: unknown };
  const row = payload?.response ?? null;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
};

const fromRow = (row: Record<string, unknown>): Conversation => ({
  id: String(row.guid ?? ""),
  userId: String(row.user_id ?? ""),
  companiesId: String(row.companies_id ?? ""),
  telegramChatId:
    row.telegram_chat_id === null || row.telegram_chat_id === undefined
      ? null
      : String(row.telegram_chat_id),
  title: typeof row.title === "string" ? row.title : null,
  thread: parseJson<Anthropic.MessageParam[]>(row.thread) ?? [],
  pendingAction: parseJson<CopilotPendingAction>(row.pending_action),
  artifacts: parseJson<Record<string, CopilotArtifactBundle>>(row.artifacts) ?? {},
  createdAt: String(row.created_at ?? new Date().toISOString()),
  updatedAt: String(row.updated_at ?? new Date().toISOString()),
});

/** ucode may hand a JSON column back parsed or as a string, depending on type. */
const parseJson = <T>(value: unknown): T | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};
