import { randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import { UcodeClient } from "../../ucode/ucode.client";
import type { UcodeItem } from "../../ucode/ucode.types";
import type { CopilotFieldChange, CopilotLink } from "../types/copilot.types";
import {
  CopilotToolError,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  requireString,
} from "./tool-support";
import type {
  CopilotTool,
  CopilotToolContext,
  CopilotToolGroup,
} from "./tool.types";

/**
 * The Knowledge Base: a Notion-like tree of articles the company writes for
 * itself (`/knowledge-base` in the SPA, `src/modules/KnowledgeBase`).
 *
 * Why these four tools instead of putting `knowledge_base_articles` in the
 * Allowlist and letting create_item write it: an article is not a row of
 * columns. Its body is a BlockNote document that the column holds as a JSON
 * *string*, and `parseContent` on the read side answers anything it cannot
 * parse with an empty document — so a generic write puts an object in that
 * column, the write succeeds, the model says "готово", and the person opens a
 * blank page. Three more things a generic write gets wrong the same silent way:
 * the parent column is `knowledge_base_articles_id` (the list method aliases it
 * to `parent_id`, which is the name a model would reach for), the icon is its
 * own emoji column rather than part of the body, and deleting an article has to
 * take its whole subtree with it — a child left behind still points at a parent
 * that is gone, which is not an orphan anyone can find, because the tree is
 * built by walking down from the roots.
 *
 * Same reasoning as `employee_works` in mutation.tools.ts: the table stays out
 * of the Allowlist on purpose. Serializing the body, mapping the parent column
 * and cascading the delete are not things the model should have to know — they
 * are what "write an article" means here.
 */
@Injectable()
export class CopilotKnowledgeTools implements CopilotToolGroup {
  constructor(private readonly ucode: UcodeClient) {}

  getTools(): CopilotTool[] {
    return [
      this.listArticles(),
      this.readArticle(),
      this.writeArticle(),
      this.deleteArticle(),
    ];
  }

  // ─── kb_list_articles ─────────────────────────────────────────────────────

  private listArticles(): CopilotTool {
    return {
      name: "kb_list_articles",
      description:
        "List every Knowledge Base article the company has, as a flat list with parentId — the tree the person sees in the sidebar of /knowledge-base. Call this first for anything about the Knowledge Base: the guids it returns are what kb_read_article, kb_write_article and kb_delete_article take, and it is the only way to tell whether an article on a subject already exists. Bodies are NOT included — use kb_read_article for one article's text.",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, ctx) => {
        const { articles, total } = await this.fetchAll(ctx);
        return {
          ok: true,
          summary: `${total} ${plural(total, "статья", "статьи", "статей")} в базе знаний`,
          data: {
            count: total,
            listed: articles.length,
            articles: articles.map((a) => ({
              guid: a.guid,
              title: a.title,
              icon: a.icon,
              parentId: a.parentId,
            })),
            // Without this the model reads the array's length as the count and
            // states it as fact — "в базе 300 статей" about a base of 412.
            ...(articles.length < total
              ? {
                  partial: `Only ${articles.length} of ${total} articles are listed. Do not state the listed number as the total, and do not conclude an article is absent because it is not here.`,
                }
              : {}),
            note: "parentId null means a top-level article. An article's children are the ones whose parentId is its guid.",
          },
        };
      },
    };
  }

  // ─── kb_read_article ──────────────────────────────────────────────────────

  private readArticle(): CopilotTool {
    return {
      name: "kb_read_article",
      description:
        "Read one Knowledge Base article: its title, icon and full body as blocks, plus its direct sub-articles. Read before you rewrite — kb_write_article replaces the whole body, so the blocks this returns are what you edit and send back.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "Article id, from kb_list_articles.",
          },
        },
        required: ["guid"],
      },
      execute: async (input, ctx) => {
        const guid = requireString(input.guid, "guid");
        const row = await this.requireArticle(ctx, guid);
        const { articles } = await this.fetchAll(ctx);
        const blocks = parseContent(row.content);
        const { kept, truncated } = capBlocks(blocks);

        return {
          ok: true,
          summary: `Статья «${title(row)}»`,
          data: {
            guid,
            title: title(row),
            icon: readString(row.icon) ?? DEFAULT_ICON,
            parentId: readString(row[PARENT_COLUMN]) ?? null,
            blocks: kept,
            ...(truncated
              ? {
                  truncated: `Only the first ${kept.length} of ${blocks.length} blocks are shown — the article is too long to hand over whole. Do NOT rewrite it from this: a replace built on a truncated body would delete the rest.`,
                }
              : {}),
            children: articles
              .filter((a) => a.parentId === guid)
              .map((a) => ({ guid: a.guid, title: a.title, icon: a.icon })),
          },
          links: [articleLink(guid, title(row))],
        };
      },
    };
  }

  // ─── kb_write_article ─────────────────────────────────────────────────────

  private writeArticle(): CopilotTool {
    return {
      name: "kb_write_article",
      description:
        "Create a Knowledge Base article, or change an existing one. Leave guid out to create; pass it to update. Blocks REPLACE the whole body, so call kb_read_article first and send the full new body back — unless you pass append: true, which adds your blocks to the end instead. Do not ask the person to confirm: calling this shows them a card with the before and after, and nothing is written until they approve it.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description:
              "Article to change, from kb_list_articles. Omit to create a new one.",
          },
          title: {
            type: "string",
            description: "Article title. Required when creating.",
          },
          icon: {
            type: "string",
            description: `One emoji, shown beside the title in the tree and above the article. Pick one that fits the subject — 📘 for a guide, 🏖 for leave, 💰 for pay. Defaults to ${DEFAULT_ICON}.`,
          },
          parentId: {
            type: "string",
            description:
              "Guid of the article this one sits under, making it a sub-page. Omit or send null for a top-level article. Sub-articles appear nested in the tree on their own — a pageLink block is only needed to also link one from inside the parent's text.",
          },
          blocks: {
            type: "array",
            description: BLOCKS_DESCRIPTION,
            items: { type: "object" },
          },
          append: {
            type: "boolean",
            description:
              "Add the blocks to the end of the existing body instead of replacing it. Use this to extend a long article without resending it.",
          },
        },
      },
      summarize: async (input, ctx) => {
        const plan = await this.plan(input, ctx);
        const changes: CopilotFieldChange[] = [];

        if (plan.current) {
          const before = {
            title: title(plan.current),
            icon: readString(plan.current.icon) ?? DEFAULT_ICON,
            blocks: parseContent(plan.current.content),
          };
          if (plan.title !== undefined && plan.title !== before.title) {
            changes.push({
              field: "title",
              label: "Заголовок",
              before: before.title,
              after: plan.title,
            });
          }
          if (plan.icon !== undefined && plan.icon !== before.icon) {
            changes.push({
              field: "icon",
              label: "Иконка",
              before: before.icon,
              after: plan.icon,
            });
          }
          if (plan.blocks) {
            changes.push({
              field: "content",
              label: "Текст",
              before: `${before.blocks.length} ${plural(before.blocks.length, "блок", "блока", "блоков")}`,
              after: `${plan.finalBlocks.length} ${plural(plan.finalBlocks.length, "блок", "блока", "блоков")} — ${outline(plan.blocks)}`,
            });
          }
          if (plan.parentId !== undefined) {
            changes.push({
              field: "parent",
              label: "Родитель",
              before: plan.parentBefore,
              after: plan.parentAfter,
            });
          }
        } else {
          changes.push({
            field: "title",
            label: "Заголовок",
            before: null,
            after: `${plan.icon ?? DEFAULT_ICON} ${plan.title ?? ""}`.trim(),
          });
          if (plan.parentAfter) {
            changes.push({
              field: "parent",
              label: "Родитель",
              before: null,
              after: plan.parentAfter,
            });
          }
          changes.push({
            field: "content",
            label: "Текст",
            before: null,
            after:
              plan.finalBlocks.length > 0
                ? `${plan.finalBlocks.length} ${plural(plan.finalBlocks.length, "блок", "блока", "блоков")} — ${outline(plan.finalBlocks)}`
                : "пустая статья",
          });
        }

        return plan.current
          ? {
              title: `Изменить статью «${title(plan.current)}»?`,
              description:
                plan.blocks && !plan.append
                  ? "Текст статьи будет заменён целиком."
                  : "Изменит статью в базе знаний.",
              changes,
            }
          : {
              title: `Создать статью «${plan.title ?? ""}»?`,
              description: "Добавит новую статью в базу знаний.",
              changes,
            };
      },
      execute: async (input, ctx) => {
        const plan = await this.plan(input, ctx);

        if (!plan.current) {
          const created = await this.ucode.create(ctx.caller, TABLE, {
            [PARENT_COLUMN]: plan.parentId ?? null,
            title: plan.title,
            icon: plan.icon ?? DEFAULT_ICON,
            // Serialized here and nowhere else: the column is a varchar and the
            // SPA parses it back with JSON.parse.
            content: serializeContent(plan.finalBlocks),
          });
          // ucode answers this table's POST with an envelope UcodeClient finds
          // no guid in, and the row is there all the same. Concluding "not
          // created" from the shape of a reply rather than from the data cost
          // two duplicate articles in production: the person was told nothing
          // happened, the model dutifully tried again, and only a look in the
          // Knowledge Base showed both attempts had worked.
          const guid =
            readString(created.guid) ??
            (await this.findJustCreated(ctx, plan.title, plan.parentId ?? null));

          if (!guid) {
            throw new CopilotToolError(
              "The article was probably created, but its id could not be read back and it could not be found by title. Tell the person to check the Knowledge Base before asking again — a second attempt would file a duplicate.",
            );
          }
          return {
            ok: true,
            summary: `Создана статья «${plan.title}»`,
            data: { guid, title: plan.title, blocks: plan.finalBlocks.length },
            links: [articleLink(guid, plan.title ?? "")],
          };
        }

        const values: Record<string, unknown> = {};
        if (plan.title !== undefined) values.title = plan.title;
        if (plan.icon !== undefined) values.icon = plan.icon;
        if (plan.parentId !== undefined) values[PARENT_COLUMN] = plan.parentId;
        if (plan.blocks) values.content = serializeContent(plan.finalBlocks);

        await this.ucode.update(ctx.caller, TABLE, plan.guid as string, values);
        const name = plan.title ?? title(plan.current);
        return {
          ok: true,
          summary: `Изменена статья «${name}»`,
          data: {
            guid: plan.guid,
            changed: Object.keys(values),
            blocks: plan.blocks ? plan.finalBlocks.length : undefined,
          },
          links: [articleLink(plan.guid as string, name)],
        };
      },
    };
  }

  // ─── kb_delete_article ────────────────────────────────────────────────────

  private deleteArticle(): CopilotTool {
    return {
      name: "kb_delete_article",
      description:
        "Delete a Knowledge Base article together with every article nested under it. Say how many sub-articles go with it before you call this. Do not ask the person to confirm: calling this shows them a confirmation card automatically.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "Article id, from kb_list_articles.",
          },
        },
        required: ["guid"],
      },
      summarize: async (input, ctx) => {
        const guid = requireString(input.guid, "guid");
        const row = await this.requireArticle(ctx, guid);
        const doomed = descendants(await this.wholeTree(ctx), guid);
        return {
          title: `Удалить статью «${title(row)}»?`,
          description:
            doomed.length > 0
              ? `Вместе с ней будут удалены вложенные статьи: ${doomed.length}.`
              : "Удалит статью из базы знаний.",
          ...(doomed.length > 0
            ? {
                changes: doomed.slice(0, MAX_PREVIEW).map((a, i) => ({
                  field: `child-${i}`,
                  label: String(i + 1),
                  before: `${a.icon} ${a.title}`,
                  after: null,
                })),
              }
            : {}),
        };
      },
      execute: async (input, ctx) => {
        const guid = requireString(input.guid, "guid");
        const row = await this.requireArticle(ctx, guid);
        const all = await this.wholeTree(ctx);
        // Deepest first, parent last: a run that dies halfway leaves a subtree
        // that is still reachable from above. The other order strands children
        // under a parent that no longer exists, and the tree is built by walking
        // down from the roots — nothing in the UI would ever show them again.
        const doomed = descendants(all, guid).sort((a, b) => b.depth - a.depth);

        let removed = 0;
        try {
          for (const child of doomed) {
            await this.ucode.remove(ctx.caller, TABLE, child.guid);
            removed++;
          }
          await this.ucode.remove(ctx.caller, TABLE, guid);
        } catch (e) {
          // A half-done cascade reported as a plain failure reads as "nothing
          // happened", and the sub-articles it did remove are already gone.
          throw new CopilotToolError(
            `Deleted ${removed} of ${doomed.length} sub-article(s), then failed: ${reason(e)}. «${title(row)}» itself is still there, so what is left is still reachable. Say exactly this to the person; do not retry on your own.`,
          );
        }

        return {
          ok: true,
          summary: `Удалена статья «${title(row)}»`,
          data: { guid, deleted: true, childrenDeleted: removed },
        };
      },
    };
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  /**
   * Everything `kb_write_article` needs, resolved once so `summarize` shows the
   * person exactly what `execute` will do. Both call it: a card built from a
   * different reading of the input than the write is a card that lies.
   */
  private async plan(
    input: Record<string, unknown>,
    ctx: CopilotToolContext,
  ): Promise<WritePlan> {
    const guid = readString(input.guid);
    const title = readString(input.title);
    // By code point, not by string index: an emoji is several UTF-16 units and
    // a family emoji is eleven, so slicing the raw string cuts one in half and
    // stores a lone surrogate where the icon should be.
    const rawIcon = readString(input.icon);
    const icon =
      rawIcon === undefined
        ? undefined
        : [...rawIcon].slice(0, MAX_ICON_CHARS).join("");
    const append = readBoolean(input.append) === true;
    const blocks =
      input.blocks === undefined ? undefined : normalizeBlocks(input.blocks, 0);

    // `null` is how the model clears a parent, and undefined is "leave it".
    const parentGiven = "parentId" in input && input.parentId !== undefined;
    const parentId = parentGiven ? (readString(input.parentId) ?? null) : undefined;

    const current = guid ? await this.requireArticle(ctx, guid) : null;
    if (!current && !title) {
      throw new CopilotToolError(
        "A new article needs a title. To change an existing one, pass its guid.",
      );
    }
    if (!current && append) {
      throw new CopilotToolError(
        "append only applies to an existing article — pass its guid, or leave append out to create one.",
      );
    }
    // Caught here rather than in execute, or a guid with nothing beside it
    // shows the person a confirmation card for a change that then refuses to
    // happen — they approve, and the answer is an error.
    if (
      current &&
      title === undefined &&
      icon === undefined &&
      parentId === undefined &&
      blocks === undefined
    ) {
      throw new CopilotToolError(
        "Nothing to change — send a title, an icon, a parentId or blocks.",
      );
    }

    // Fetched at most once per call, and only when something actually needs the
    // tree — a plain "rewrite this article" should not list the whole base.
    let cached: ArticleSummary[] | null = null;
    const tree = async (): Promise<ArticleSummary[]> =>
      (cached ??= (await this.fetchAll(ctx)).articles);

    let parentBefore: string | null = null;
    let parentAfter: string | null = null;
    if (parentId !== undefined) {
      const all = await tree();
      if (parentId) {
        const parent = all.find((a) => a.guid === parentId);
        if (!parent) {
          throw new CopilotToolError(
            `No article ${parentId} in the Knowledge Base. Call kb_list_articles and use a guid from it — an article filed under a parent that does not exist is unreachable in the tree.`,
          );
        }
        // A cycle is not a bad tree, it is a hung page: the SPA walks parents up
        // from an article to build its breadcrumbs and would never reach a root.
        if (guid && (parentId === guid || descendants(all, guid).some((d) => d.guid === parentId))) {
          throw new CopilotToolError(
            "An article cannot be moved under itself or under one of its own sub-articles.",
          );
        }
        parentAfter = `${parent.icon} ${parent.title}`;
      }
      if (current) {
        const before = readString(current[PARENT_COLUMN]);
        const row = before ? all.find((a) => a.guid === before) : undefined;
        parentBefore = row ? `${row.icon} ${row.title}` : null;
      }
    }

    const existing = current ? parseContent(current.content) : [];
    const finalBlocks = blocks
      ? append
        ? [...existing, ...blocks]
        : blocks
      : existing;

    // A pageLink pointing at an article that is not there renders as
    // "Подстатья удалена" — a dead card on a page the Copilot just said it
    // wrote. Checked against the real tree rather than the shape of the id,
    // because a guid that is merely well-formed is exactly as broken.
    const linked = pageLinkIds(finalBlocks);
    if (linked.length > 0) {
      const known = new Set((await tree()).map((a) => a.guid));
      const missing = linked.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new CopilotToolError(
          `These pageLink blocks point at articles that do not exist: ${missing.join(", ")}. Create the sub-article first and link it by the guid kb_write_article returns.`,
        );
      }
    }

    const serialized = serializeContent(finalBlocks);
    if (serialized.length > MAX_CONTENT_CHARS) {
      throw new CopilotToolError(
        `That body is ${serialized.length} characters, over the ${MAX_CONTENT_CHARS} one article holds. Split it into sub-articles.`,
      );
    }

    return {
      guid,
      current,
      title,
      icon,
      parentId,
      parentBefore,
      parentAfter,
      blocks,
      append,
      finalBlocks,
    };
  }

  /**
   * The tree, or nothing — for the one caller that cannot work with part of it.
   *
   * A cascading delete decides what to remove by walking down from the article,
   * so a child that fell outside the fetched window is not deleted and is not
   * reported: it keeps pointing at a parent that no longer exists, and the UI
   * builds the tree from the roots down, so nobody ever sees it again. Refusing
   * is the only honest option left once the base outgrows one fetch.
   */
  private async wholeTree(ctx: CopilotToolContext): Promise<ArticleSummary[]> {
    const { articles, total } = await this.fetchAll(ctx);
    if (articles.length < total) {
      throw new CopilotToolError(
        `The Knowledge Base has ${total} articles and the Copilot can only read ${articles.length} of them at once, so it cannot tell what is nested under this one. Deleting it here could leave sub-articles stranded — delete it from /knowledge-base instead.`,
      );
    }
    return articles;
  }

  /** The article, or an error the model can act on. Tenant check lives in getOne. */
  private async requireArticle(
    ctx: CopilotToolContext,
    guid: string,
  ): Promise<UcodeItem> {
    const row = await this.ucode.getOne(ctx.caller, TABLE, guid);
    if (!row) {
      throw new CopilotToolError(
        `No Knowledge Base article ${guid} that you can access. Call kb_list_articles for the real guids.`,
      );
    }
    return row;
  }

  /**
   * The id of the article just written, when the create reply did not carry one.
   *
   * Only an unambiguous match counts. Two articles of the same title under the
   * same parent cannot be told apart here: the list arrives in whatever order
   * the backend chooses, so picking one of them is a coin toss, and the wrong
   * guid is worse than none — it links to the wrong page and the next edit
   * rewrites an article nobody asked about. Returning null is not a failure to
   * create, it is a failure to confirm, and the caller says so in those words.
   */
  private async findJustCreated(
    ctx: CopilotToolContext,
    articleTitle: string | undefined,
    parentId: string | null,
  ): Promise<string | null> {
    if (!articleTitle) return null;
    try {
      const { articles } = await this.fetchAll(ctx);
      const matches = articles.filter(
        (a) => a.title === articleTitle && a.parentId === parentId,
      );
      return matches.length === 1 ? matches[0].guid : null;
    } catch {
      // The lookup is a second chance, not the answer; its own failure must not
      // replace the more useful message the caller is about to write.
      return null;
    }
  }

  /**
   * Every article as a flat summary, with the real total beside it. Bodies are
   * dropped here rather than in the query because the items API has no column
   * projection — the rows arrive with their content either way.
   *
   * `total` is what the backend says exists, which is not always what came
   * back: the walk stops at MAX_ARTICLES. Callers have to compare the two,
   * because every one of them means something different by a partial tree — a
   * listing can say so, a cascading delete cannot proceed at all.
   *
   * ponytail: no search endpoint. A base past this size needs one; a bigger
   * loop here would just move the cliff.
   */
  private async fetchAll(
    ctx: CopilotToolContext,
  ): Promise<{ articles: ArticleSummary[]; total: number }> {
    const out: ArticleSummary[] = [];
    let total = 0;
    let offset = 0;
    for (;;) {
      const page = await this.ucode.list(ctx.caller, TABLE, {
        limit: PAGE_SIZE,
        offset,
      });
      total = Math.max(total, page.count);
      for (const row of page.response) {
        const guid = readString(row.guid);
        if (!guid) continue;
        out.push({
          guid,
          parentId: readString(row[PARENT_COLUMN]) ?? null,
          title: title(row),
          icon: readString(row.icon) ?? DEFAULT_ICON,
        });
      }
      offset += PAGE_SIZE;
      if (
        page.response.length < PAGE_SIZE ||
        out.length >= page.count ||
        out.length >= MAX_ARTICLES
      ) {
        break;
      }
    }
    return { articles: out, total: Math.max(total, out.length) };
  }
}

