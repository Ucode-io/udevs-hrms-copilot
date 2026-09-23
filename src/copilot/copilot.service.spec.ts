import { freshLinks } from "./copilot.service";
import type { CopilotLink } from "./types/copilot.types";

const link = (href: string, label = "Открыть"): CopilotLink => ({
  // A new uuid every time, which is exactly why the dedupe cannot key on it.
  id: `${href}-${Math.random()}`,
  label,
  href,
  kind: "knowledge",
});

describe("freshLinks", () => {
  it("offers a destination once, however many tools return it", () => {
    // kb_read_article then kb_write_article on the same article: two results,
    // two links, one page. Buttons accumulate across the loop, so nothing else
    // would drop the repeat.
    const offered = new Set<string>();
    const article = "/knowledge-base/articles/a1";

    expect(freshLinks([link(article)], offered)).toHaveLength(1);
    expect(freshLinks([link(article, "Открыть «Отпуска»")], offered)).toEqual([]);
  });

  it("keeps different destinations", () => {
    const offered = new Set<string>();
    const fresh = freshLinks(
      [link("/knowledge-base/articles/a1"), link("/knowledge-base/articles/a2")],
      offered,
    );

    expect(fresh.map((l) => l.href)).toEqual([
      "/knowledge-base/articles/a1",
      "/knowledge-base/articles/a2",
    ]);
  });

  it("drops the repeat out of a result that also carries a new link", () => {
    const offered = new Set(["/employees"]);
    const fresh = freshLinks([link("/employees"), link("/reports")], offered);

    expect(fresh.map((l) => l.href)).toEqual(["/reports"]);
  });

  it("has nothing to offer for a result with no links", () => {
    expect(freshLinks(undefined, new Set())).toEqual([]);
  });
});
