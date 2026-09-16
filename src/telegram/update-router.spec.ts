import { routeUpdate } from "./update-router";

const privateChat = { id: 777, type: "private" };
const group = { id: -100500, type: "supergroup" };

describe("routeUpdate", () => {
  it("treats a question in a private chat as a question", () => {
    const routed = routeUpdate({
      message: { chat: privateChat, text: "Сколько у меня отпуска?" },
    });

    expect(routed).toEqual({
      kind: "chat",
      chatId: "777",
      text: "Сколько у меня отпуска?",
    });
  });

  describe("what still belongs to hickvision", () => {
    // These four are the binding flows that used to arrive by polling. A
    // webhook kills polling for good, so anything mis-routed here does not
    // degrade — it stops working entirely, silently.

    it("forwards bare /start, which asks for a phone number", () => {
      expect(routeUpdate({ message: { chat: privateChat, text: "/start" } })).toEqual({
        kind: "forward",
      });
    });

    it("forwards a shared contact", () => {
      expect(
        routeUpdate({
          message: { chat: privateChat, contact: { phone_number: "998901234567" } },
        }),
      ).toEqual({ kind: "forward" });
    });

    it("forwards membership changes", () => {
      expect(routeUpdate({ my_chat_member: { chat: group } })).toEqual({
        kind: "forward",
      });
    });

    it("forwards everything said in a group, questions included", () => {
      // Group answers are read by everyone in the room and this service does
      // not narrow what an answer may contain.
      expect(
        routeUpdate({ message: { chat: group, text: "Сколько у Азиза зарплата?" } }),
      ).toEqual({ kind: "forward" });
    });
  });

  it("keeps /start with a binding code away from the chat", () => {
    // Telegram sends this itself when the bot is added through ?startgroup=.
    expect(
      routeUpdate({ message: { chat: group, text: "/start HR-7F3K2M" } }),
    ).toEqual({ kind: "forward" });
  });

  it("reads the commands it owns", () => {
    expect(routeUpdate({ message: { chat: privateChat, text: "/new" } })).toEqual({
      kind: "reset",
      chatId: "777",
    });
    expect(
      routeUpdate({ message: { chat: privateChat, text: "/company@hrms_bot" } }),
    ).toEqual({ kind: "switchCompany", chatId: "777" });
  });

  it("reads a tapped button", () => {
    expect(
      routeUpdate({
        callback_query: {
          id: "cb1",
          data: "ok:action-1",
          message: { chat: privateChat, message_id: 42 },
        },
      }),
    ).toEqual({
      kind: "callback",
      chatId: "777",
      callbackId: "cb1",
      messageId: 42,
      data: "ok:action-1",
    });
  });

  it("answers a photo instead of ignoring it", () => {
    expect(routeUpdate({ message: { chat: privateChat, photo: [] } })).toEqual({
      kind: "ignore",
      chatId: "777",
      reason: "unsupported",
    });
  });

  it("survives junk", () => {
    expect(routeUpdate(null).kind).toBe("ignore");
    expect(routeUpdate({}).kind).toBe("ignore");
    expect(routeUpdate({ message: {} }).kind).toBe("ignore");
  });
});