// ─── Table shape ────────────────────────────────────────────────────────────

const TABLE = "knowledge_base_articles";
/**
 * The self-relation column. u-code named it after the table, and the SPA's list
 * method aliases it to `parent_id` — which is the name that looks right and
 * writes nothing, because the items API takes the real column.
 */
const PARENT_COLUMN = "knowledge_base_articles_id";

const DEFAULT_ICON = "📄";
const PAGE_SIZE = 100;
const MAX_ARTICLES = 300;
/** Blocks one read hands the model. A long article is context, not an answer. */
const MAX_READ_BLOCKS = 120;
const MAX_CONTENT_CHARS = 200_000;
const MAX_ICON_CHARS = 8;
const MAX_BLOCK_DEPTH = 3;
const MAX_PREVIEW = 10;

interface ArticleSummary {
  guid: string;
  parentId: string | null;
  title: string;
  icon: string;
}

interface WritePlan {
  guid: string | undefined;
  current: UcodeItem | null;
  title: string | undefined;
  icon: string | undefined;
  parentId: string | null | undefined;
  parentBefore: string | null;
  parentAfter: string | null;
  blocks: Block[] | undefined;
  append: boolean;
  finalBlocks: Block[];
}

// ─── The document ───────────────────────────────────────────────────────────

type Block = Record<string, unknown>;

