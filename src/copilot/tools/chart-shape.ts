import type { AggregateMetric, FieldDef } from "../../ucode/ucode.types";
import type { CopilotChartKind } from "../types/copilot.types";

export type ChartChoice = CopilotChartKind | "none";

export interface ChartShapeInput {
  /** Columns the query grouped by, in order. */
  groupBy: string[];
  metrics: Array<{ fn: AggregateMetric; field?: string; alias: string }>;
  /** The aggregation result, already labelled. */
  rows: Array<Record<string, unknown>>;
  /** Column definitions of the aggregated table, for spotting date columns. */
  fields: FieldDef[];
  /** An explicit request from the person ("покажи круговой"), via the model. */
  requested?: ChartChoice | "auto";
}

export interface ChartShape {
  kind: ChartChoice;
  /** Rows in the order they should be plotted. */
  rows: Array<Record<string, unknown>>;
  /** Why this shape — surfaced to the model so it can narrate accurately. */
  reason: string;
}

/**
 * Above this many slices a pie stops being readable: the wedges get too thin to
 * compare and the legend does the actual work, at which point bars are simply
 * better.
 */
const MAX_PIE_SLICES = 6;

/** ucode column types whose values are points in time. */
const DATE_TYPES = new Set([
  "DATE",
  "DATE_TIME",
  "TIME",
  "DATETIME",
  "TIMESTAMP",
]);

/**
 * Aggregations that produce parts of a whole. A count or a sum over a partition
 * adds up to something meaningful, which is the only case where a pie is
 * telling the truth: the slices are shares of a total.
 *
 * An average emphatically does not. "Average age by department" charted as a pie
 * says the departments' ages sum to 100% of something — they do not. That gets
 * bars regardless of how few categories there are.
 */
const PART_OF_WHOLE: ReadonlySet<AggregateMetric> = new Set(["count", "sum"]);

/**
 * Picks the chart that actually suits the data.
 *
 * This lives on the server rather than in the model's hands because the model
 * chooses the shape *before* the query runs — it has not seen the row count, the
 * cardinality or the metric's meaning yet. Asking it to guess produced exactly
 * the failure this replaces: two bars where a pie was obviously right.
 *
 * An explicit request from the person is honoured when the data can carry it,
 * and quietly corrected when it cannot.
 */
export const chooseChart = (input: ChartShapeInput): ChartShape => {
  const { groupBy, metrics, rows, fields, requested } = input;

  if (requested === "none") {
    return { kind: "none", rows, reason: "Chart suppressed by request." };
  }
  if (rows.length === 0) {
    return { kind: "none", rows, reason: "No rows to plot." };
  }
  if (metrics.length === 0) {
    return { kind: "none", rows, reason: "Nothing measured." };
  }
  // A single total is one number. A chart of one number is a worse way to read
  // it than the number itself.
  if (groupBy.length === 0 || rows.length === 1) {
    return {
      kind: "none",
      rows,
      reason: "A single value reads better as a figure than as a chart.",
    };
  }

  const groupColumn = groupBy[0];
  const overTime = isTimeSeries(groupColumn, rows, fields);
  const singleMetric = metrics.length === 1;
  const explicit =
    requested && requested !== "auto" ? (requested as CopilotChartKind) : null;

  // Time first: a date axis makes the shape obvious, and plotting dates in any
  // order but chronological is actively misleading.
  if (overTime) {
    const ordered = sortByGroup(rows, groupColumn);
    const kind: CopilotChartKind =
      explicit === "bar" ? "bar" : singleMetric ? "area" : "line";
    return {
      kind,
      rows: ordered,
      reason: `${groupColumn} is a date, so the values are plotted in chronological order.`,
    };
  }

  const ordered = sortByMetric(rows, metrics[0].alias);

  // A pie can only show one series, over one dimension, and only one that sums
  // to a whole. Two grouping columns would have to be flattened into a single
  // label, which turns "Разработка / CTO" into a slice of nothing coherent.
  const pieable =
    groupBy.length === 1 &&
    singleMetric &&
    PART_OF_WHOLE.has(metrics[0].fn) &&
    rows.length >= 2 &&
    rows.length <= MAX_PIE_SLICES &&
    rows.every((row) => Number(row[metrics[0].alias] ?? 0) >= 0);

  if (explicit === "pie" || explicit === "donut") {
    return pieable
      ? { kind: explicit, rows: ordered, reason: "Shares of a total." }
      : {
          kind: "bar",
          rows: ordered,
          reason: pieReject(metrics, rows.length),
        };
  }

  if (explicit === "line" || explicit === "area") {
    // Asked for a trend line over something that is not a sequence — a line
    // between unrelated categories implies a progression that does not exist.
    return {
      kind: "bar",
      rows: ordered,
      reason: `${groupColumn} is not a sequence, so the categories are compared as bars.`,
    };
  }

  if (explicit === "bar") {
    return { kind: "bar", rows: ordered, reason: "Categories compared." };
  }

  if (pieable) {
    return {
      kind: "donut",
      rows: ordered,
      reason: `${rows.length} categories forming a whole, shown as shares of a total.`,
    };
  }

  return {
    kind: "bar",
    rows: ordered,
    reason:
      rows.length > MAX_PIE_SLICES
        ? `${rows.length} categories — too many to read as slices.`
        : "Categories compared side by side.",
  };
};

/** Explains why a requested pie was turned into bars. */
const pieReject = (
  metrics: Array<{ fn: AggregateMetric }>,
  rowCount: number,
): string => {
  if (metrics.length > 1) {
    return "A pie shows one measure at a time, so these are bars.";
  }
  if (!PART_OF_WHOLE.has(metrics[0].fn)) {
    return `An ${metrics[0].fn} is not a share of a total, so a pie would misrepresent it — shown as bars.`;
  }
  if (rowCount > MAX_PIE_SLICES) {
    return `${rowCount} categories are too many to read as slices — shown as bars.`;
  }
  return "Shown as bars.";
};

/**
 * True when the grouping column is a point in time — either because ucode says
 * the column is a date, or because every value reads as one (a query can group
 * by a date expression the schema knows nothing about).
 */
const isTimeSeries = (
  column: string,
  rows: Array<Record<string, unknown>>,
  fields: FieldDef[],
): boolean => {
  const field = fields.find((f) => f.slug === column);
  if (field && DATE_TYPES.has(field.type.toUpperCase())) return true;

  const values = rows
    .map((row) => row[column])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (values.length < 2 || values.length !== rows.length) return false;
  return values.every(looksLikeDate);
};

/** ISO-ish dates and month buckets, which is what date grouping produces. */
const looksLikeDate = (value: string): boolean =>
  /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/.test(value.trim());

const sortByGroup = (
  rows: Array<Record<string, unknown>>,
  column: string,
): Array<Record<string, unknown>> =>
  [...rows].sort((a, b) =>
    String(a[column] ?? "").localeCompare(String(b[column] ?? "")),
  );

const sortByMetric = (
  rows: Array<Record<string, unknown>>,
  alias: string,
): Array<Record<string, unknown>> =>
  [...rows].sort((a, b) => Number(b[alias] ?? 0) - Number(a[alias] ?? 0));
