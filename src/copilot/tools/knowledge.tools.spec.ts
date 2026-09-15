import { CopilotKnowledgeTools } from "./knowledge.tools";
import { clearFileIndex } from "./file-index";
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

// The point of kb_read_file: the article body holds a link, never the text
// inside the file, and the url it is asked to fetch is content someone else
// wrote — so only a url this article really carries, on the CDN, is fetched.
describe("kb_read_file", () => {
  const CDN = "https://cdn.u-code.io/knowledge-base/policy.csv";
  const WITH_FILE: UcodeItem = {
    guid: "44444444-4444-4444-8444-444444444444",
    knowledge_base_articles_id: null,
    title: "Регламент",
    icon: "📎",
    content: JSON.stringify([
      { type: "paragraph", content: "Подробности в файле" },
      {
        type: "bulletListItem",
        content: "Вложение",
        children: [{ type: "file", props: { url: CDN, name: "policy.csv" } }],
      },
    ]),
  };

  const tools = (): CopilotTool[] => {
    const client = new UcodeClient(config);
    jest
      .spyOn(client, "getOne")
      .mockImplementation(async (_c, _t, guid) =>
        guid === WITH_FILE.guid ? WITH_FILE : (ARTICLES.find((a) => a.guid === guid) ?? null),
      );
    jest
      .spyOn(client, "list")
      .mockImplementation(async (_c, _t, query) =>
        (query.offset ?? 0) === 0
          ? { count: 1, response: [WITH_FILE] }
          : { count: 1, response: [] },
      );
    return new CopilotKnowledgeTools(client).getTools();
  };

  // Restore rather than delete: `fetch` is a real own property of globalThis on
  // node 18+, so deleting it takes it away from every later test in this worker.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists a nested upload on the article and reads its text", async () => {
    const read = await toolNamed(tools(), "kb_read_article").execute(
      { guid: WITH_FILE.guid as string },
      ctx,
    );
    expect((read.data as Record<string, unknown>).files).toEqual([
      { url: CDN, name: "policy.csv" },
    ]);

    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      new Response("имя,отдел\nАли,HR", {
        status: 200,
        headers: { "content-type": "text/csv" },
      }),
    );

    const result = await toolNamed(tools(), "kb_read_file").execute(
      { guid: WITH_FILE.guid as string, url: CDN },
      ctx,
    );
    const document = result.blocks?.find((b) => b.type === "document");
    expect(document).toMatchObject({
      title: "policy.csv",
      source: { data: "имя,отдел\nАли,HR" },
    });
  });

  it("does not fetch a url the article does not carry", async () => {
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    await expect(
      toolNamed(tools(), "kb_read_file").execute(
        { guid: WITH_FILE.guid as string, url: "https://cdn.u-code.io/other/secret.pdf" },
        ctx,
      ),
    ).rejects.toThrow(/No file with that url/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The bug this pins: a file uploaded from a Mac is stored with its name
// decomposed (NFD), a model handed that url back writes it composed (NFC), and
// the two look identical while comparing unequal — so the article's own file
// was reported missing from the article. The fetch has to use the stored
// spelling either way: the CDN answers 404 for the composed one.
describe("kb_read_file: the same name, spelled two ways", () => {
  const NFD = "https://cdn.u-code.io/kb/Прайслист.pdf".normalize("NFD");
  const ARTICLE: UcodeItem = {
    guid: "55555555-5555-4555-8555-555555555555",
    knowledge_base_articles_id: null,
    title: "Прайс",
    icon: "💊",
    content: JSON.stringify([{ type: "file", props: { url: NFD, name: "Прайслист.pdf" } }]),
  };

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("matches the composed url and still fetches the stored one", async () => {
    const client = new UcodeClient(config);
    jest.spyOn(client, "getOne").mockResolvedValue(ARTICLE);
    const fetched: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
      fetched.push(url);
      return new Response("текст", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const result = await toolNamed(
      new CopilotKnowledgeTools(client).getTools(),
      "kb_read_file",
    ).execute(
      { guid: ARTICLE.guid as string, url: NFD.normalize("NFC") }, // what the model sends
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(fetched).toEqual([NFD]); // the stored spelling, not the model's
  });
});

// The miss this tool exists for: the answer to "как забронировать" is on page
// one of a PDF, in an article called «Прайс». No title matches, no body
// matches, and kb_list_articles reports a base with nothing on the subject.
describe("kb_search", () => {
  const FILE_URL = "https://cdn.u-code.io/kb/price.csv";
  const CORPUS: UcodeItem[] = [
    {
      guid: "aaaaaaaa-1111-4111-8111-111111111111",
      knowledge_base_articles_id: null,
      title: "Прайс",
      icon: "💊",
      content: JSON.stringify([
        { type: "paragraph", content: "Актуальный прайс поставщиков" },
        { type: "file", props: { url: FILE_URL, name: "price.csv" } },
      ]),
    },
    {
      guid: "bbbbbbbb-2222-4222-8222-222222222222",
      knowledge_base_articles_id: null,
      title: "Отпуска",
      icon: "🏖",
      content: JSON.stringify([
        {
          type: "bulletListItem",
          content: "Заявление подаётся за две недели",
          children: [{ type: "paragraph", content: "Отпуск согласует руководитель" }],
        },
      ]),
    },
  ];

  const realFetch = globalThis.fetch;
  const searchTool = (): CopilotTool => {
    const client = new UcodeClient(config);
    jest
      .spyOn(client, "list")
      .mockImplementation(async (_c, _t, query) =>
        (query.offset ?? 0) === 0
          ? { count: CORPUS.length, response: CORPUS }
          : { count: CORPUS.length, response: [] },
      );
    return toolNamed(new CopilotKnowledgeTools(client).getTools(), "kb_search");
  };

  beforeEach(() => {
    clearFileIndex();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      new Response("товар,цена\nКортипан,43557\n\nНомера телефонов для брони: +998 99 000-00-00", {
        status: 200,
        headers: { "content-type": "text/csv" },
      }),
    );
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("finds a subject that exists only inside an attached file", async () => {
    const result = await searchTool().execute({ query: "брон" }, ctx);
    const data = result.data as Record<string, unknown>;
    const hits = data.results as Array<Record<string, unknown>>;

    expect(hits).toHaveLength(1);
    expect(hits[0].guid).toBe(CORPUS[0].guid);
    expect(hits[0].where).toBe("файл «price.csv»");
    expect(hits[0].snippet).toContain("брони");
  });

  it("finds a body that no title mentions, through nesting", async () => {
    const hits = (
      (await searchTool().execute({ query: "руководител" }, ctx)).data as Record<
        string,
        unknown
      >
    ).results as Array<Record<string, unknown>>;

    expect(hits).toHaveLength(1);
    expect(hits[0].guid).toBe(CORPUS[1].guid);
    expect(hits[0].where).toBe("статья");
  });

  it("reads each file once however many searches run", async () => {
    const tool = searchTool();
    await tool.execute({ query: "брон" }, ctx);
    await tool.execute({ query: "кортипан" }, ctx);

    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  // The point of the button: "скинь прайс" is one search, not a megabyte of
  // PDF read into the conversation so the tool has something to link to.
  it("offers the matched file for download, from the search alone", async () => {
    const result = await searchTool().execute({ query: "брон" }, ctx);

    expect(result.links).toEqual([
      expect.objectContaining({
        label: "Скачать «price.csv»",
        href: FILE_URL,
        external: true,
      }),
    ]);
  });

  // The regression: «прайс» matches the title and «кортипан» the PDF, one term
  // each, and the article's own haystack wins the tie — so the file lost its
  // button in exactly the case people ask about most.
  it("still offers the file when the snippet came from the article", async () => {
    const result = await searchTool().execute({ query: "прайс" }, ctx);
    const hit = (result.data as { results: Array<Record<string, unknown>> }).results[0];

    expect(hit.where).toBe("статья");
    expect(result.links).toEqual([
      expect.objectContaining({ label: "Скачать «price.csv»", href: FILE_URL }),
    ]);
  });

  it("offers nothing to download when the hit was in the article itself", async () => {
    const result = await searchTool().execute({ query: "руководител" }, ctx);
    expect(result.links).toEqual([]);
  });

  // Saying "nothing found" is only safe if the model knows how the matching
  // works — otherwise it reports an absence that is really a word form.
  it("tells the model to retry with roots instead of declaring absence", async () => {
    const data = (await searchTool().execute({ query: "забронировать" }, ctx))
      .data as Record<string, unknown>;

    expect(data.results).toEqual([]);
    expect(String(data.note)).toMatch(/shorter roots/);
  });
});

// The shape the tree actually has: «Аллерайз» holds three files of its own and
// two folders holding five more. Asked for "файлы по Аллерайз", a person means
// all eight — the folders are not other subjects, they are where the rest of
// the same subject lives.
describe("kb_search: an article is its subtree", () => {
  const ALLERAYZ = "aaaaaaaa-0000-4000-8000-000000000001";
  const file = (name: string) => ({
    type: "file",
    props: { url: `https://cdn.u-code.io/kb/${encodeURIComponent(name)}`, name },
  });
  const TREE: UcodeItem[] = [
    {
      guid: ALLERAYZ,
      knowledge_base_articles_id: null,
      title: "Аллерайз",
      icon: "💊",
      content: JSON.stringify([
        file("allerayz-ru.png"),
        file("PD Allerayz rus.docx"),
        file("PD Allerayz uzb.docx"),
      ]),
    },
    {
      guid: "bbbbbbbb-0000-4000-8000-000000000002",
      knowledge_base_articles_id: ALLERAYZ,
      title: "Инструкции",
      icon: "📁",
      content: JSON.stringify([
        file("Instruction Allerayz rus.pdf"),
        file("Instruction Allerayz uzb.pdf"),
      ]),
    },
    {
      guid: "cccccccc-0000-4000-8000-000000000003",
      knowledge_base_articles_id: ALLERAYZ,
      title: "Презентации",
      icon: "📁",
      content: JSON.stringify([
        file("Presentation Allerayz MP rus.pptx"),
        file("Presentation Allerayz obshaya rus.pptx"),
        file("Аллерайз общая.pdf"),
      ]),
    },
  ];

  const realFetch = globalThis.fetch;
  const tool = (): CopilotTool => {
    const client = new UcodeClient(config);
    jest
      .spyOn(client, "list")
      .mockImplementation(async (_c, _t, q) =>
        (q.offset ?? 0) === 0
          ? { count: TREE.length, response: TREE }
          : { count: TREE.length, response: [] },
      );
    return toolNamed(new CopilotKnowledgeTools(client).getTools(), "kb_search");
  };

  beforeEach(() => {
    clearFileIndex();
    // Nothing readable — the point is that names and the tree carry this on
    // their own, without a byte being downloaded.
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      new Response("", { status: 404 }),
    );
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("offers every file under the article, not only its own three", async () => {
    const result = await tool().execute({ query: "аллерайз" }, ctx);
    const labels = (result.links ?? []).map((l) => l.label);

    expect(labels).toHaveLength(8);
    expect(labels).toContain("Скачать «Instruction Allerayz rus.pdf»");
    expect(labels).toContain("Скачать «Presentation Allerayz MP rus.pptx»");
  });

  // The regression the other way: «ПД файлы для группы офта» holds one file per
  // drug, and it matches «Аллерайз» only because one of those files is named
  // after it. Handing over its neighbours — Новосалик, Вегтазон, Сетимед —
  // answers a question nobody asked.
  it("offers only the file that matched when the article itself did not", async () => {
    const PD = "dddddddd-0000-4000-8000-000000000004";
    const client = new UcodeClient(config);
    const corpus: UcodeItem[] = [
      ...TREE,
      {
        guid: PD,
        knowledge_base_articles_id: null,
        title: "ПД файлы для группы офта",
        icon: "📁",
        content: JSON.stringify([
          file("ПД файл Новосалик.docx"),
          file("ПД Аллерайз узб вариант.docx"),
          file("ПД файл Вегтазон.docx"),
        ]),
      },
    ];
    jest
      .spyOn(client, "list")
      .mockImplementation(async (_c, _t, q) =>
        (q.offset ?? 0) === 0
          ? { count: corpus.length, response: corpus }
          : { count: corpus.length, response: [] },
      );

    const result = await toolNamed(
      new CopilotKnowledgeTools(client).getTools(),
      "kb_search",
    ).execute({ query: "аллерайз" }, ctx);
    const labels = (result.links ?? []).map((l) => l.label);

    expect(labels).toContain("Скачать «ПД Аллерайз узб вариант.docx»");
    expect(labels).not.toContain("Скачать «ПД файл Новосалик.docx»");
    expect(labels).not.toContain("Скачать «ПД файл Вегтазон.docx»");
    // The article that really is about Аллерайз still brings its whole subtree.
    expect(labels).toContain("Скачать «Instruction Allerayz rus.pdf»");
  });

  it("says which sub-article a file came from", async () => {
    const hit = (
      (await tool().execute({ query: "аллерайз" }, ctx)).data as {
        results: Array<{ files: Array<Record<string, unknown>> }>;
      }
    ).results[0];

    expect(hit.files).toContainEqual(
      expect.objectContaining({ name: "Instruction Allerayz rus.pdf", article: "Инструкции" }),
    );
    expect(hit.files[0].article).toBeUndefined(); // the article's own file
  });

  // A .docx or .pptx has no reader here, and a 404 file has nothing to read —
  // the name is all there is, and it is enough to find the thing.
  it("finds a file by its name with nothing downloaded", async () => {
    const hits = (
      (await tool().execute({ query: "presentation" }, ctx)).data as {
        results: Array<Record<string, unknown>>;
      }
    ).results;

    expect(hits).toHaveLength(1);
    expect(hits[0].where).toBe("файл «Presentation Allerayz MP rus.pptx»");
  });
});
