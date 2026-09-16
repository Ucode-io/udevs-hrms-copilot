import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { UcodeClient } from "../ucode/ucode.client";
import type { CallerContext } from "../ucode/ucode.types";
import { ConversationStore } from "../copilot/conversation.store";
import { CopilotService } from "../copilot/copilot.service";
import type { CopilotStreamEvent } from "../copilot/types/copilot.types";
import { CONFIRM_PREFIX, REJECT_PREFIX, escapeHtml, renderAnswer } from "./render";
import { TelegramApi, splitMessage, type InlineButton } from "./telegram.api";
import { TelegramCallerService, type ChatIdentity } from "./telegram-caller.service";
import { routeUpdate } from "./update-router";

/**
 * Idle time after which a chat's Conversation is considered finished.
 *
 * A Telegram chat is one endless ribbon with no way to start a new thread, so
 * without this the question asked next Tuesday would still be answered in the
 * context of today's. Twelve hours keeps a working day together and separates
 * one day from the next.
 */
const CONVERSATION_MAX_IDLE_MS = 12 * 60 * 60_000;

/** Telegram clears the "typing…" bubble after ~5s, so it has to be repeated. */
const TYPING_INTERVAL_MS = 4_000;

const COMPANY_PREFIX = "co:";

/** How long an unanswered "which Company?" prompt is worth remembering. */
const COMPANY_PROMPT_MAX_AGE_MS = 60 * 60_000;

const NOT_LINKED_TEXT =
  "Не вижу, кто вы в HRMS.\n\n" +
  "Отправьте /start и поделитесь номером телефона — по нему найдём вашу карточку.";

const PICK_COMPANY_TEXT =
  "Вы числитесь в нескольких компаниях. По какой отвечать?";

const NOTHING_PENDING_TEXT = "Это действие уже неактуально.";

/**
 * Title of the Conversation /company opens before any question exists.
 *
 * It never reaches the panel's history — that list skips Conversations with an
 * empty thread — so this only ever shows up in the audit trail.
 */
const COMPANY_PICKED_TITLE = "Выбор компании";

/**
 * What the bot says it is doing, by tool.
 *
 * Grouped rather than one line per tool: the person waiting wants to know the
 * bot is working and roughly on what, not which function it picked. An unknown
 * tool falls back to the generic line instead of leaking its name.
 */
const TOOL_LABELS: Array<[RegExp, string]> = [
  [/^describe_table$/, "⏳ Разбираюсь, где лежат эти данные…"],
  [/^run_report$/, "⏳ Открываю отчёт…"],
  [/^aggregate_items$/, "⏳ Считаю…"],
  [/^list_items$/, "⏳ Смотрю данные…"],
  [/^(create|update|delete)_item$/, "⏳ Готовлю изменение…"],
  [/knowledge|article/, "⏳ Ищу в базе знаний…"],
];

const toolLabel = (toolName: string): string =>
  TOOL_LABELS.find(([pattern]) => pattern.test(toolName))?.[1] ?? "⏳ Работаю…";

/**
 * The "/" menu.
 *
 * Every command the bot answers belongs here — a command that works but is not
 * listed is one nobody finds. `/start` is handled by hickvision rather than by
 * this service, and is listed all the same: the menu belongs to the bot, not to
 * whichever service happens to serve a given command.
 */
const COMMANDS = [
  { command: "new", description: "Начать разговор заново" },
  { command: "company", description: "Переключить компанию" },
  { command: "start", description: "Привязать чат к своей карточке в HRMS" },
];

