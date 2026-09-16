import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { UcodeClient } from "../ucode/ucode.client";
import { rowLabel } from "../ucode/labels";
import type { CallerContext } from "../ucode/ucode.types";

/** One employee record behind a Telegram account — one person in one Company. */
export interface ChatIdentity {
  caller: CallerContext;
  companyName: string;
}

/** Company names change about never; re-reading them per message would not. */
const COMPANY_CACHE_TTL_MS = 10 * 60_000;

/**
 * Turns a Telegram chat id into the HRMS people it belongs to.
 *
 * Telegram carries no HRMS session, so this is the whole of the bot's
 * authentication: the chat id was written into `user_base` by a path that
 * proved the person — either the mini app (a logged-in session) or the phone
 * number Telegram itself vouched for (`telegram-employee-link.js`). A chat id
 * cannot be spoofed by a sender; it is Telegram's own routing.
 *
 * Returns every match, because one account can be several employees: a person
 * working for two companies has one `user_base` row per Company, which is what
 * the 2026-09-15 migration deliberately allowed. Picking one silently is how a
 * person ends up reading the wrong company's numbers without being told.
 */
@Injectable()
export class TelegramCallerService {
  private readonly logger = new Logger(TelegramCallerService.name);
  private readonly companyNames = new Map<string, { name: string; expiresAt: number }>();

  constructor(
    private readonly ucode: UcodeClient,
    @Inject(CONFIG) private readonly config: CopilotConfig,
  ) {}

  async identities(chatId: string): Promise<ChatIdentity[]> {
    const body = await this.ucode.request(
      null,
      "GET",
      "/v2/items/user_base",
      undefined,
      {
        data: JSON.stringify({
          limit: 10,
          offset: 0,
          telegram_chat_id: chatId,
        }),
      },
      { serviceKey: true },
    );

    const rows = extractRows(body).filter(
      // ucode SILENTLY DROPS a filter naming a column it does not know, and the
      // request above runs under the service key across every Company. Without
      // this line a renamed column would not fail — it would hand the first ten
      // employees in the project to whoever messaged the bot.
      (row) => String(row.telegram_chat_id ?? "") === chatId,
    );

    const identities: ChatIdentity[] = [];
    for (const row of rows) {
      const userId = String(row.guid ?? "");
      const companiesId = String(row.companies_id ?? "");
      // A record with no Company cannot scope a single query — the same refusal
      // CallerService makes for the browser, for the same reason.
      if (!userId || !companiesId) continue;

      identities.push({
        caller: {
          userId,
          companiesId,
          projectId: this.config.ucode.projectId,
          // Nothing to forward: the bot has no token of its own, which is what
          // `service` is for. See CallerContext.service for what that costs.
          token: "",
          service: true,
          // Their name travels for the prompt only — "мой отпуск" has to resolve
          // to this employee without the bot asking a personal chat who it is
          // talking to. Authorization still runs on the guid above.
          person: {
            name: rowLabel(row) ?? "сотрудник",
            surface: "telegram",
          },
        },
        companyName: await this.companyName(companiesId),
      });
    }
    return identities;
  }

  private async companyName(companiesId: string): Promise<string> {
    const cached = this.companyNames.get(companiesId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;

    let name = "—";
    try {
      const body = await this.ucode.request(
        null,
        "GET",
        `/v2/items/companies/${encodeURIComponent(companiesId)}`,
        undefined,
        {},
        { serviceKey: true },
      );
      const row = extractOne(body);
      if (typeof row?.name === "string" && row.name.trim()) name = row.name.trim();
    } catch (e) {
      // A missing name costs a person a readable button label, not an answer.
      this.logger.warn(
        `company ${companiesId} name unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    this.companyNames.set(companiesId, {
      name,
      expiresAt: Date.now() + COMPANY_CACHE_TTL_MS,
    });
    return name;
  }
}

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
