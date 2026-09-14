import { CopilotKnowledgeTools } from "./knowledge.tools";
import { UcodeClient } from "../../ucode/ucode.client";
import type { CopilotConfig } from "../../config/configuration";
import type { CopilotTool, CopilotToolContext } from "./tool.types";
import type { UcodeItem } from "../../ucode/ucode.types";

const config: CopilotConfig = {
  port: 8080,
  corsOrigins: [],
  anthropicApiKey: null,
  model: "claude-sonnet-5",
  effort: "high",
  maxConcurrentStreams: 2,
  ucode: {
    baseUrl: "https://ucode.test",
    projectId: "project-1",
    environmentId: "env-1",
    serviceApiKey: null,
  },
  hrms: {
    employeeRoleId: "role-employee",
    clientTypeId: "client-type-1",
    reportsFunction: "reports-fn",
  },
};

const ctx: CopilotToolContext = {
  caller: { userId: "user-1", companiesId: "company-a", projectId: "project-1", token: "tok" },
  route: null,
};

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "33333333-3333-4333-8333-333333333333";

/** The fixture tree: root → child → grandchild, so a cascade has depth to walk. */
const ARTICLES: UcodeItem[] = [
  {
    guid: ROOT,
    knowledge_base_articles_id: null,
    title: "База знаний",
    icon: "🏠",
    content: JSON.stringify([{ type: "paragraph", content: "Начало" }]),
  },
  {
    guid: CHILD,
    knowledge_base_articles_id: ROOT,
    title: "Отпуска",
    icon: "🏖",
    content: JSON.stringify([{ type: "paragraph", content: "Старый текст" }]),
  },
  {
    guid: GRANDCHILD,
    knowledge_base_articles_id: CHILD,
    title: "Больничный",
    icon: "🤒",
    content: "",
  },
];

const stub = (): {
  tools: CopilotTool[];
  creates: Array<Record<string, unknown>>;
  updates: Array<{ guid: string; values: Record<string, unknown> }>;
  removed: string[];
} => {
  const client = new UcodeClient(config);
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<{ guid: string; values: Record<string, unknown> }> = [];
  const removed: string[] = [];

  jest.spyOn(client, "list").mockImplementation(async (_c, _table, query) =>
    (query.offset ?? 0) === 0
      ? { count: ARTICLES.length, response: ARTICLES }
      : { count: ARTICLES.length, response: [] },
  );
  jest
    .spyOn(client, "getOne")
    .mockImplementation(
      async (_c, _table, guid) => ARTICLES.find((a) => a.guid === guid) ?? null,
    );
  jest.spyOn(client, "create").mockImplementation(async (_c, _table, values) => {
    creates.push(values);
    return { guid: "new-article" };
  });
  jest.spyOn(client, "update").mockImplementation(async (_c, _table, guid, values) => {
    updates.push({ guid, values });
    return {};
  });
  jest.spyOn(client, "remove").mockImplementation(async (_c, _table, guid) => {
    removed.push(guid);
  });

  return {
    tools: new CopilotKnowledgeTools(client).getTools(),
    creates,
    updates,
    removed,
  };
};

const toolNamed = (tools: CopilotTool[], name: string): CopilotTool => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

