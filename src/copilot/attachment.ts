import type Anthropic from "@anthropic-ai/sdk";
import { Workbook, type CellValue } from "exceljs";

/**
 * A file the person attached to a message, as it arrives on the chat request.
 *
 * It exists so a list of people that lives in a spreadsheet can be acted on
 * without being retyped: the model reads the rows, resolves them to real
 * columns, and proposes one create_items it still has to be approved for.
 */
export interface CopilotAttachment {
  name: string;
  mediaType: string;
  /** base64, without the `data:` prefix. */
  data: string;
}

/**
 * Ceiling on one decoded upload. The API would take far more, but the file
 * rides inside the Thread — stored, and re-sent on every turn of the loop — so
 * a large one is paid for repeatedly rather than once.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Cap on the text extracted from one spreadsheet or text file. */
const MAX_TEXT_CHARS = 120_000;
const MAX_SHEET_ROWS = 2_000;
const MAX_SHEET_COLUMNS = 60;

const IMAGE_MEDIA = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;

export const SHEET_EXT = new Set(["xlsx", "xlsm"]);
export const TEXT_EXT = new Set(["csv", "tsv", "txt", "md", "json", "yaml", "yml"]);

/**
 * Turns one upload into the content blocks that open the person's message.
 *
 * Routing is by file extension, not by `mediaType`: browsers report a .xlsx as
 * `application/octet-stream` often enough, and a .csv as `application/vnd.ms-excel`,
 * that trusting the declared type would reject exactly the two formats an HR
 * list usually arrives in.
 *
 * A file that cannot be read comes back as a note to the model rather than as a
 * thrown error — the model then says so in the person's own language, which is
 * the same outcome as an error code with none of the plumbing.
 */
export const attachmentBlocks = async (
  attachment: CopilotAttachment,
): Promise<Anthropic.ContentBlockParam[]> =>
  fileBlocks(attachment.name, attachment.mediaType, Buffer.from(attachment.data, "base64"));

/**
 * The same reading, for a file that did not arrive on the message — a Knowledge
 * Base upload the Copilot fetched from the CDN (`kb_read_file`). Routing,
 * caps and the "could not be read" note are one implementation on purpose: a
 * .xlsx in an article is the same file it would be as an upload.
 */
export const fileBlocks = async (
  rawName: string,
  mediaType: string,
  buffer: Buffer,
  origin: FileOrigin = "upload",
): Promise<Anthropic.ContentBlockParam[]> => {
  const name = safeName(rawName);
  const label = (text: string) => fileLabel(text, origin);

  if (buffer.byteLength === 0) return [note(name, "it arrived empty")];
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    return [
      note(name, `it is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`),
    ];
  }

  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf" || mediaType === "application/pdf") {
    return [
      label(name),
      {
        type: "document",
        title: name,
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
    ];
  }

  if (ext in IMAGE_MEDIA) {
    return [
      label(name),
      {
        type: "image",
        source: {
          type: "base64",
          media_type: IMAGE_MEDIA[ext as keyof typeof IMAGE_MEDIA],
          data: buffer.toString("base64"),
        },
      },
    ];
  }

  if (SHEET_EXT.has(ext)) {
    try {
      return [label(name), document(name, await sheetsToText(buffer))];
    } catch {
      return [note(name, "it is not a readable .xlsx workbook")];
    }
  }

  // Legacy .xls is a different binary format entirely, and adding a second
  // parser for a format Excel itself has not written by default since 2007 is
  // not worth it — saying so is more useful than failing obscurely.
  if (ext === "xls") {
    return [note(name, "the old .xls format cannot be read — save it as .xlsx or .csv")];
  }

  if (TEXT_EXT.has(ext) || mediaType.startsWith("text/")) {
    return [label(name), document(name, truncate(decodeText(buffer)))];
  }

  return [note(name, `the format ".${ext}" is not supported`)];
};

/**
 * Where a file came from, which decides how long its bytes are kept. An upload
 * exists only inside the conversation; a Knowledge Base file can be fetched
 * again at any time.
 */
export type FileOrigin = "upload" | "knowledge-base";

/** The prefix that marks a file the Copilot can go and read a second time. */
export const KB_LABEL_PREFIX = "[Файл из базы знаний: ";

/**
 * Names the file in front of whatever carries it.
 *
 * Redundant for a document, which has a `title` — but an image block has no
 * field for a name, and this is what lets `compactAttachments` throw the bytes
 * away later without throwing away which file they were. The Knowledge Base
 * wording is load-bearing for the same reason: it is how compaction tells a
 * file it can refetch from one it cannot.
 */
const fileLabel = (
  name: string,
  origin: FileOrigin,
): Anthropic.ContentBlockParam => ({
  type: "text",
  text: origin === "knowledge-base" ? `${KB_LABEL_PREFIX}${name}]` : `[Файл: ${name}]`,
});

/** Plain text handed over as a document, so the filename travels with it. */
const document = (name: string, text: string): Anthropic.ContentBlockParam => ({
  type: "document",
  title: name,
  source: { type: "text", media_type: "text/plain", data: text },
});

const note = (name: string, reason: string): Anthropic.ContentBlockParam => ({
  type: "text",
  text: `[The file "${name}" could not be read: ${reason}. Tell the person, and say which formats work: XLSX, CSV, PDF, or an image.]`,
});

/**
 * A filename is text the person controls, and it is about to sit next to
 * instructions. Strip what would let it pose as a block of its own.
 */