/**
 * Block types the Copilot may write.
 *
 * A subset of BlockNote's defaults on purpose: image / video / audio / file need
 * an upload the Copilot cannot do, and `table` has its own nested content model.
 * ponytail: add `table` when someone asks for one — it is a content shape, not a
 * new mechanism.
 */
const BLOCK_PROPS: Record<string, string[]> = {
  paragraph: [],
  heading: ["level"],
  bulletListItem: [],
  numberedListItem: ["start"],
  checkListItem: ["checked"],
  toggleListItem: [],
  quote: [],
  codeBlock: ["language"],
  divider: [],
  pageLink: ["articleId"],
};

/** Blocks that hold no text — content on one of these is dropped, not an error. */
const VOID_BLOCKS = new Set(["divider", "pageLink"]);

const BLOCKS_DESCRIPTION = `The article body, in the exact format the Knowledge Base editor stores — a list of BlockNote blocks, each {type, props?, content?, children?}.
Types: ${Object.keys(BLOCK_PROPS).join(", ")}. heading takes props.level 1-3; checkListItem props.checked; codeBlock props.language; pageLink props.articleId, which renders a card linking to another article.
content is the text: a plain string for plain text, or an array of runs for formatting — [{"type":"text","text":"важно","styles":{"bold":true}},{"type":"link","href":"https://…","content":"ссылка"}]. divider and pageLink take no content.
Nest a sub-list under an item with children. Write it the way a page in Notion reads: a heading, short paragraphs, lists — not one long paragraph.`;