// The whole reason this file exists instead of an entry in tables.yaml: the
// column holds a JSON *string*, and the read side answers anything else with an
// empty document — a write that puts an object there succeeds and leaves a blank
// page nobody notices until they open it.
describe("kb_write_article", () => {
  it("serializes the body and writes the real parent column", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "kb_write_article").execute(
      {
        title: "Онбординг",
        icon: "📘",
        parentId: ROOT,
        blocks: [
          { type: "heading", props: { level: 2 }, content: "Первый день" },
          { type: "bulletListItem", content: "Получить ноутбук" },
        ],
      },
      ctx,
    );

    expect(creates).toHaveLength(1);
    const row = creates[0];
    expect(row.title).toBe("Онбординг");
    expect(row.icon).toBe("📘");
    expect(row.knowledge_base_articles_id).toBe(ROOT);
    expect(row.parent_id).toBeUndefined();
    expect(typeof row.content).toBe("string");
    expect(JSON.parse(row.content as string)).toEqual([
      { type: "heading", props: { level: 2 }, content: "Первый день" },
      { type: "bulletListItem", content: "Получить ноутбук" },
    ]);
  });

  it("keeps the existing body when appending", async () => {
    const { tools, updates } = stub();

    await toolNamed(tools, "kb_write_article").execute(
      {
        guid: CHILD,
        append: true,
        blocks: [{ type: "paragraph", content: "Дополнение" }],
      },
      ctx,
    );

    expect(JSON.parse(updates[0].values.content as string)).toEqual([
      { type: "paragraph", content: "Старый текст" },
      { type: "paragraph", content: "Дополнение" },
    ]);
  });

  it("refuses a block type the editor does not have", async () => {
    const { tools } = stub();

    await expect(
      toolNamed(tools, "kb_write_article").execute(
        { title: "X", blocks: [{ type: "callout", content: "!" }] },
        ctx,
      ),
    ).rejects.toThrow(/callout/);
  });

  it("drops props the block schema does not define", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "kb_write_article").execute(
      {
        title: "X",
        blocks: [
          { type: "paragraph", props: { level: 9, colour: "red" }, content: "текст" },
        ],
      },
      ctx,
    );

    expect(JSON.parse(creates[0].content as string)).toEqual([
      { type: "paragraph", content: "текст" },
    ]);
  });

  // A cycle is a hung page, not a bad tree: the SPA walks parents upward to
  // build breadcrumbs and would never reach a root.
  it("refuses to file an article under its own descendant", async () => {
    const { tools } = stub();

    await expect(
      toolNamed(tools, "kb_write_article").execute(
        { guid: ROOT, parentId: GRANDCHILD },
        ctx,
      ),
    ).rejects.toThrow(/itself or under one of its own/);
  });

  // A well-formed guid that names nothing is exactly as broken as a title in
  // that slot: the page renders a "Подстатья удалена" card either way.
  it("refuses a pageLink that points at no real article", async () => {
    const { tools } = stub();

    await expect(
      toolNamed(tools, "kb_write_article").execute(
        {
          title: "X",
          blocks: [
            { type: "pageLink", props: { articleId: CHILD } },
            {
              type: "pageLink",
              props: { articleId: "44444444-4444-4444-8444-444444444444" },
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/44444444-4444-4444-8444-444444444444/);
  });

  it("keeps a pageLink to an article that exists", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "kb_write_article").execute(
      { title: "X", blocks: [{ type: "pageLink", props: { articleId: CHILD } }] },
      ctx,
    );

    expect(JSON.parse(creates[0].content as string)).toEqual([
      { type: "pageLink", props: { articleId: CHILD } },
    ]);
  });
});

// A child left behind points at a parent that is gone, and the tree is built by
// walking down from the roots — so it is not an orphan anyone can find.
describe("kb_delete_article", () => {
  it("takes the whole subtree, deepest first", async () => {
    const { tools, removed } = stub();

    const result = await toolNamed(tools, "kb_delete_article").execute(
      { guid: ROOT },
      ctx,
    );

    expect(removed).toEqual([GRANDCHILD, CHILD, ROOT]);
    expect(result.ok).toBe(true);
    expect((result.data as { childrenDeleted: number }).childrenDeleted).toBe(2);
  });
});

/**
 * Production answers this table's POST without a readable guid. Deciding from
 * that reply that nothing was written put two identical articles in the live
 * Knowledge Base: the person was told it failed, asked again, and the second
 * attempt worked exactly as well as the first.
 */
describe("kb_write_article when the create reply carries no id", () => {
  const stubWithout = (rows: UcodeItem[]) => {
    const client = new UcodeClient(config);
    jest.spyOn(client, "list").mockImplementation(async (_c, _t, query) =>
      (query.offset ?? 0) === 0
        ? { count: rows.length, response: rows }
        : { count: rows.length, response: [] },
    );
    jest
      .spyOn(client, "getOne")
      .mockImplementation(async (_c, _t, guid) => rows.find((a) => a.guid === guid) ?? null);
    // The shape that started it: 2xx, and nothing to read an id out of.
    jest.spyOn(client, "create").mockImplementation(async () => ({}));
    return new CopilotKnowledgeTools(client).getTools();
  };

  const RECOVERED = "44444444-4444-4444-8444-444444444444";

  it("finds the article it just wrote instead of reporting failure", async () => {
    const tools = stubWithout([
      ...ARTICLES,
      {
        guid: RECOVERED,
        knowledge_base_articles_id: ROOT,
        title: "Онбординг",
        icon: "📘",
        content: "[]",
      },
    ]);

    const result = await toolNamed(tools, "kb_write_article").execute(
      { title: "Онбординг", parentId: ROOT, blocks: [{ type: "paragraph", content: "Привет" }] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).guid).toBe(RECOVERED);
    // The link is the point of having the id at all.
    expect(result.links?.[0].href).toContain(RECOVERED);
  });

  it("does not mistake a same-titled article under another parent for its own", async () => {
    const tools = stubWithout([
      ...ARTICLES,
      {
        guid: RECOVERED,
        knowledge_base_articles_id: CHILD,
        title: "Онбординг",
        icon: "📘",
        content: "[]",
      },
    ]);

    await expect(
      toolNamed(tools, "kb_write_article").execute(
        { title: "Онбординг", parentId: ROOT, blocks: [] },
        ctx,
      ),
    ).rejects.toThrow(/probably created/);
  });

  it("warns about the duplicate a retry would make when it cannot confirm", async () => {
    const tools = stubWithout(ARTICLES);

    await expect(
      toolNamed(tools, "kb_write_article").execute({ title: "Пропавшая", blocks: [] }, ctx),
    ).rejects.toThrow(/duplicate/);
  });

  it("refuses to guess which of two same-titled siblings it just wrote", async () => {
    // The list arrives in whatever order the backend picked, so one of these is
    // the article we made and nothing here can say which. A guess that lands on
    // the older one links to the wrong page and the next edit rewrites it.
    const tools = stubWithout([
      ...ARTICLES,
      { guid: "dup-1", knowledge_base_articles_id: ROOT, title: "Онбординг", icon: "📘", content: "[]" },
      { guid: "dup-2", knowledge_base_articles_id: ROOT, title: "Онбординг", icon: "📘", content: "[]" },
    ]);

    await expect(
      toolNamed(tools, "kb_write_article").execute(
        { title: "Онбординг", parentId: ROOT, blocks: [] },
        ctx,
      ),
    ).rejects.toThrow(/probably created/);
  });
});

