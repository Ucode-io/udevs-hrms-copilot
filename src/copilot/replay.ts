import type Anthropic from "@anthropic-ai/sdk";
import type { Conversation } from "./conversation.store";
import type {
  CopilotMessage,
  CopilotMessageAction,
  CopilotToolRisk,
} from "./types/copilot.types";

/**
 * Rebuilds a stored Conversation into the messages the panel draws.
 *
 * The Thread is the model's transcript, not a person's: it carries thinking
 * blocks, tool inputs, and tool results wrapped in an "untrusted data" banner.
 * Replaying it verbatim would show someone the machinery instead of their
 * conversation — and would put tool output on screen with the banner still
 * attached, which is the one thing that text must never look like.
 *
 * So this reproduces the shape the live stream builds rather than the shape the
 * Thread has: one assistant bubble per turn, artifacts hung off the tool call
 * that produced them, and a chip for every write.
 */
export const projectThread = (
  conversation: Conversation,
  riskOf: (toolName: string) => CopilotToolRisk,
): CopilotMessage[] => {
  const messages: CopilotMessage[] = [];
  /** Actions by tool_use id, so a result several entries later can settle one. */
  const actions = new Map<string, CopilotMessageAction>();
  let assistant: CopilotMessage | null = null;

  conversation.thread.forEach((entry, index) => {
    const blocks = toBlocks(entry.content);

    if (entry.role === "user") {
      const results = blocks.filter(isToolResult);
      // A tool result is the model talking to itself: it belongs to the bubble
      // already open, not to a new one from the person.
      if (results.length > 0) {
        for (const result of results) settle(actions.get(result.tool_use_id), result);
        return;
      }
      assistant = null;
      messages.push(userMessage(index, blocks, conversation.createdAt));
      return;
    }

    if (!assistant) {
      assistant = {
        id: `replay-${index}`,
        role: "assistant",
        content: "",
        createdAt: conversation.createdAt,
        status: "complete",
      };
      messages.push(assistant);
    }

    for (const block of blocks) {
      if (block.type === "text") {
        // The live stream separates turns with a blank line for the same reason:
        // without it the last sentence of one turn runs into the first of the next.
        assistant.content = assistant.content
          ? `${assistant.content}\n\n${block.text}`
          : block.text;
        continue;
      }
      if (block.type !== "tool_use") continue;

      attach(assistant, conversation.artifacts[block.id]);

      const action = toAction(block, riskOf(block.name), conversation);
      if (action) {
        assistant.actions = [...(assistant.actions ?? []), action];
        actions.set(block.id, action);
      }
    }
  });

  // A write with no result never happened: either it is the card still sitting
  // on the server, or the process died between proposing and executing. Both
  // replay as stale — approving a change proposed in a previous session, against
  // data that has moved since, is the thing the card exists to prevent.
  for (const action of actions.values()) {
    if (action.state === "proposed") {
      action.state = "rejected";
      action.error = "Действие устарело: предложено раньше и не подтверждено.";
    }
  }

  return messages;
};

const toBlocks = (
  content: Anthropic.MessageParam["content"],
): Anthropic.ContentBlockParam[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const isToolResult = (
  block: Anthropic.ContentBlockParam,
): block is Anthropic.ToolResultBlockParam => block.type === "tool_result";

/**
 * What the person actually said, with the file machinery lifted out of it.
 *
 * An attached file arrives as a `[Файл: имя]` label in front of the block
 * carrying it, and once the bytes are dropped from storage the block itself
 * becomes a stand-in sentence. Both are addressed to the model, so both come
 * out of the text and the filename becomes a chip instead — the label is the
 * only source that survives compaction and covers images, which have no `title`.
 */
const userMessage = (
  index: number,
  blocks: Anthropic.ContentBlockParam[],
  createdAt: string,
): CopilotMessage => {
  const texts = blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text);

  const labelled = texts.map((t) => FILE_LABEL.exec(t.trim())?.[1] ?? null);
  const name =
    labelled.find((n): n is string => n !== null) ??
    documentTitle(blocks) ??
    (blocks.some(isAttachmentBlock) ? "Файл" : null);

  const content = texts
    .filter((t, i) => labelled[i] === null && !isDroppedNote(t))
    .join("\n\n");

  return {
    id: `replay-${index}`,
    role: "user",
    content,
    createdAt,
    status: "complete",
    // Size is not in the Thread, and the chip shows only the name.
    ...(name ? { file: { name, size: 0 } } : {}),
  };
};

const FILE_LABEL = /^\[Файл: (.+)\]$/;

/** Matches the stand-in `compactAttachments` leaves in place of dropped bytes. */
const isDroppedNote = (text: string): boolean =>
  text.trimStart().startsWith("[Содержимое файла");

const isAttachmentBlock = (block: Anthropic.ContentBlockParam): boolean =>
  block.type === "document" || block.type === "image";

const documentTitle = (blocks: Anthropic.ContentBlockParam[]): string | null => {
  const doc = blocks.find((b) => b.type === "document");
  return doc && "title" in doc && typeof doc.title === "string" ? doc.title : null;
};

/**
 * A card for a write, in the state the transcript proves it ended in.
 *
 * Reads produce no card: they are the answer, not a change to it.
 */
const toAction = (
  block: Anthropic.ToolUseBlockParam,
  risk: CopilotToolRisk,
  conversation: Conversation,
): CopilotMessageAction | null => {
  if (risk === "read") return null;
  const pending =
    conversation.pendingAction?.toolUseId === block.id
      ? conversation.pendingAction
      : null;

  return {
    actionId: pending?.actionId ?? block.id,
    toolName: block.name,
    title: pending?.title ?? block.name,
    description: pending?.description ?? "",
    risk,
    state: "proposed",
    ...(pending?.changes ? { changes: pending.changes } : {}),
  };
};

/** What the tool result says happened, in the words the chip will show. */
const settle = (
  action: CopilotMessageAction | undefined,
  result: Anthropic.ToolResultBlockParam,
): void => {
  if (!action) return;
  const payload = readResult(result.content);

  // Two ways a person can decline: the button, or typing past the card.
  if (payload?.error && DECLINED.some((d) => payload.error?.includes(d))) {
    action.state = "rejected";
    action.error = "Действие отменено.";
    return;
  }
  if (payload?.ok) {
    action.state = "executed";
    if (payload.summary) action.summary = payload.summary;
    return;
  }
  action.state = "failed";
  action.error = payload?.error ?? "Не удалось выполнить.";
};

const DECLINED = ["The person declined this action.", "did not confirm"];

interface ToolResultPayload {
  ok?: boolean;
  summary?: string;
  error?: string;
}

/**
 * Digs the result out of a tool_result block.
 *
 * The body is JSON behind an "untrusted data" banner, so this looks for the
 * object rather than stripping a constant — the banner's wording belongs to the
 * service and is free to change without breaking replay.
 */
const readResult = (
  content: Anthropic.ToolResultBlockParam["content"],
): ToolResultPayload | null => {
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start)) as ToolResultPayload;
  } catch {
    return null;
  }
};

const attach = (
  message: CopilotMessage,
  bundle: Conversation["artifacts"][string] | undefined,
): void => {
  if (!bundle) return;
  if (bundle.kpis?.length) message.kpis = [...(message.kpis ?? []), ...bundle.kpis];
  if (bundle.tables?.length)
    message.tables = [...(message.tables ?? []), ...bundle.tables];
  if (bundle.charts?.length)
    message.charts = [...(message.charts ?? []), ...bundle.charts];
  if (bundle.links?.length) message.links = [...(message.links ?? []), ...bundle.links];
};