/** Every article a document links to, including from inside nested blocks. */
const pageLinkIds = (blocks: Block[]): string[] => {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "pageLink") {
      const id = readString(readRecord(block.props)?.articleId);
      if (id) out.push(id);
    }
    const children = readArray(block.children);
    if (children) out.push(...pageLinkIds(children as Block[]));
  }
  return out;
};

/**
 * Turns what the model sent into a document the editor can actually open.
 *
 * Unknown props are dropped rather than passed through: BlockNote validates a
 * block against its schema when it loads one, and a stray prop is a page that
 * fails to render — which nobody finds out about until someone opens the
 * article, long after the Copilot said it was written.
 */
const normalizeBlocks = (value: unknown, depth: number): Block[] => {
  const list = readArray(value);
  if (!list) {
    throw new CopilotToolError('Field "blocks" must be an array of blocks.');
  }
  if (depth > MAX_BLOCK_DEPTH) {
    throw new CopilotToolError(
      `Blocks are nested more than ${MAX_BLOCK_DEPTH} deep. Use a sub-article instead.`,
    );
  }

  return list.map((raw, i) => {
    const block = readRecord(raw);
    if (!block) {
      throw new CopilotToolError(`Block ${i + 1} is not an object.`);
    }
    const type = readString(block.type);
    if (!type || !(type in BLOCK_PROPS)) {
      throw new CopilotToolError(
        `Block ${i + 1} has type "${type ?? "?"}", which the Knowledge Base does not have. Types: ${Object.keys(BLOCK_PROPS).join(", ")}.`,
      );
    }

    const out: Block = { type };
    const props = normalizeProps(type, readRecord(block.props), i);
    if (Object.keys(props).length > 0) out.props = props;
    if (!VOID_BLOCKS.has(type)) {
      out.content = normalizeContent(block.content, i);
    }
    if (block.children !== undefined) {
      const children = normalizeBlocks(block.children, depth + 1);
      if (children.length > 0) out.children = children;
    }
    return out;
  });
};