describe("kb_write_article: input the card should never be built for", () => {
  it("refuses a guid with nothing to change, before the card exists", async () => {
    const { tools } = stub();
    const write = toolNamed(tools, "kb_write_article");

    // summarize is what builds the confirmation card, so this is the assertion
    // that matters: the person is never asked to approve a no-op.
    await expect(write.summarize?.({ guid: CHILD }, ctx)).rejects.toThrow(
      /Nothing to change/,
    );
  });

  it("keeps a multi-codepoint emoji whole", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "kb_write_article").execute(
      { title: "Семья", icon: "👨‍👩‍👧‍👦", blocks: [] },
      ctx,
    );

    // Eleven UTF-16 units: a raw .slice() would have stored half a surrogate.
    expect(creates[0].icon).toBe("👨‍👩‍👧‍👦");
  });
});

describe("kb_delete_article: when the whole tree is not in reach", () => {
  /** A base bigger than one walk: the backend says 500, the walk stops at 300. */
  const hugeBase = (): CopilotTool[] => {
    const client = new UcodeClient(config);
    const rows: UcodeItem[] = Array.from({ length: 300 }, (_, i) => ({
      guid: `art-${i}`,
      knowledge_base_articles_id: null,
      title: `Статья ${i}`,
      icon: "📄",
      content: "[]",
    }));
    jest.spyOn(client, "list").mockImplementation(async (_c, _t, query) => ({
      count: 500,
      response: rows.slice(query.offset ?? 0, (query.offset ?? 0) + 100),
    }));
    jest
      .spyOn(client, "getOne")
      .mockImplementation(async (_c, _t, guid) => rows.find((a) => a.guid === guid) ?? null);
    jest.spyOn(client, "remove").mockResolvedValue(undefined);
    return new CopilotKnowledgeTools(client).getTools();
  };

  it("refuses rather than stranding the sub-articles it cannot see", async () => {
    await expect(
      toolNamed(hugeBase(), "kb_delete_article").execute({ guid: "art-1" }, ctx),
    ).rejects.toThrow(/cannot tell what is nested/);
  });

  it("reports the real total instead of the number it managed to list", async () => {
    const result = await toolNamed(hugeBase(), "kb_list_articles").execute({}, ctx);
    const data = result.data as Record<string, unknown>;

    expect(data.count).toBe(500);
    expect(data.listed).toBe(300);
    expect(data.partial).toContain("300 of 500");
  });
});

describe("kb_delete_article: a cascade that dies halfway", () => {
  it("says how many sub-articles are already gone", async () => {
    const client = new UcodeClient(config);
    jest.spyOn(client, "list").mockImplementation(async (_c, _t, query) =>
      (query.offset ?? 0) === 0
        ? { count: ARTICLES.length, response: ARTICLES }
        : { count: ARTICLES.length, response: [] },
    );
    jest
      .spyOn(client, "getOne")
      .mockImplementation(async (_c, _t, guid) => ARTICLES.find((a) => a.guid === guid) ?? null);
    // The grandchild goes; the child refuses.
    jest.spyOn(client, "remove").mockImplementation(async (_c, _t, guid) => {
      if (guid === CHILD) throw new Error("row is referenced elsewhere");
    });

    await expect(
      new CopilotKnowledgeTools(client)
        .getTools()
        .find((t) => t.name === "kb_delete_article")!
        .execute({ guid: ROOT }, ctx),
    ).rejects.toThrow(/Deleted 1 of 2 sub-article\(s\), then failed/);
  });
});
