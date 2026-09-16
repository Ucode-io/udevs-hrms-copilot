import type { InlineButton } from "./telegram.api";
import type {
  CopilotErrorCode,
  CopilotStreamEvent,
  CopilotTable,
} from "../copilot/types/copilot.types";

/**
 * Error text for the chat.
 *
 * The stream's own messages are written for the panel and are in English; the
 * bot speaks Russian, and the most common one of these — a second question
 * asked while the first is still running — would otherwise greet people in a
 * language the rest of the bot never uses. Anything not listed falls back to
 * whatever the stream said, which is better than dropping the reason.
 */
const ERROR_TEXT: Partial<Record<CopilotErrorCode, string>> = {
  rate_limited: "Ещё отвечаю на прошлый вопрос. Подождите немного.",
  timeout: "Не успел ответить вовремя. Попробуйте спросить короче.",
  unavailable: "Копилот сейчас недоступен. Сообщите администратору.",
  forbidden: "Нет доступа к этим данным.",
  permission_denied: "Нет прав на это действие.",
  not_found: "Не нашёл.",
  invalid_action: "Это действие уже неактуально.",
  action_expired: "Действие устарело. Спросите заново.",
  internal: "Что-то пошло не так. Попробуйте ещё раз.",
};

/** What one answered question turns into, once the stream has finished. */
export interface RenderedAnswer {
  text: string;
  buttons: InlineButton[][];
  /** actionId awaiting a tap, so the caller knows the card is live. */
  pendingActionId: string | null;
}

/**
 * Rows of a table put into a message.
 *
 * Generous because the block is collapsible: an expandable blockquote shows a
 * few lines and opens on a tap, so a long table costs the chat nothing until
 * someone wants it. The cap now guards the 4096-character message limit rather
 * than the reader's patience — 40 rows of a 40-column line leave room for the
 * answer around them.
 */
const TABLE_ROW_LIMIT = 40;

/**
 * Columns kept.
 *
 * Four rather than three because the column a question is about is often the
 * last one: "кто опаздывал" against a table of Сотрудник / Отработано /
 * Вовремя / Опозданий loses its own answer at three. They fit because the
 * numeric columns squeeze — see fitWidths.
 */
const TABLE_COLUMN_LIMIT = 4;

/** Cell width past which a value is cut, so one long note cannot skew a table. */
const CELL_WIDTH_LIMIT = 18;

/**
 * Widest a table line may be.
 *
 * Telegram wraps a <pre> line it cannot fit and offers no sideways scroll, and
 * a wrapped header is worse than a dropped column: the first table shipped put
 * "Опозданий" on its own line under "Сотрудник", which reads as a fifth row
 * rather than a fourth heading. Measured against the desktop bubble, which is
 * narrower than it looks.
 */
const TABLE_LINE_LIMIT = 40;

/** Floor for a squeezed column — below this even a number stops being legible. */
const MIN_COLUMN_WIDTH = 7;

export const CONFIRM_PREFIX = "ok:";
export const REJECT_PREFIX = "no:";

/**
 * Escapes the three characters Telegram's HTML mode reads as markup.
 *
 * Everything in an answer is either model prose or HR data people typed, and
 * both routinely contain `&` and `<`. Unescaped, one of them turns the whole
 * message into a 400 and the person gets silence — which is exactly why the
 * notification sender next door runs with no parse_mode at all. HTML is worth
 * the escaping here only because a table needs <pre> to keep its columns.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The markdown the Copilot actually writes, as Telegram HTML.
 *
 * It writes markdown because the panel renders it (CopilotBubble.tsx covers
 * exactly these constructs). Sent to Telegram untouched, the same reply arrives
 * with its asterisks showing — so this is not decoration, it is the difference
 * between "**Каримов Азиз**" and a name.
 *
 * Runs AFTER escaping, never before: escaping rewrites & < >, none of which
 * appear in the markers below, while doing it the other way round would eat the
 * tags this produces.
 *
 * Headings collapse to bold — Telegram has no heading — and a link the client
 * cannot open becomes its own text, because a bad href does not degrade, it
 * takes the whole message down with a 400.
 */