const normalizeProps = (
  type: string,
  props: Record<string, unknown> | undefined,
  index: number,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (type === "heading") {
    // ponytail: 1-3, which is what the editor's slash menu offers and what the
    // existing articles use. Raise the ceiling if someone writes an H4.
    const level = readNumber(props?.level) ?? 2;
    out.level = Math.min(3, Math.max(1, Math.round(level)));
  }
  if (type === "checkListItem") {
    out.checked = readBoolean(props?.checked) ?? false;
  }
  if (type === "codeBlock") {
    const language = readString(props?.language);
    if (language) out.language = language;
  }
  if (type === "numberedListItem") {
    const start = readNumber(props?.start);
    if (start !== undefined) out.start = start;
  }
  if (type === "pageLink") {
    const articleId = readString(props?.articleId);
    if (!articleId) {
      throw new CopilotToolError(
        `Block ${index + 1} is a pageLink with no props.articleId. It has to name the article it links to — create the sub-article first, then link it, or drop the block, since sub-articles already appear in the tree.`,
      );
    }
    out.articleId = articleId;
  }
  return out;
};

/** Inline content: a plain string, or the styled runs BlockNote stores. */
const normalizeContent = (value: unknown, index: number): unknown => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;

  const runs = readArray(value);
  if (!runs) {
    throw new CopilotToolError(
      `Block ${index + 1}: content must be a string or an array of text runs.`,
    );
  }
  return runs.map((raw) => {
    const run = readRecord(raw);
    const type = readString(run?.type);
    if (!run || (type !== "text" && type !== "link")) {
      throw new CopilotToolError(
        `Block ${index + 1}: every run in content must be {"type":"text",...} or {"type":"link",...}.`,
      );
    }
    if (type === "link") {
      const href = readString(run.href);
      if (!href) {
        throw new CopilotToolError(`Block ${index + 1}: a link run needs an href.`);
      }
      return { type: "link", href, content: normalizeContent(run.content, index) };
    }
    const styles = readRecord(run.styles);
    return {
      type: "text",
      text: readString(run.text) ?? "",
      styles: styles ? pickStyles(styles) : {},
    };
  });
};

