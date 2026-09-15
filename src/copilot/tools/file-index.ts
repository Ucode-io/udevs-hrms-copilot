import { Logger } from "@nestjs/common";
import pdfParse from "pdf-parse";
import {
  MAX_ATTACHMENT_BYTES,
  SHEET_EXT,
  TEXT_EXT,
  decodeText,
  sheetsToText,
  truncate,
} from "../attachment";
import { CopilotToolError } from "./tool-support";

/**
 * Reading a Knowledge Base upload as plain text, so `kb_search` can look inside
 * it.
 *
 * Why this exists at all: an article's body holds a link, never the file's
 * text, so a question whose words live only inside a PDF — "как забронировать",
 * answered by a "Номера телефонов для брони" block on page one of the price
 * list — matches no article title and no article body, and the Copilot says the
 * Knowledge Base has nothing on it. Which is true of everything it can see, and
 * false of the base.
 *
 * The extracted text is for *finding* a file, not for quoting it. A PDF table
 * comes out of any extractor with its columns run together (`43 557х40 196…`),
 * so a figure read from here would be a guess with a decimal point in it — the
 * search says which file, and `kb_read_file` hands the model the real thing.
 */

/** Where the editor's "Загрузить" tab puts a file. Nothing else is fetched. */
export const CDN_HOST = "cdn.u-code.io";
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Files kept in memory at once. Well past a Knowledge Base's worth of uploads;
 * the cap is here so a runaway base cannot grow the heap without limit.
 *
 * ponytail: in-process, so a restart re-reads what it had. A table keyed by url
 * if extraction ever costs more than the couple of hundred milliseconds it does
 * now.
 */
const MAX_CACHED_FILES = 200;

/**
 * Extracted text, keyed by url.
 *
 * Never goes stale, and that is not luck: every upload lands under a fresh guid,
 * so a replaced file is a different url and a different entry. The old text can
 * only be reached by an article still pointing at the old file, which is the
 * right answer for that article.
 */
const cache = new Map<string, string>();
const logger = new Logger("CopilotFileIndex");

export const isCdnUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === CDN_HOST;
  } catch {
    return false;
  }
};

/**
 * Pulls the file down. The CDN link is public, so this carries no credentials —
 * and must not: it is an outbound request built from stored content.
 *
 * Content-Length is checked before the body is read so an oversized file costs
 * one HEAD-sized round trip rather than the whole download; a response without
 * one still cannot get past `fileBlocks`, which caps what it will encode.
 */
export const download = async (
  url: string,
): Promise<{ buffer: Buffer; mediaType: string }> => {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new CopilotToolError(
      `The file could not be downloaded from the storage: ${reason(e)}. Tell the person the file is unreachable rather than guessing what is in it.`,
    );
  }

  if (!res.ok) {
    throw new CopilotToolError(
      res.status === 404
        ? "The file is no longer in the storage — the article links to something that was deleted. Say so; do not answer from the filename."
        : `The storage answered ${res.status} for that file. Say it could not be read.`,
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    throw new CopilotToolError(
      `The file is ${Math.round(declared / 1024 / 1024)} MB, over the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB the Copilot can read. Ask the person for the part they need, or open it themselves.`,
    );
  }

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mediaType: (res.headers.get("content-type") ?? "").split(";")[0].trim(),
  };
};

/** Whether there is any point fetching this file for the index. */
export const isIndexable = (name: string): boolean => {
  const ext = extension(name);
  return ext === "pdf" || SHEET_EXT.has(ext) || TEXT_EXT.has(ext);
};

/**
 * The file's text, downloading and parsing it the first time and remembering it
 * after.
 *
 * Failure is an empty string rather than a throw: one unreadable file must not
 * take down a search across the whole base, and a file that yields nothing is
 * indistinguishable from one that mentions none of the search terms.
 */
export const indexedText = async (url: string, name: string): Promise<string> => {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;

  let text = "";
  try {
    const { buffer } = await download(url);
    text = await extractText(name, buffer);
  } catch (e) {
    // Warn rather than shout: an article linking to a deleted file is a
    // Knowledge Base someone has to tidy, not an incident.
    logger.warn(`Could not index "${name}": ${reason(e)}`);
  }

  if (cache.size >= MAX_CACHED_FILES) {
    // Oldest out first — Map keeps insertion order, and the alternative is an
    // eviction policy nobody would ever tune.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, text);
  return text;
};

/** Only for tests — the cache is a process-wide singleton otherwise. */
export const clearFileIndex = (): void => cache.clear();

const extractText = async (name: string, buffer: Buffer): Promise<string> => {
  if (buffer.byteLength === 0) return "";
  const ext = extension(name);

  if (ext === "pdf") {
    const parsed = await pdfParse(buffer);
    return truncate(parsed.text);
  }
  if (SHEET_EXT.has(ext)) return sheetsToText(buffer);
  if (TEXT_EXT.has(ext)) return truncate(decodeText(buffer));

  // An image has text a person can read and this cannot. Saying nothing is
  // honest; the model still sees the file listed on the article.
  return "";
};

const extension = (name: string): string =>
  name.split(".").pop()?.toLowerCase() ?? "";

const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
