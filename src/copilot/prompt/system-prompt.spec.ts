import { SystemPromptBuilder } from "./system-prompt";
import type { CallerContext } from "../../ucode/ucode.types";

const catalog = { promptCatalog: () => "(tables)" };
const builder = new SystemPromptBuilder(catalog as never);

const caller = (extra: Partial<CallerContext> = {}): CallerContext => ({
  userId: "user-1",
  companiesId: "co-1",
  projectId: "project-1",
  token: "t",
  ...extra,
});

/** The volatile block — everything after the cache breakpoint. */
const volatilePart = (ctx: { caller: CallerContext; route: string | null }) =>
  builder.build(ctx as never).at(-1)!.text;

describe("volatile prompt", () => {
  it("always states today's date", () => {
    expect(volatilePart({ caller: caller(), route: null })).toContain("Today is");
  });

  it("says nothing about a person when the panel is asking", () => {
    // The panel's Caller is an admin asking about other people; "мой отпуск" is
    // not the shape of the question there.
    const text = volatilePart({ caller: caller(), route: "/employees" });

    expect(text).toContain("/employees");
    expect(text).not.toContain("Telegram");
  });

  describe("when the Telegram bot is asking", () => {
    const text = () =>
      volatilePart({
        caller: caller({
          person: { name: "Каримов Азиз", surface: "telegram" },
        }),
        route: null,
      });

    it("names the person and their own guid", () => {
      // Without this the bot answers "скажите своё имя" in a private chat that
      // exists precisely because it already knows who the person is.
      expect(text()).toContain("Каримов Азиз");
      expect(text()).toContain("user-1");
    });

    it("forbids pointing at a chart nobody can see", () => {
      // Charts are dropped on the way into Telegram, so a reply that leans on
      // one describes something that is not on screen.
      expect(text()).toContain("charts are NOT shown");
    });
  });
});