const STYLE_KEYS = ["bold", "italic", "underline", "strike", "code"];

const pickStyles = (styles: Record<string, unknown>): Record<string, boolean> =>
  Object.fromEntries(
    STYLE_KEYS.filter((k) => styles[k] === true).map((k) => [k, true]),
  );

/** Reads the column back. Mirrors `parseContent` in the SPA's service. */
const parseContent = (value: unknown): Block[] => {
  if (Array.isArray(value)) return value as Block[];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as Block[];
    } catch {
      // A body that will not parse reads as empty in the SPA too — say nothing
      // here, or every read of a legacy row becomes an error the model retries.
    }
  }
  return [];
};

/** The column is a varchar, so the document goes in as a string. */
const serializeContent = (blocks: Block[]): string => JSON.stringify(blocks ?? []);

const capBlocks = (blocks: Block[]): { kept: Block[]; truncated: boolean } =>
  blocks.length > MAX_READ_BLOCKS
    ? { kept: blocks.slice(0, MAX_READ_BLOCKS), truncated: true }
    : { kept: blocks, truncated: false };

/** The first words of a document, for a confirmation card someone has to read. */
const outline = (blocks: Block[]): string => {
  const text = blocks
    .map((b) => blockText(b))
    .filter((s) => s.length > 0)
    .join(" · ");
  return text.length > 160 ? `${text.slice(0, 159)}…` : text || "пусто";
};

