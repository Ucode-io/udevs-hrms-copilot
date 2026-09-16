import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";

/** Telegram's own ceiling on one message. Longer text has to be split. */
export const MESSAGE_LIMIT = 4096;

const API_TIMEOUT_MS = 10_000;

export interface InlineButton {
  text: string;
  /** Mutually exclusive with `callbackData`, as Telegram requires. */
  url?: string;
  callbackData?: string;
}

/**
 * The slice of the Bot API this service uses.
 *
 * Hand-rolled rather than a bot framework: the framework's job is routing and
 * an update loop, and both of those live elsewhere here — routing in
 * TelegramService, the update loop in Telegram's own webhook. What would be
 * left of the library is four fetch calls.
 *
 * Nothing here throws. A notification that fails is not a reason to fail the
 * answer that produced it, and every caller is reacting to a webhook that
 * Telegram will not retry usefully anyway.
 */
@Injectable()
export class TelegramApi {
  private readonly logger = new Logger(TelegramApi.name);

  constructor(@Inject(CONFIG) private readonly config: CopilotConfig) {}

  /**
   * Sends text, splitting it when it exceeds Telegram's limit.
   *
   * Buttons ride on the LAST part only: they belong to the end of an answer,
   * and repeating them under every chunk would offer the same action three
   * times.
   */
  async sendMessage(
    chatId: string,
    text: string,
    buttons: InlineButton[][] = [],
  ): Promise<number> {
    const parts = splitMessage(text);
    let firstId = 0;
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const id = await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        // HTML, not Markdown, and not plain: a table only keeps its columns
        // inside <pre>. Markdown would be the worse trade — an underscore in a
        // name breaks it, and there is no escaping story as small as the three
        // characters HTML needs. Everything in `text` was escaped by render.ts;
        // that escaping and this flag have to travel together.
        parse_mode: "HTML",
        ...(last && buttons.length > 0
          ? { reply_markup: { inline_keyboard: toKeyboard(buttons) } }
          : {}),
      });
      if (!firstId) firstId = id;
    }
    return firstId;
  }

  /**
   * The "typing…" bubble. Telegram clears it after ~5 seconds, so a long answer
   * has to keep saying it — see TelegramService, which re-sends on a timer.
   */
  async sendTyping(chatId: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /**
   * Closes the spinner on a tapped inline button. Telegram spins it for a few
   * seconds otherwise, which reads as the bot having missed the tap.
   */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: false } : {}),
    });
  }

  /**
   * Replaces a message's text and drops its buttons in one call.
   *
   * Used where the tap itself is the information — picking a company leaves no
   * other trace, and a picker that simply loses its buttons reads as the bot
   * having swallowed the choice.
   */
  async editText(
    chatId: string,
    messageId: number,
    text: string,
    buttons: InlineButton[][] = [],
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: toKeyboard(buttons) },
    });
  }

  /**
   * Strips the buttons off a message that has been acted on, so a confirmation
   * card cannot be tapped a second time and a company picker stops inviting a
   * choice that has already been made.
   */
  async clearButtons(chatId: string, messageId: number): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  // Registering the webhook lives in set-webhook.ts, not here: it takes the
  // bot's single update queue away from hickvision's poller, which is a
  // deliberate one-time act and not something a booting pod should do.

  /** The new message's id, or 0 — for a call that made none, or that failed. */
  private async call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const token = this.config.telegram.botToken;
    if (!token) {
      this.logger.warn(`telegram: no bot token, ${method} skipped`);
      return 0;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(`telegram ${method} -> ${res.status}: ${body.slice(0, 300)}`);
        return 0;
      }
      const body = (await res.json().catch(() => null)) as {
        result?: { message_id?: number };
      } | null;
      return body?.result?.message_id ?? 0;
    } catch (e) {
      this.logger.warn(
        `telegram ${method} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
  }
}

const toKeyboard = (buttons: InlineButton[][]): unknown[][] =>
  buttons.map((row) =>
    row.map((b) =>
      b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData },
    ),
  );

/**
 * Splits text into Telegram-sized parts, preferring a paragraph break, then a
 * line break, then a hard cut.
 *
 * The preference matters because of what the long answers here look like: a
 * monospaced table inside <pre>. Cutting one mid-line leaves a column split
 * across two messages; cutting between lines does not.
 *
 * A cut that lands inside the block is repaired rather than avoided: an
 * unclosed <pre> is not a cosmetic problem, Telegram rejects the part outright
 * and the person loses half the answer with nothing to explain it.
 */
export const splitMessage = (text: string): string[] => {
  const trimmed = text.trim() || "…";
  if (trimmed.length <= MESSAGE_LIMIT) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;
  // Budget for the closing tags a cut inside a block has to append.
  const room = MESSAGE_LIMIT - CLOSERS.length;

  while (rest.length > room) {
    const window = rest.slice(0, room);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > room / 2 ? cut : room;

    let part = rest.slice(0, at).trim();
    rest = rest.slice(at).trim();

    const open = openTags(part);
    if (open.length > 0) {
      // Innermost first on the way out, outermost first on the way back in.
      part += [...open].reverse().map(closerFor).join("");
      rest = open.map(openerFor).join("") + rest;
    }
    parts.push(part);
  }

  if (rest) parts.push(rest);
  return parts;
};

/** Block tags a table travels in, outermost first. */
const BLOCK_TAGS = ["blockquote", "pre"] as const;
type BlockTag = (typeof BLOCK_TAGS)[number];

/** Worst case a cut has to append: every block closed at once. */
const CLOSERS = BLOCK_TAGS.map((t) => `</${t}>`).join("");

const openerFor = (tag: BlockTag): string =>
  tag === "blockquote" ? "<blockquote expandable>" : "<pre>";

const closerFor = (tag: BlockTag): string => `</${tag}>`;

/**
 * Block tags a fragment leaves open, outermost first.
 *
 * An unclosed tag is not cosmetic: Telegram rejects the whole part, so half an
 * answer disappears with nothing to say why.
 */
const openTags = (fragment: string): BlockTag[] => {
  const stack: BlockTag[] = [];
  for (const [, closing, tag] of fragment.matchAll(
    /<(\/?)(blockquote|pre)(?: expandable)?>/g,
  )) {
    if (closing) stack.pop();
    else stack.push(tag as BlockTag);
  }
  return stack;
};
