import { TelegramService } from "./telegram.service";
import type { CopilotConfig } from "../config/configuration";
import type { CopilotStreamEvent } from "../copilot/types/copilot.types";

const config = {
  telegram: {
    botToken: "bot-token",
    webhookSecret: "secret",
    hickvisionFunction: "udevs-hrms-hickvision",
    webUrl: "https://hrms.test",
  },
} as CopilotConfig;

const sent: Array<{ chatId: string; text: string }> = [];
const forwarded: Array<{ path: string; body: unknown }> = [];

interface Command {
  command: string;
  description: string;
}

const api = {
  setCommands: jest.fn(async (_commands: Command[]) => {}),
  sendMessage: jest.fn(
    async (
      chatId: string,
      text: string,
      _buttons: unknown[] = [],
      _keyboard: string[] = [],
    ) => {
      sent.push({ chatId, text });
      return 100 + sent.length;
    },
  ),
  sendTyping: jest.fn(async () => {}),
  answerCallback: jest.fn(async () => {}),
  clearButtons: jest.fn(async () => {}),
  editText: jest.fn(async () => {}),
};

const ucode = {
  request: jest.fn(async (_ctx, _method, path: string, body: unknown) => {
    forwarded.push({ path, body });
    return {};
  }),
};

const identity = (companiesId: string, companyName: string) => ({
  caller: {
    userId: `user-${companiesId}`,
    companiesId,
    projectId: "project-1",
    token: "",
    service: true,
  },
  companyName,
});

const stream = async function* (
  ...events: CopilotStreamEvent[]
): AsyncGenerator<CopilotStreamEvent> {
  for (const event of events) yield event;
};

const build = (overrides: {
  identities?: ReturnType<typeof identity>[];
  open?: unknown;
  chat?: () => AsyncGenerator<CopilotStreamEvent>;
}) => {
  const callers = {
    identities: jest.fn(async () => overrides.identities ?? []),
  };
  const store = {
    findActiveByChat: jest.fn(async () => overrides.open ?? null),
    create: jest.fn(async () => ({ id: "conv-1" })),
    load: jest.fn(),
    save: jest.fn(),
  };
  const copilot = {
    streamChat: jest.fn(
      overrides.chat ?? (() => stream({ type: "text_delta", text: "ответ" })),
    ),
    streamConfirm: jest.fn(),
  };

  const service = new TelegramService(
    config,
    api as never,
    callers as never,
    copilot as never,
    store as never,
    ucode as never,
  );
  return { service, callers, store, copilot };
};

beforeEach(() => {
  sent.length = 0;
  forwarded.length = 0;
  jest.clearAllMocks();
});

describe("the command menu", () => {
  it("publishes every command the bot answers", async () => {
    // Without this Telegram shows no "/" hints at all, and a command nobody
    // can discover may as well not exist — which is how /company went unused.
    const { service } = build({});
    await service.onModuleInit();

    const published = api.setCommands.mock.calls[0][0];
    expect(published.map((c) => c.command).sort()).toEqual([
      "company",
      "new",
      "start",
    ]);
  });
});

