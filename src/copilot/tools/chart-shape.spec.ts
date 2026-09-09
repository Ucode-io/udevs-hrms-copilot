import { chooseChart } from "./chart-shape";
import type { FieldDef } from "../../ucode/ucode.types";

const FIELDS: FieldDef[] = [
  { slug: "departments_id", label: "Отдел", type: "LOOKUP" },
  { slug: "positions_id", label: "Должность", type: "LOOKUP" },
  { slug: "date", label: "Дата", type: "DATE" },
  { slug: "birth_date", label: "Дата рождения", type: "DATE" },
];

const count = [{ fn: "count" as const, alias: "total" }];
const avg = [{ fn: "avg" as const, field: "salary", alias: "avg_salary" }];

const rows = (...pairs: Array<[string, number]>) =>
  pairs.map(([departments_id, total]) => ({ departments_id, total }));

describe("chooseChart", () => {
  describe("shares of a total", () => {
    it("draws a ring for a handful of counted categories", () => {
      // The case that prompted this: two departments, counted. Bars compare two
      // numbers; a ring shows they are halves of the same group, and carries the
      // total in its middle.
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["Разработка", 2], ["АУП", 2]),
        fields: FIELDS,
      });

      expect(shape.kind).toBe("donut");
    });

    it("switches to bars once there are too many slices to read", () => {
      const many = rows(
        ["a", 9], ["b", 8], ["c", 7], ["d", 6], ["e", 5], ["f", 4], ["g", 3],
      );
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: many,
        fields: FIELDS,
      });

      expect(shape.kind).toBe("bar");
      expect(shape.reason).toMatch(/too many/i);
    });

    it("never pies an average, however few categories there are", () => {
      // Average age by department charted as a pie claims the departments' ages
      // sum to a whole. They do not.
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: avg,
        rows: [
          { departments_id: "Разработка", avg_salary: 31 },
          { departments_id: "АУП", avg_salary: 44 },
        ],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("bar");
    });

    it("orders slices biggest first", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["маленький", 1], ["большой", 9], ["средний", 4]),
        fields: FIELDS,
      });

      expect(shape.rows.map((r) => r.departments_id)).toEqual([
        "большой",
        "средний",
        "маленький",
      ]);
    });
  });

  describe("over time", () => {
    it("plots a date column as a trend, in chronological order", () => {
      // The query returns biggest-first; charting a date axis in value order
      // would draw a line that means nothing.
      const shape = chooseChart({
        groupBy: ["date"],
        metrics: count,
        rows: [
          { date: "2026-03-01", total: 9 },
          { date: "2026-01-01", total: 2 },
          { date: "2026-02-01", total: 5 },
        ],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("area");
      expect(shape.rows.map((r) => r.date)).toEqual([
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
      ]);
    });

    it("recognises a date even when the schema does not call it one", () => {
      // Grouping by a date expression produces a column ucode knows nothing
      // about, so the values have to speak for themselves.
      const shape = chooseChart({
        groupBy: ["month"],
        metrics: count,
        rows: [
          { month: "2026-02", total: 4 },
          { month: "2026-01", total: 7 },
        ],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("area");
      expect(shape.rows.map((r) => r.month)).toEqual(["2026-01", "2026-02"]);
    });

    it("uses a line when several measures share the time axis", () => {
      const shape = chooseChart({
        groupBy: ["date"],
        metrics: [
          { fn: "count", alias: "total" },
          { fn: "sum", field: "late", alias: "late" },
        ],
        rows: [
          { date: "2026-01-01", total: 5, late: 1 },
          { date: "2026-02-01", total: 8, late: 3 },
        ],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("line");
    });
  });

  describe("nothing worth drawing", () => {
    it("skips the chart for a single total", () => {
      const shape = chooseChart({
        groupBy: [],
        metrics: count,
        rows: [{ total: 19 }],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("none");
    });

    it("skips the chart when one group came back", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["Разработка", 12]),
        fields: FIELDS,
      });

      expect(shape.kind).toBe("none");
    });

    it("skips the chart on an empty result", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: [],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("none");
    });
  });

  describe("an explicit request", () => {
    it("is honoured when the data can carry it", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["a", 3], ["b", 2]),
        fields: FIELDS,
        requested: "pie",
      });

      expect(shape.kind).toBe("pie");
    });

    it("is corrected, with a reason, when it would mislead", () => {
      // Someone asking for a pie of averages gets bars and an explanation the
      // model can pass on, rather than a chart that lies politely.
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: avg,
        rows: [
          { departments_id: "a", avg_salary: 10 },
          { departments_id: "b", avg_salary: 20 },
        ],
        fields: FIELDS,
        requested: "pie",
      });

      expect(shape.kind).toBe("bar");
      expect(shape.reason).toMatch(/not a share of a total/i);
    });

    it("refuses to draw a line between unrelated categories", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["a", 3], ["b", 2]),
        fields: FIELDS,
        requested: "line",
      });

      expect(shape.kind).toBe("bar");
      expect(shape.reason).toMatch(/not a sequence/i);
    });

    it("honours 'none'", () => {
      const shape = chooseChart({
        groupBy: ["departments_id"],
        metrics: count,
        rows: rows(["a", 3], ["b", 2]),
        fields: FIELDS,
        requested: "none",
      });

      expect(shape.kind).toBe("none");
    });
  });

  describe("more than one dimension", () => {
    it("compares grouped bars rather than attempting a pie", () => {
      const shape = chooseChart({
        groupBy: ["departments_id", "positions_id"],
        metrics: count,
        rows: [
          { departments_id: "a", positions_id: "x", total: 3 },
          { departments_id: "a", positions_id: "y", total: 2 },
        ],
        fields: FIELDS,
      });

      expect(shape.kind).toBe("bar");
    });
  });
});
