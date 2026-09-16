import { renderAnswer } from "./render";
import { splitMessage, MESSAGE_LIMIT } from "./telegram.api";
import type { CopilotStreamEvent } from "../copilot/types/copilot.types";

const text = (t: string): CopilotStreamEvent => ({ type: "text_delta", text: t });

const WEB = "https://hrms.test";

describe("renderAnswer", () => {
  it("joins the streamed text into one message", () => {
    const answer = renderAnswer([text("Опоздания "), text("за сентябрь: 14")], WEB);

    expect(answer.text).toBe("Опоздания за сентябрь: 14");
    expect(answer.buttons).toEqual([]);
    expect(answer.pendingActionId).toBeNull();
  });

  it("lays a table out in a code block", () => {
    const answer = renderAnswer(
      [
        text("Вот список:"),
        {
          type: "table",
          table: {
            id: "t1",
            title: "Опоздания",
            columns: [
              { key: "name", label: "Сотрудник" },
              { key: "count", label: "Раз" },
            ],
            rows: [
              { name: "Азиз К.", count: 4 },
              { name: "Диляра С.", count: 3 },
            ],
          },
        },
      ],
      WEB,
    );

    // <pre>, not ``` — Telegram renders nothing for backticks in HTML mode, and
    // without a monospaced block the padding below aligns nothing.
    expect(answer.text).toContain("<pre>");
    expect(answer.text).toContain("</pre>");
    // Columns line up: the header is padded to the widest cell under it.
    expect(answer.text).toContain("Сотрудник  Раз");
    expect(answer.text).toContain("Азиз К.    4");
  });

  describe("markdown the Copilot writes for the panel", () => {
    // It writes these because CopilotBubble renders them. Sent to Telegram
    // untouched, the person reads the asterisks instead of the name.
    it("turns bold, code and bullets into what Telegram understands", () => {
      const answer = renderAnswer(
        [text("**Каримов Азиз** опоздал 4 раза\n- фильтр `status`\n- и всё")],
        WEB,
      );

      expect(answer.text).toContain("<b>Каримов Азиз</b>");
      expect(answer.text).toContain("<code>status</code>");
      expect(answer.text).toContain("• фильтр");
      expect(answer.text).not.toContain("**");
    });

    it("collapses a heading to bold, since Telegram has no headings", () => {
      expect(renderAnswer([text("## Итоги сентября")], WEB).text).toBe(
        "<b>Итоги сентября</b>",
      );
    });

    it("links a cited article through the panel", () => {
      const answer = renderAnswer([text("см. [Аллерайз](kb:abc-123)")], WEB);

      expect(answer.text).toContain(
        '<a href="https://hrms.test/knowledge-base/articles/abc-123">Аллерайз</a>',
      );
    });

    it("keeps only the label when the link has nowhere to point", () => {
      // kb: is not a URL. Handing one to Telegram is a 400 that takes the whole
      // answer with it, so the citation degrades to its own text.
      const answer = renderAnswer([text("см. [Аллерайз](kb:abc-123)")], null);

      expect(answer.text).toBe("см. Аллерайз");
    });
  });

  it("escapes what people typed, so one angle bracket cannot 400 the answer", () => {
    const answer = renderAnswer(
      [
        text("Нашёл сотрудника <Азиз> & Co"),
        {
          type: "table",
          table: {
            id: "t1",
            title: "R&D <отдел>",
            columns: [{ key: "name", label: "Имя" }],
            rows: [{ name: "<script>" }],
          },
        },
      ],
      WEB,
    );

    expect(answer.text).toContain("&lt;Азиз&gt; &amp; Co");
    expect(answer.text).toContain("R&amp;D &lt;отдел&gt;");
    expect(answer.text).toContain("&lt;script&gt;");
    // The only markup left is the block the renderer put there itself.
    expect(answer.text.match(/<(?!\/?pre>)/g)).toBeNull();
  });

  it("says when a table was cut short instead of implying it is all of it", () => {
    const answer = renderAnswer(
      [
        {
          type: "table",
          table: {
            id: "t1",
            title: "Сотрудники",
            columns: [{ key: "name", label: "Имя" }],
            rows: Array.from({ length: 40 }, (_, i) => ({ name: `Имя ${i}` })),
            totalCount: 312,
          },
        },
      ],
      WEB,
    );

    expect(answer.text).toContain("показаны 15 из 312");
  });

  it("turns an in-app link into a button against the panel's base url", () => {
    const answer = renderAnswer(
      [
        {
          type: "link",
          link: { id: "l1", label: "Открыть сотрудника", href: "/employees/abc" },
        },
      ],
      WEB,
    );

    expect(answer.buttons).toEqual([
      [{ text: "Открыть сотрудника", url: "https://hrms.test/employees/abc" }],
    ]);
  });

  it("drops an in-app link when there is no base url to make it absolute", () => {
    // Telegram rejects the whole message over one relative button url, so the
    // link has to disappear rather than take the answer down with it.
    const answer = renderAnswer(
      [
        text("Готово"),
        { type: "link", link: { id: "l1", label: "Открыть", href: "/employees/abc" } },
      ],
      null,
    );

    expect(answer.buttons).toEqual([]);
    expect(answer.text).toBe("Готово");
  });

  it("offers approve and reject for a proposed action, with the diff", () => {
    const answer = renderAnswer(
      [
        {
          type: "action_proposed",
          action: {
            actionId: "a-1",
            toolName: "update_item",
            title: "Изменить сотрудника",
            description: "Азиз Каримов",
            args: {},
            risk: "destructive",
            changes: [
              { field: "salary", label: "Оклад", before: "10 000 000", after: "12 000 000" },
            ],
          },
        },
      ],
      WEB,
    );

    expect(answer.pendingActionId).toBe("a-1");
    expect(answer.text).toContain("Оклад: 10 000 000 → 12 000 000");
    expect(answer.buttons[0].map((b) => b.callbackData)).toEqual([
      "ok:a-1",
      "no:a-1",
    ]);
  });

  it("reports a failed action rather than staying silent about it", () => {
    const answer = renderAnswer(
      [
        {
          type: "action_executed",
          action: {
            actionId: "a-1",
            toolName: "create_item",
            ok: false,
            summary: "",
            error: "Сотрудник с таким логином уже есть",
          },
        },
      ],
      WEB,
    );

    expect(answer.text).toBe("⚠️ Не выполнено: Сотрудник с таким логином уже есть");
  });

  it("answers an error in the language the rest of the bot speaks", () => {
    // The stream writes for the panel, in English. This one fires whenever
    // somebody asks a second question while the first is still running.
    const answer = renderAnswer(
      [
        {
          type: "error",
          code: "rate_limited",
          message: "You already have a Copilot request running.",
        },
      ],
      WEB,
    );

    expect(answer.text).toBe("⚠️ Ещё отвечаю на прошлый вопрос. Подождите немного.");
  });

  it("falls back to what the stream said for an error it has no wording for", () => {
    const answer = renderAnswer(
      [{ type: "error", message: "Something specific happened" }],
      WEB,
    );

    expect(answer.text).toBe("⚠️ Something specific happened");
  });

  it("marks a reply the model had to cut off", () => {
    const answer = renderAnswer(
      [
        text("Начало ответа"),
        { type: "message_complete", messageId: "m1", stopReason: "max_tokens" },
      ],
      WEB,
    );

    expect(answer.text).toContain("обрезан");
  });
});

describe("splitMessage", () => {
  it("leaves a normal answer alone", () => {
    expect(splitMessage("Осталось 12 дней")).toEqual(["Осталось 12 дней"]);
  });

  it("splits a long answer on a line break, never mid-line", () => {
    const line = `${"x".repeat(99)}\n`;
    const parts = splitMessage(line.repeat(60));

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      // A split inside a line is what would tear a table column in half.
      expect(part.startsWith("x".repeat(99))).toBe(true);
      expect(part.endsWith("x".repeat(99))).toBe(true);
    }
  });

  it("still splits text that has no line breaks at all", () => {
    const parts = splitMessage("y".repeat(MESSAGE_LIMIT * 2 + 10));

    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= MESSAGE_LIMIT)).toBe(true);
  });

  it("closes and reopens a <pre> the split lands inside of", () => {
    // An unclosed tag is not cosmetic: Telegram refuses the part, and half the
    // answer disappears with nothing to explain it.
    const parts = splitMessage(`<pre>${`${"z".repeat(99)}\n`.repeat(60)}</pre>`);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      expect((part.match(/<pre>/g) ?? []).length).toBe(
        (part.match(/<\/pre>/g) ?? []).length,
      );
    }
  });
});