describe("binding updates", () => {
  // The path that replaced a five-minute poll. If it breaks, "I added the bot
  // and nothing happened" comes back with nothing in any log to explain it.
  it("hands a group membership change to hickvision untouched", async () => {
    const { service, copilot } = build({});
    const update = { my_chat_member: { chat: { id: -100500, type: "supergroup" } } };

    await service.handleUpdate(update);

    expect(forwarded).toEqual([
      {
        path: "/v2/invoke_function/udevs-hrms-hickvision",
        body: { data: { method: "telegram_updates", data: { update } } },
      },
    ]);
    expect(copilot.streamChat).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("forwards /start rather than answering it", async () => {
    const { service, copilot } = build({});

    await service.handleUpdate({
      message: { chat: { id: 777, type: "private" }, text: "/start" },
    });

    expect(forwarded).toHaveLength(1);
    expect(copilot.streamChat).not.toHaveBeenCalled();
  });
});

describe("a question in a private chat", () => {
  const ask = (text = "Сколько у меня отпуска?") => ({
    message: { chat: { id: 777, type: "private" }, text },
  });

  it("is refused when the chat belongs to nobody in HRMS", async () => {
    const { service, copilot } = build({ identities: [] });

    await service.handleUpdate(ask());

    expect(copilot.streamChat).not.toHaveBeenCalled();
    expect(sent[0].text).toContain("/start");
  });

  it("runs as the one employee behind the chat", async () => {
    const { service, copilot, store } = build({
      identities: [identity("co-1", "Udevs")],
    });

    await service.handleUpdate(ask());

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ companiesId: "co-1" }),
      "Сколько у меня отпуска?",
      "777",
    );
    expect(copilot.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ companiesId: "co-1", service: true }),
      { conversationId: "conv-1", message: "Сколько у меня отпуска?" },
    );
    expect(sent).toEqual([{ chatId: "777", text: "ответ" }]);
  });

  it("asks which company when the person works for two", async () => {
    const { service, copilot } = build({
      identities: [identity("co-1", "Udevs"), identity("co-2", "U-Code")],
    });

    await service.handleUpdate(ask());

    // Answering for one of them silently is the bug the unique-index migration
    // was written about.
    expect(copilot.streamChat).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      "777",
      expect.stringContaining("нескольких компаниях"),
      [
        [{ text: "Udevs", callbackData: "co:co-1" }],
        [{ text: "U-Code", callbackData: "co:co-2" }],
      ],
    );
  });

  it("runs the held question once a company is picked", async () => {
    const { service, copilot } = build({
      identities: [identity("co-1", "Udevs"), identity("co-2", "U-Code")],
    });
    await service.handleUpdate(ask());

    await service.handleUpdate({
      callback_query: {
        id: "cb1",
        data: "co:co-2",
        message: { chat: { id: 777, type: "private" }, message_id: 9 },
      },
    });

    expect(copilot.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ companiesId: "co-2" }),
      { conversationId: "conv-1", message: "Сколько у меня отпуска?" },
    );
    // The picker becomes the record of what was chosen. Buttons that merely
    // vanish leave the person unable to tell which company answered.
    expect(api.editText).toHaveBeenCalledWith("777", 9, "Компания: U-Code");
  });

  it("remembers a company picked by /company, with no question waiting", async () => {
    // Live bug: /company answered "Отвечаю по компании «Udevs»" and the very
    // next question asked which company again. A Company is remembered on a
    // Conversation, and /company chooses one before any Conversation exists —
    // so one has to be opened right there.
    const { service, store } = build({
      identities: [identity("co-1", "Udevs"), identity("co-2", "U-Code")],
    });

    await service.handleUpdate({
      callback_query: {
        id: "cb1",
        data: "co:co-1",
        message: { chat: { id: 777, type: "private" }, message_id: 9 },
      },
    });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ companiesId: "co-1" }),
      "Выбор компании",
      "777",
    );
  });

  it("continues the Conversation the chat is already in", async () => {
    const { service, copilot, store } = build({
      identities: [identity("co-1", "Udevs"), identity("co-2", "U-Code")],
      open: { id: "conv-open" },
    });

    await service.handleUpdate(ask("А за август?"));

    // No second "which company?": the open Conversation already carries it.
    expect(store.create).not.toHaveBeenCalled();
    expect(copilot.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ companiesId: "co-1" }),
      { conversationId: "conv-open", message: "А за август?" },
    );
  });

  it("shows what it is doing, then rewrites that into the answer", async () => {
    const { service } = build({
      identities: [identity("co-1", "Udevs")],
      chat: () =>
        stream(
          { type: "tool_call", toolName: "run_report", toolUseId: "t1", risk: "read" },
          { type: "tool_call", toolName: "aggregate_items", toolUseId: "t2", risk: "read" },
          { type: "text_delta", text: "76 опозданий" },
        ),
    });

    await service.handleUpdate(ask());

    // One message, not three: the progress line IS the answer once it arrives.
    expect(sent).toEqual([{ chatId: "777", text: "⏳ Открываю отчёт…" }]);
    expect(api.editText).toHaveBeenNthCalledWith(1, "777", 101, "⏳ Считаю…");
    expect(api.editText).toHaveBeenNthCalledWith(2, "777", 101, "76 опозданий", []);
  });

  it("puts the keyboard up once, not with every answer", async () => {
    // Telegram keeps a reply keyboard until it is replaced, so re-sending it
    // would shove it back open every time someone collapsed it.
    const { service } = build({ identities: [identity("co-1", "Udevs")] });

    await service.handleUpdate(ask());
    await service.handleUpdate(ask("а за август?"));

    const withKeyboard = api.sendMessage.mock.calls.filter(
      (call) => (call[3] ?? []).length > 0,
    );
    expect(withKeyboard).toHaveLength(1);
    expect(withKeyboard[0][3]).toEqual(["🔄 Заново", "🏢 Компания"]);
  });

  it("does not re-edit when the next tool says the same thing", async () => {
    const { service } = build({
      identities: [identity("co-1", "Udevs")],
      chat: () =>
        stream(
          { type: "tool_call", toolName: "list_items", toolUseId: "t1", risk: "read" },
          { type: "tool_call", toolName: "list_items", toolUseId: "t2", risk: "read" },
          { type: "text_delta", text: "готово" },
        ),
    });

    await service.handleUpdate(ask());

    // Only the final rewrite — an edit that changes nothing visible is a
    // request spent on nothing.
    expect(api.editText).toHaveBeenCalledTimes(1);
    expect(api.editText).toHaveBeenCalledWith("777", 101, "готово", []);
  });

  it("never lets a failure reach Telegram, which would redeliver forever", async () => {
    const { service } = build({
      identities: [identity("co-1", "Udevs")],
      chat: () => {
        throw new Error("model exploded");
      },
    });

    await expect(service.handleUpdate(ask())).resolves.toBeUndefined();
    // And the person is told, rather than left watching a "typing…" bubble that
    // never resolves into anything.
    expect(sent[0].text).toContain("Что-то пошло не так");
  });
});