const blockText = (block: Block): string => {
  const content = block.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((run) => {
        const r = readRecord(run);
        return readString(r?.text) ?? "";
      })
      .join("")
      .trim();
  }
  return "";
};

// ─── Tree ───────────────────────────────────────────────────────────────────

/** Every article under `guid`, with its depth, so a delete can go deepest-first. */
const descendants = (
  articles: ArticleSummary[],
  guid: string,
): Array<ArticleSummary & { depth: number }> => {
  const byParent = new Map<string, ArticleSummary[]>();
  for (const a of articles) {
    if (!a.parentId) continue;
    const siblings = byParent.get(a.parentId) ?? [];
    siblings.push(a);
    byParent.set(a.parentId, siblings);
  }

  const out: Array<ArticleSummary & { depth: number }> = [];
  const seen = new Set<string>([guid]);
  const stack = (byParent.get(guid) ?? []).map((a) => ({ ...a, depth: 1 }));
  while (stack.length > 0) {
    const node = stack.pop() as ArticleSummary & { depth: number };
    // A cycle in stored data would otherwise loop forever. `plan` refuses to
    // create one, but nothing stops a row written before this existed.
    if (seen.has(node.guid)) continue;
    seen.add(node.guid);
    out.push(node);
    for (const child of byParent.get(node.guid) ?? []) {
      stack.push({ ...child, depth: node.depth + 1 });
    }
  }
  return out;
};

const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const title = (row: UcodeItem): string =>
  readString(row.title) ?? "Без названия";

const articleLink = (guid: string, name: string): CopilotLink => ({
  id: randomUUID(),
  label: name ? `Открыть «${name}»` : "Открыть статью",
  href: `/knowledge-base/articles/${encodeURIComponent(guid)}`,
  kind: "knowledge",
});

/** 1 статья / 2 статьи / 5 статей. */
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};