export const markdownToHtml = (escaped: string, webUrl: string | null): string =>
  escaped
    // Headings first: the hashes are line-anchored, so doing this after the
    // inline pass would leave "### " sitting in front of a <b> run.
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
      const url = linkHref(href, webUrl);
      return url ? `<a href="${url}">${label}</a>` : label;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");

/**
 * A markdown link target Telegram will accept, or null to keep just the label.
 *
 * `kb:<guid>` is the Copilot's own way of citing a Knowledge Base article — not
 * a URL, and a client that is handed one either errors or shows a dead link.
 */
const linkHref = (href: string, webUrl: string | null): string | null => {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("kb:") && webUrl) {
    return `${webUrl}/knowledge-base/articles/${encodeURIComponent(href.slice(3))}`;
  }
  return null;
};

/**
 * Folds a finished Copilot stream into one Telegram message, as HTML.
 *
 * Deliberately a pure function over the collected events: this is the piece
 * that decides what a person actually sees, and the only way to test that
 * without a bot token and a live model is to keep it free of both.
 *
 * What gets dropped, and why:
 *  - charts. Telegram has no canvas, and rendering one to PNG means either a
 *    third-party image service (HR data leaving the estate for a picture) or a
 *    headless browser in the pod. The numbers behind a chart are in the text
 *    anyway — the model was told what it drew.
 *  - usage/tool_call/message_start. Bookkeeping the panel shows as chips and a
 *    chat has no room for.
 */
export const renderAnswer = (
  events: CopilotStreamEvent[],
  webUrl: string | null,
): RenderedAnswer => {
  const parts: string[] = [];
  const buttons: InlineButton[][] = [];
  let text = "";
  let pendingActionId: string | null = null;
  let truncated = false;

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;

      case "kpis":
        parts.push(
          event.kpis
            .map((k) => escapeHtml(`${k.label}: ${k.value}`))
            .join("\n"),
        );
        break;

      case "table":
        parts.push(renderTable(event.table));
        break;

      case "link": {
        const url = absoluteUrl(event.link.href, event.link.external, webUrl);
        if (url) buttons.push([{ text: event.link.label, url }]);
        break;
      }

      case "action_proposed":
        pendingActionId = event.action.actionId;
        parts.push(renderProposal(event.action));
        buttons.push([
          {
            text: "✅ Подтвердить",
            callbackData: `${CONFIRM_PREFIX}${event.action.actionId}`,
          },
          {
            text: "✖️ Отмена",
            callbackData: `${REJECT_PREFIX}${event.action.actionId}`,
          },
        ]);
        break;

      case "action_executed":
        parts.push(
          escapeHtml(
            event.action.ok
              ? `✅ ${event.action.summary}`
              : `⚠️ Не выполнено: ${event.action.error ?? "неизвестная ошибка"}`,
          ),
        );
        break;

      case "error":
        parts.push(
          escapeHtml(
            `⚠️ ${(event.code && ERROR_TEXT[event.code]) || event.message}`,
          ),
        );
        break;

      case "message_complete":
        if (event.stopReason === "max_tokens") truncated = true;
        break;

      default:
        break;
    }
  }

  const body = [markdownToHtml(escapeHtml(text.trim()), webUrl), ...parts]
    .filter(Boolean)
    .join("\n\n");
  return {
    text: truncated ? `${body}\n\n…ответ получился слишком длинным и обрезан.` : body,
    buttons,
    pendingActionId,
  };
};

/**
 * A confirmation card as text. The field-level diff is what makes an approval
 * informed rather than a reflex — "Изменить сотрудника" alone says nothing
 * about what is being changed.
 */
const renderProposal = (
  action: Extract<CopilotStreamEvent, { type: "action_proposed" }>["action"],
): string => {
  const lines = [`❓ ${action.title}`, action.description].filter(Boolean);

  for (const change of action.changes ?? []) {
    lines.push(
      `• ${change.label ?? change.field}: ${change.before ?? "—"} → ${change.after ?? "—"}`,
    );
  }
  return escapeHtml(lines.join("\n"));
};