const safeName = (name: string): string =>
  name.replace(/[\r\n\]["]/g, " ").trim().slice(0, 120) || "file";

/**
 * Every sheet of a workbook as CSV, one block per sheet.
 *
 * CSV rather than a JSON dump of cells: it is the densest honest rendering of a
 * grid, and it keeps the header row where the model expects to find it.
 */
export const sheetsToText = async (buffer: Buffer): Promise<string> => {
  const workbook = new Workbook();
  // exceljs carries its own node typings, so its Buffer and ours are the same
  // structure under two declarations and TypeScript will not equate them.
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );

  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    const width = Math.min(sheet.columnCount || 0, MAX_SHEET_COLUMNS);
    if (width === 0) continue;

    const lines: string[] = [];
    let skipped = 0;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_SHEET_ROWS) {
        skipped++;
        return;
      }
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(csvCell(cellText(row.getCell(c).value)));
      // A row of nothing but separators says less than no row at all.
      if (cells.some((cell) => cell !== "")) lines.push(cells.join(","));
    });

    if (lines.length === 0) continue;
    parts.push(
      `# Sheet: ${sheet.name}\n${lines.join("\n")}` +
        (skipped > 0 ? `\n(${skipped} further rows not included)` : ""),
    );
  }

  return parts.length > 0 ? truncate(parts.join("\n\n")) : "(the workbook has no data)";
};

/**
 * One cell as text. exceljs hands back a Date for a date-formatted cell, an
 * object for a formula, a hyperlink or rich text, and a primitive otherwise.
 */
const cellText = (value: CellValue): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cell = value as unknown as Record<string, unknown>;
    if (Array.isArray(cell.richText)) {
      return cell.richText
        .map((run) => String((run as { text?: unknown }).text ?? ""))
        .join("");
    }
    if ("result" in cell) return cellText(cell.result as CellValue);
    if ("text" in cell) return String(cell.text ?? "");
    if ("hyperlink" in cell) return String(cell.hyperlink ?? "");
    return "";
  }
  return String(value);
};

const csvCell = (text: string): string =>
  /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/**
 * Decodes an uploaded text file.
 *
 * UTF-8 first, then windows-1251: "CSV (разделители — запятые)" out of a
 * Russian Excel is cp1251, and reading it as UTF-8 turns every name into
 * replacement characters — which the model would faithfully import.
 */
export const decodeText = (buffer: Buffer): string => {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const text = utf8.includes("�")
    ? new TextDecoder("windows-1251").decode(buffer)
    : utf8;
  return text.replace(/^﻿/, "");
};

export const truncate = (text: string): string =>
  text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n(truncated — the file is longer than this)`
    : text;

// ─── Storage ────────────────────────────────────────────────────────────────

const DROPPED =
  "[Содержимое файла больше не хранится. Если оно снова нужно, попросите прислать файл ещё раз.]";

/**
 * The same stand-in for a file that can be had again — and it says how, because
 * a model that reads "no longer stored" and stops there answers from a filename
 * instead of from the file.
 */
const KB_DROPPED =
  "[Содержимое файла больше не хранится. Оно в базе знаний: вызовите kb_read_file ещё раз, если ответ зависит от того, что внутри.]";

const isAttachment = (block: Anthropic.ContentBlockParam): boolean =>
  block.type === "document" || block.type === "image";

/**
 * The copy of a Thread that goes to storage, with the file bytes it no longer
 * needs replaced by a sentence naming what was there.
 *
 * A stored Thread is written whole on every save — in ucode mode that is a
 * JSON.stringify of the lot into one column, on every turn — and it is read
 * back and re-sent to the model on every turn after that. So bytes left in it
 * are not paid for once: they are paid for on every reply for as long as the
 * conversation lives.
 *
 * The newest *upload* keeps its bytes on purpose: "а теперь возьми из того же
 * файла ещё и отделы" is a normal second question, and the file exists nowhere
 * else — the person would have to attach it again.
 *
 * A Knowledge Base file is the opposite case and always loses its bytes, even
 * when it is the newest thing in the thread. It is still in the Knowledge Base,
 * kb_read_file will fetch it again in a second, and the alternative is a price
 * list riding along on every later reply about anything at all. Refetching when
 * a question needs it beats carrying it when no question does.
 */
export const compactAttachments = (
  thread: Anthropic.MessageParam[],
): Anthropic.MessageParam[] => {
  // Most threads carry no file at all, and those come back untouched rather
  // than rebuilt.
  if (!thread.some(hasAttachment)) return thread;

  let newestUpload = -1;
  thread.forEach((message, i) => {
    if (hasAttachment(message) && !fromKnowledgeBase(message)) newestUpload = i;
  });

  return thread.map((message, i) => {
    if (i === newestUpload || !Array.isArray(message.content)) return message;
    if (!message.content.some(isAttachment)) return message;
    const standIn = fromKnowledgeBase(message) ? KB_DROPPED : DROPPED;
    return {
      ...message,
      content: message.content.map((block) =>
        isAttachment(block)
          ? ({ type: "text", text: standIn } as Anthropic.ContentBlockParam)
          : block,
      ),
    };
  });
};

const hasAttachment = (message: Anthropic.MessageParam): boolean =>
  Array.isArray(message.content) && message.content.some(isAttachment);

/** Told apart by the label `fileBlocks` wrote in front of the bytes. */
const fromKnowledgeBase = (message: Anthropic.MessageParam): boolean =>
  Array.isArray(message.content) &&
  message.content.some(
    (block) => block.type === "text" && block.text.startsWith(KB_LABEL_PREFIX),
  );