/**
 * The bot half of the Copilot: it owns Telegram's update queue and turns a
 * message in a private chat into the same Copilot run the panel gets.
 *
 * The Copilot itself is called in-process rather than over HTTP. There is no
 * second service here — the loop, the tools and the Conversation store are all
 * in this pod — so an HTTP hop would only add a port to secure and a failure
 * mode to debug.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  /**
   * Questions waiting on "which Company?", by chat.
   *
   * ponytail: in-process, like the pending-action Claim next to it in
   * ConversationStore, and pinned to the same single replica. Losing one on a
   * restart costs the person retyping one question; persisting it would cost a
   * collection and a cleanup.
   */
  private readonly awaitingCompany = new Map<
    string,
    { text: string; identities: ChatIdentity[]; at: number }
  >();

  constructor(
    @Inject(CONFIG) private readonly config: CopilotConfig,
    private readonly api: TelegramApi,
    private readonly callers: TelegramCallerService,
    private readonly copilot: CopilotService,
    private readonly store: ConversationStore,
    private readonly ucode: UcodeClient,
  ) {}

  /**
   * Publishes the command menu on the way up, so it can never drift from the
   * commands this service actually answers. Failure is logged and no more: a
   * missing menu is a discoverability problem, not a reason to refuse to boot.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.telegram.botToken) return;
    await this.api.setCommands(COMMANDS);
  }

  /**
   * Handles one update. Never throws: Telegram retries a failed webhook with
   * the same update, and an update that fails deterministically would be
   * redelivered forever.
   */
  async handleUpdate(update: unknown): Promise<void> {
    const routed = routeUpdate(update);
    try {
      switch (routed.kind) {
        case "forward":
          await this.forward(update);
          return;
        case "chat":
          await this.onQuestion(routed.chatId, routed.text);
          return;
        case "callback":
          await this.onCallback(
            routed.chatId,
            routed.callbackId,
            routed.messageId,
            routed.data,
          );
          return;
        case "reset":
          await this.onReset(routed.chatId);
          return;
        case "switchCompany":
          await this.onSwitchCompany(routed.chatId);
          return;
        case "ignore":
          if (routed.reason === "unsupported" && routed.chatId) {
            await this.api.sendMessage(
              routed.chatId,
              "Пока понимаю только текст. Напишите вопрос словами.",
            );
          }
          return;
      }
    } catch (e) {
      this.logger.error(
        `telegram update (${routed.kind}) failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      // Saying so matters more here than in the panel: the person has been
      // watching a "typing…" bubble, and silence reads as the bot having
      // ignored them — so they ask again, and pay for a second run.
      const chatId = "chatId" in routed ? routed.chatId : null;
      if (chatId) {
        await this.api.sendMessage(
          chatId,
          "Что-то пошло не так. Попробуйте ещё раз.",
        );
      }
    }
  }

  /**
   * Hands binding updates back to hickvision, which owns group and phone
   * binding and talks to Postgres directly.
   *
   * Loud on failure on purpose: this path replaced a five-minute poll, and if
   * it silently stopped working the symptom would be "I added the bot and
   * nothing happened" with nothing in any log to explain it.
   */
  private async forward(update: unknown): Promise<void> {
    try {
      await this.ucode.request(
        null,
        "POST",
        `/v2/invoke_function/${this.config.telegram.hickvisionFunction}`,
        { data: { method: "telegram_updates", data: { update } } },
        {},
        { serviceKey: true },
      );
    } catch (e) {
      this.logger.error(
        `telegram binding forward failed — group/phone linking is DOWN until this is fixed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ─── Questions ────────────────────────────────────────────────────────────

  private async onQuestion(chatId: string, text: string): Promise<void> {
    const identities = await this.callers.identities(chatId);
    if (identities.length === 0) {
      await this.api.sendMessage(chatId, NOT_LINKED_TEXT);
      return;
    }

    // An open Conversation already carries the Company that was picked for it,
    // so the question of "which company" only comes up once per Conversation.
    const open = await this.findOpen(chatId, identities);
    if (open) {
      await this.ask(chatId, open.caller, open.conversationId, text);
      return;
    }

    if (identities.length === 1) {
      await this.ask(chatId, identities[0].caller, null, text);
      return;
    }

    this.dropStaleCompanyPrompts();
    this.awaitingCompany.set(chatId, { text, identities, at: Date.now() });
    await this.api.sendMessage(
      chatId,
      PICK_COMPANY_TEXT,
      identities.map((i) => [
        {
          text: i.companyName,
          callbackData: `${COMPANY_PREFIX}${i.caller.companiesId}`,
        },
      ]),
    );
  }

  /**
   * Runs one question through the Copilot and sends what came back.
   *
   * The Conversation is created here rather than inside CopilotService so the
   * chat id lands on the row — that is what makes the next message in this chat
   * a continuation instead of a fresh start.
   */
  private async ask(
    chatId: string,
    caller: CallerContext,
    conversationId: string | null,
    text: string,
  ): Promise<void> {
    const id =
      conversationId ?? (await this.store.create(caller, text, chatId)).id;

    const stop = this.startTyping(chatId);
    try {
      await this.deliver(
        chatId,
        this.copilot.streamChat(caller, { conversationId: id, message: text }),
      );
    } finally {
      stop();
    }
  }

  /**
   * Consumes a Copilot stream and leaves one message behind.
   *
   * The message starts as a progress line and is rewritten into the answer, so
   * the wait is legible without a second message to scroll past. Progress moves
   * per tool call — a handful of edits for a whole answer, where streaming the
   * text itself would mean hundreds, and would only show anything in the last
   * seconds: the minutes before that are tool calls, not typing.
   */
  private async deliver(
    chatId: string,
    stream: AsyncGenerator<CopilotStreamEvent>,
  ): Promise<void> {
    const events: CopilotStreamEvent[] = [];
    let statusId = 0;
    let shown = "";

    for await (const event of stream) {
      events.push(event);
      if (event.type !== "tool_call") continue;

      const label = toolLabel(event.toolName);
      // Two list_items in a row would otherwise cost an edit that changes
      // nothing a person can see.
      if (label === shown) continue;
      shown = label;

      statusId = statusId
        ? (await this.api.editText(chatId, statusId, label), statusId)
        : await this.api.sendMessage(chatId, label);
    }

    const answer = renderAnswer(events, this.config.telegram.webUrl);
    const parts = splitMessage(answer.text);
    const head = parts.shift() ?? "…";
    const headButtons = parts.length === 0 ? answer.buttons : [];

    // The progress line becomes the answer. If the edit fails — an answer
    // identical to the status, a message too old to edit — the rest still goes
    // out below, so the person is never left with just "считаю…".
    if (statusId) await this.api.editText(chatId, statusId, head, headButtons);
    else await this.api.sendMessage(chatId, head, headButtons);

    if (parts.length > 0) {
      await this.api.sendMessage(chatId, parts.join("\n\n"), answer.buttons);
    }
  }

  /**
   * Keeps the "typing…" bubble alive for as long as the loop runs — up to five
   * minutes on a hard question. Without it the chat looks dead and people send
   * the question again, which is a second expensive run.
   */
  private startTyping(chatId: string): () => void {
    void this.api.sendTyping(chatId);
    const timer = setInterval(() => {
      void this.api.sendTyping(chatId);
    }, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  // ─── Buttons ──────────────────────────────────────────────────────────────

  private async onCallback(
    chatId: string,
    callbackId: string,
    messageId: number,
    data: string,
  ): Promise<void> {
    await this.api.answerCallback(callbackId);

    if (data.startsWith(COMPANY_PREFIX)) {
      // The picker rewrites itself with the choice — see onCompanyPicked.
      await this.onCompanyPicked(
        chatId,
        data.slice(COMPANY_PREFIX.length),
        messageId,
      );
      return;
    }

    // The card has been acted on; leaving its buttons live invites a second tap
    // that can only ever be refused.
    if (messageId) await this.api.clearButtons(chatId, messageId);

    const approve = data.startsWith(CONFIRM_PREFIX);
    const reject = data.startsWith(REJECT_PREFIX);
    if (!approve && !reject) return;

    const actionId = data.slice(
      (approve ? CONFIRM_PREFIX : REJECT_PREFIX).length,
    );
    const identities = await this.callers.identities(chatId);
    const open = await this.findOpen(chatId, identities);
    if (!open) {
      await this.api.sendMessage(chatId, NOTHING_PENDING_TEXT);
      return;
    }

    const stop = this.startTyping(chatId);
    try {
      await this.deliver(
        chatId,
        this.copilot.streamConfirm(open.caller, {
          conversationId: open.conversationId,
          actionId,
          decision: approve ? "approve" : "reject",
        }),
      );
    } finally {
      stop();
    }
  }

  private async onCompanyPicked(
    chatId: string,
    companiesId: string,
    messageId = 0,
  ): Promise<void> {
    const waiting = this.awaitingCompany.get(chatId);
    this.awaitingCompany.delete(chatId);

    // Re-resolved rather than trusted from the button: callback data is client
    // input, and a company id typed by hand must not become a Caller.
    const identities = waiting?.identities ?? (await this.callers.identities(chatId));
    const picked = identities.find((i) => i.caller.companiesId === companiesId);
    if (!picked) {
      if (messageId) await this.api.clearButtons(chatId, messageId);
      await this.api.sendMessage(chatId, NOT_LINKED_TEXT);
      return;
    }

    // The tap is the only record of which company was chosen, and buttons that
    // merely vanish read as a swallowed choice. Rewriting the question with its
    // answer leaves the decision visible in the history where it was made.
    if (messageId) {
      await this.api.editText(
        chatId,
        messageId,
        `Компания: ${escapeHtml(picked.companyName)}`,
      );
    }

    if (!waiting) {
      // /company picks a Company before there is a question, and a Conversation
      // is the only place a Company is remembered — so one is opened empty
      // here. Without it the choice evaporates the moment it is made, and the
      // very next question asks which company all over again.
      await this.store.create(picked.caller, COMPANY_PICKED_TITLE, chatId);
      await this.api.sendMessage(chatId, "Задайте вопрос.");
      return;
    }

    await this.ask(chatId, picked.caller, null, waiting.text);
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  private async onReset(chatId: string): Promise<void> {
    await this.endConversation(chatId);
    await this.api.sendMessage(chatId, "Начинаю заново. О чём спросить?");
  }

  /**
   * Ends the Conversation this chat is in, without deleting it: the row stays
   * for the audit trail, it simply stops being found by the next message.
   *
   * Silent, because /company ends one on its way to asking which company — and
   * announcing that in the middle of answering a command the person did not
   * give is noise.
   */
  private async endConversation(chatId: string): Promise<void> {
    const identities = await this.callers.identities(chatId);
    const open = await this.findOpen(chatId, identities);
    if (open) {
      const conversation = await this.store.load(open.caller, open.conversationId);
      conversation.telegramChatId = null;
      await this.store.save(conversation);
    }
    this.awaitingCompany.delete(chatId);
  }

  private async onSwitchCompany(chatId: string): Promise<void> {
    const identities = await this.callers.identities(chatId);
    if (identities.length === 0) {
      await this.api.sendMessage(chatId, NOT_LINKED_TEXT);
      return;
    }
    if (identities.length === 1) {
      await this.api.sendMessage(
        chatId,
        `Вы числитесь только в одной компании — «${identities[0].companyName}».`,
      );
      return;
    }

    // Switching Company ends the current Conversation: its thread is about
    // another company's numbers, and carrying it over would invite the model to
    // compare the two as if it had been asked to.
    await this.endConversation(chatId);
    const buttons: InlineButton[][] = identities.map((i) => [
      {
        text: i.companyName,
        callbackData: `${COMPANY_PREFIX}${i.caller.companiesId}`,
      },
    ]);
    await this.api.sendMessage(chatId, PICK_COMPANY_TEXT, buttons);
  }

  /**
   * Forgets company prompts nobody answered.
   *
   * An unanswered prompt holds a question and the employee records behind a
   * chat, and nothing else ever deletes it — a chat that asked once and walked
   * away would sit in this map until the pod restarts.
   */
  private dropStaleCompanyPrompts(): void {
    const cutoff = Date.now() - COMPANY_PROMPT_MAX_AGE_MS;
    for (const [chatId, waiting] of this.awaitingCompany) {
      if (waiting.at < cutoff) this.awaitingCompany.delete(chatId);
    }
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────

  /**
   * The Conversation this chat is currently in, if any.
   *
   * Tried against each employee record behind the chat, because which Company
   * the chat is talking about is recorded on the Conversation itself — the
   * first match is the answer, and finding none is what makes the bot ask.
   */
  private async findOpen(
    chatId: string,
    identities: ChatIdentity[],
  ): Promise<{ caller: CallerContext; conversationId: string } | null> {
    for (const identity of identities) {
      const conversation = await this.store.findActiveByChat(
        identity.caller,
        chatId,
        CONVERSATION_MAX_IDLE_MS,
      );
      if (conversation) {
        return { caller: identity.caller, conversationId: conversation.id };
      }
    }
    return null;
  }
}