/**
 * A result set as a monospaced block.
 *
 * Fixed-width padding inside <pre> rather than a Markdown table: Telegram does
 * not render those, and a preformatted block is the only place where columns
 * line up in both the mobile and desktop clients. The padding is what does the
 * aligning, so <pre> without it — or it without <pre> — both give a mess.
 */
const renderTable = (table: CopilotTable): string => {
  const columns = table.columns.slice(0, TABLE_COLUMN_LIMIT);
  const rows = table.rows.slice(0, TABLE_ROW_LIMIT);

  const cells = rows.map((row) =>
    columns.map((c) => cut(String(row[c.key] ?? "—"))),
  );
  const widths = fitWidths(
    columns.map((c, i) =>
      Math.max(cut(c.label).length, ...cells.map((r) => r[i].length), 1),
    ),
  );

  const line = (values: string[]): string =>
    values
      .map((v, i) => (v.length > widths[i] ? cutTo(v, widths[i]) : v.padEnd(widths[i])))
      .join("  ")
      .trimEnd();

  const head = [
    table.title,
    ...(table.subtitle ? [table.subtitle] : []),
  ].join(" — ");

  const hidden: string[] = [];
  const total = table.totalCount ?? table.rows.length;
  if (total > rows.length) hidden.push(`показаны ${rows.length} из ${total}`);
  if (table.columns.length > columns.length) {
    hidden.push(`колонок: ${columns.length} из ${table.columns.length}`);
  }

  const block = [line(columns.map((c) => cut(c.label))), ...cells.map(line)].join(
    "\n",
  );

  return [
    escapeHtml(head),
    // Collapsible, and monospaced inside it: verified against the live API
    // rather than assumed, because the same table without <pre> comes out in a
    // proportional font with its columns gone. The blockquote is what lets a
    // long result travel in a chat — it shows a few lines and opens on a tap.
    `<blockquote expandable><pre>${escapeHtml(block)}</pre></blockquote>`,
    ...(hidden.length > 0 ? [escapeHtml(hidden.join(", "))] : []),
  ].join("\n");
};

const cut = (value: string): string => cutTo(value, CELL_WIDTH_LIMIT);

const cutTo = (value: string, width: number): string =>
  value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;

/**
 * Squeezes column widths until the line fits.
 *
 * The trailing columns give way first and the first one last: the first column
 * is who or what a row is about, and a table of truncated names against intact
 * headings answers nothing. Everything has a floor, so a pathological table
 * comes out narrow and ugly rather than wrapped and unreadable.
 */
const fitWidths = (widths: number[]): number[] => {
  const fitted = [...widths];
  const total = (): number =>
    fitted.reduce((sum, w) => sum + w, 0) + 2 * (fitted.length - 1);

  // Later columns first, first column last — hence the reversed sweep, run
  // until nothing will give any further.
  for (const index of [...fitted.keys()].reverse().concat([...fitted.keys()])) {
    while (total() > TABLE_LINE_LIMIT && fitted[index] > MIN_COLUMN_WIDTH) {
      fitted[index] -= 1;
    }
    if (total() <= TABLE_LINE_LIMIT) break;
  }
  return fitted;
};

/**
 * An in-app link as something Telegram will accept, or null to drop it.
 *
 * Telegram rejects a button whose URL is a bare path, and rejects the whole
 * message with it — so a link that cannot be made absolute has to disappear
 * here rather than take the answer down with it.
 */
const absoluteUrl = (
  href: string,
  external: boolean | undefined,
  webUrl: string | null,
): string | null => {
  if (external || /^https?:\/\//i.test(href)) {
    return /^https?:\/\//i.test(href) ? href : null;
  }
  if (!webUrl) return null;
  return `${webUrl}${href.startsWith("/") ? "" : "/"}${href}`;
};
