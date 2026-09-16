/**
 * What a Telegram update means to this service.
 *
 * Kept as a pure classifier over the raw update so the routing rules — which
 * are the part that decides whether the group binding keeps working — can be
 * tested without a bot, a database or a model.
 */
export type RoutedUpdate =
  /** A question for the Copilot. */
  | { kind: "chat"; chatId: string; text: string }
  /** A tapped inline button. */
  | {
      kind: "callback";
      chatId: string;
      callbackId: string;
      messageId: number;
      data: string;
    }
  /** Start a fresh Conversation in this chat. */
  | { kind: "reset"; chatId: string }
  /** Re-ask which Company the person means. */
  | { kind: "switchCompany"; chatId: string }
  /** Binding business: belongs to hickvision, which owns it today. */
  | { kind: "forward" }
  /** Something this bot has nothing to say about. */
  | { kind: "ignore"; chatId: string | null; reason: "unsupported" | "other" };

/** `/start` with no payload — the phone-number binding flow in hickvision. */
const START = /^\/start(?:@\S+)?\s*$/i;
const NEW = /^\/new(?:@\S+)?\s*$/i;
const COMPANY = /^\/company(?:@\S+)?\s*$/i;

export const routeUpdate = (update: unknown): RoutedUpdate => {
  const u = update as {
    message?: {
      chat?: { id?: number | string; type?: string };
      text?: string;
      contact?: unknown;
    };
    callback_query?: {
      id?: string;
      data?: string;
      message?: { chat?: { id?: number | string }; message_id?: number };
    };
    my_chat_member?: unknown;
  } | null;

  if (!u || typeof u !== "object") return { kind: "ignore", chatId: null, reason: "other" };

  // Membership changes are only ever about a group being bound. They also fire
  // for private chats (someone blocking the bot), and hickvision already
  // refuses those — no need to second-guess it here.
  if (u.my_chat_member) return { kind: "forward" };

  const callback = u.callback_query;
  if (callback?.id && callback.data && callback.message?.chat?.id != null) {
    return {
      kind: "callback",
      chatId: String(callback.message.chat.id),
      callbackId: callback.id,
      messageId: Number(callback.message.message_id ?? 0),
      data: callback.data,
    };
  }

  const message = u.message;
  if (!message?.chat?.id) return { kind: "ignore", chatId: null, reason: "other" };

  const chatId = String(message.chat.id);

  // Groups get notifications and binding, never a conversation: an answer there
  // is read by everyone in the room, and this service does not narrow what an
  // answer may contain. Decided 2026-09-16, together with the service-key model
  // in CallerContext.service — the two go together.
  if (message.chat.type !== "private") return { kind: "forward" };

  if (message.contact) return { kind: "forward" };

  const text = String(message.text ?? "").trim();
  if (!text) return { kind: "ignore", chatId, reason: "unsupported" };
  if (START.test(text)) return { kind: "forward" };
  if (NEW.test(text)) return { kind: "reset", chatId };
  if (COMPANY.test(text)) return { kind: "switchCompany", chatId };

  return { kind: "chat", chatId, text };
};
