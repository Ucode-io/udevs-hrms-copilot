import { randomUUID } from "crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../../config/configuration";
import { UcodeClient } from "../../ucode/ucode.client";
import { columnLabel, formatCell, rowLabel } from "../../ucode/labels";
import type {
  AggregateMetric,
  FieldDef,
  Filter,
  FilterOp,
  UcodeItem,
} from "../../ucode/ucode.types";
import type {
  CopilotChart,
  CopilotChartKind,
  CopilotTable,
} from "../types/copilot.types";
import { TableCatalog } from "../prompt/catalog";
import { chooseChart, type ChartChoice } from "./chart-shape";
import {
  CopilotToolError,
  displayValue,
  readArray,
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
 * Columns rendered into the on-screen table. The dock is about 400px wide, so
 * five columns of Cyrillic already run off the edge; past this the table is
 * something to scroll rather than something to read.
 */
const MAX_TABLE_COLUMNS = 5;
/** Rows rendered into the on-screen table. Beyond this, the person scrolls a page. */
const MAX_TABLE_ROWS = 50;
/**
 * Rows echoed back to the model. Deliberately smaller than what the person
 * sees — the table artifact already shows every row, so re-listing them costs
 * tokens and invites the model to retype a name or a date wrongly. But five was
 * too few to reason with: asked for an average by department it answered that
 * it could not see enough rows to be sure, which is a worse failure than the
 * one the small number was guarding against.
 */
const MODEL_ROW_PREVIEW = 30;
/** Rows quoted to the model for a lookup, where the quote is all it gets. */
const LOOKUP_ROW_QUOTE = 60;

const FILTER_OPS: FilterOp[] = ["eq", "contains", "in", "gt", "gte", "lt", "lte"];
const METRICS: AggregateMetric[] = ["count", "sum", "avg", "min", "max"];
/**
 * What the model may ask for. `auto` is the default and the recommended path:
 * the shape is decided server-side from the data once it is known. The explicit
 * kinds exist only so an outright request from the person ("покажи круговой")
 * can be carried through — and even then it is overridden when the data cannot
 * honestly carry it.
 */
const CHART_KINDS = [
  "auto",
  "bar",
  "line",
  "area",
  "pie",
  "donut",
  "none",
] as const;

@Injectable()
export class CopilotDataTools implements CopilotToolGroup {
  private readonly logger = new Logger(CopilotDataTools.name);

  constructor(
    private readonly ucode: UcodeClient,
    private readonly catalog: TableCatalog,
    @Inject(CONFIG) private readonly config: CopilotConfig,
  ) {
    // Without this the "employees only" default silently does nothing, and
    // every headcount quietly includes admin and service accounts. A wrong
    // number that looks right is worse than an error, so it is worth shouting
    // about at boot rather than discovering it in an answer.
    if (!this.config.hrms.employeeRoleId) {
      this.logger.warn(
        "No HRMS_EMPLOYEE_ROLE_ID: queries on user_base will include non-employees, inflating every count.",
      );
    }
  }

  getTools(): CopilotTool[] {
    return [
      this.listTables(),
      this.describeTable(),
      this.listItems(),
      this.aggregateItems(),
    ];
  }

  // ─── list_tables ──────────────────────────────────────────────────────────

  private listTables(): CopilotTool {
    return {
      name: "list_tables",
      description:
        "List the HRMS tables you are allowed to read and change, each with a one-line description. Call this when you are unsure which table holds what the person is asking about. You already have this catalogue in your instructions, so only call it if you need to re-check.",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        ok: true,
        summary: `${this.catalog.allTables().length} tables available`,
        data: {
          tables: this.catalog
            .allTables()
            .map((t) => ({ slug: t.slug, label: t.label, description: t.description })),
        },
      }),
    };
  }

  // ─── describe_table ───────────────────────────────────────────────────────

  private describeTable(): CopilotTool {
    return {
      name: "describe_table",
      description:
        "Get the real column list of one HRMS table, plus important notes about how its data actually behaves. ALWAYS call this before filtering, sorting, aggregating or writing to a table you have not already described in this conversation — column names cannot be guessed, and a filter on a column that does not exist is rejected.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            enum: this.catalog.slugs(),
            description: "Table slug.",
          },
        },
        required: ["table"],
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const entry = this.catalog.table(table);
        const fields = await this.ucode.fields(ctx.caller, table);

        return {
          ok: true,
          summary: `${table}: ${fields.length} columns`,
          data: {
            table,
            label: entry?.label,
            description: entry?.description,
            columns: fields.map((f) => ({
              name: f.slug,
              label: f.label,
              type: f.type,
              ...(f.options ? { allowedValues: f.options } : {}),
              ...(f.relationTable ? { relationTo: f.relationTable } : {}),
              ...(f.isSearch ? { searchable: true } : {}),
              ...(f.required ? { required: true } : {}),
            })),
            importantNotes: this.hintsFor(table),
            filterOperators: {
              supported: FILTER_OPS,
              notes: [
                "eq is exact only on guid and *_id columns. On a text column the backend compiles it to a case-insensitive substring match, so use contains and say 'contains' when you describe the result.",
                "There is no not-equals and no is-null operator. If you need one, fetch and reason about the rows instead of inventing an operator.",
                "gt / gte / lt / lte are real comparisons and are the correct way to filter dates and numbers, including age ranges over birth_date.",
              ],
            },
          },
        };
      },
    };
  }

  // ─── list_items ───────────────────────────────────────────────────────────

  private listItems(): CopilotTool {
    return {
      name: "list_items",
      description:
        "Fetch rows from one HRMS table with server-side filters, and show them to the person as a table. Use this for any 'who / which / show me / how many of them' question. The rows are rendered on screen automatically — state the count and what stands out, do NOT retype the rows into your reply. Call describe_table first so you filter on columns that exist. Do NOT call this to look around: every call puts a table in front of the person, so an exploratory unfiltered fetch leaves them with a table that answers nothing. Work out the filters first, then call it once.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            enum: this.catalog.slugs(),
            description: "Table slug.",
          },
          filters: {
            type: "array",
            description:
              "Conditions combined with AND. Every column must exist on the table.",
            items: {
              type: "object",
              properties: {
                field: { type: "string", description: "Column name." },
                op: { type: "string", enum: FILTER_OPS },
                value: {
                  description:
                    "A single value, or a list when op is 'in'. Dates are ISO YYYY-MM-DD.",
                },
              },
              required: ["field", "op", "value"],
            },
          },
          search: {
            type: "string",
            description:
              "Free-text search across the table's searchable columns. Use for a person's name; use filters for anything structured.",
          },
          sort: {
            type: "object",
            properties: {
              field: { type: "string" },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
            required: ["field", "direction"],
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description:
              "Columns to show, in order. The panel is narrow: four columns fit, more have to be scrolled sideways, so pick the ones that answer the question rather than everything that might be interesting. Relations show their name when you ask for the _data column (departments_id_data), not the id. Omit for a sensible default.",
          },
          limit: {
            type: "number",
            description: "Rows to fetch, 1-100. Defaults to 20.",
          },
          offset: { type: "number", description: "Rows to skip. Defaults to 0." },
          title: {
            type: "string",
            description:
              "Heading for the on-screen table, in the person's language, e.g. 'Employees aged 19-22'.",
          },
          lookup_only: {
            type: "boolean",
            description:
              "Set true when these rows are a step towards the answer rather than the answer — resolving names to ids, or fetching a set you are about to narrow. Nothing is drawn and you get the rows to work from. Every call without it puts a table on screen, so a question answered in three steps leaves three tables the person did not ask for.",
          },
        },
        required: ["table"],
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const fields = await this.ucode.fields(ctx.caller, table);
        const filters = this.readFilters(input.filters);

        const { filters: effective, applied } = this.applyDefaults(table, filters);

        // A lookup exists to be complete, not to be read: resolving "Должность:
        // Backend developer" against the first 20 of 60 positions is how a
        // column silently goes missing from an import.
        const lookupOnly = input.lookup_only === true;
        const limit = clamp(readNumber(input.limit) ?? (lookupOnly ? 100 : 20), 1, 100);
        const result = await this.ucode.list(ctx.caller, table, {
          filters: effective,
          search: readString(input.search),
          sort: this.readSort(input.sort),
          limit,
          offset: Math.max(0, readNumber(input.offset) ?? 0),
          withRelations: true,
        });

        const columns = this.resolveColumns(
          table,
          fields,
          readArray(input.columns)?.map(String),
        );
        // The table shows at most MAX_TABLE_ROWS; the model is quoted from what
        // actually came back. Slicing once for both is how a lookup asking for
        // 100 rows silently received 50 with nothing saying so.
        const items = result.response.slice(0, MAX_TABLE_ROWS);
        const quotable = result.response.slice(
          0,
          lookupOnly ? LOOKUP_ROW_QUOTE : MODEL_ROW_PREVIEW,
        );
        // Two projections of the same rows, because the two readers want
        // different things. The model always gets guid — it needs an id to
        // update or open a row, and without it in hand it burns a turn asking
        // for the same rows again. The person never sees one: a column of
        // "865ced3b-fe3b-4652-…" is noise wearing the costume of data.
        const rows = items.map((item) => projectRow(item, columns));
        const displayColumns = withoutEmptyColumns(
          columns.filter((c) => !isIdColumn(c.slug)),
          rows,
        );
        const shown =
          displayColumns.length > 0
            ? displayColumns
            : withoutEmptyColumns(
                this.resolveColumns(table, fields, undefined).filter(
                  (c) => !isIdColumn(c.slug),
                ),
                items.map((item) =>
                  projectRow(item, this.resolveColumns(table, fields, undefined)),
                ),
              );

        // Nothing matched, so there is nothing to draw. A table of headings over
        // no rows is a card that says "ничего не найдено" in the most expensive
        // way available; the sentence the model writes says it better.
        const drawTable = !lookupOnly && items.length > 0;

        const artifact: CopilotTable = {
          id: randomUUID(),
          title: readString(input.title) ?? this.catalog.table(table)?.label ?? table,
          subtitle: await this.describeFilters(ctx, table, filters),
          columns: shown.map((c) => ({ key: c.slug, label: c.label })),
          rows: items.map((item) => projectRow(item, shown)),
          totalCount: result.count,
        };

        return {
          ok: true,
          summary: `${result.count} row(s) in ${table}`,
          data: {
            table,
            matchedCount: result.count,
            returnedCount: rows.length,
            ...(applied.length > 0 ? { defaultsApplied: applied } : {}),
            preview: quotable.map((item) => ({
              ...(item.guid !== undefined ? { guid: String(item.guid) } : {}),
              ...projectRow(item, columns),
            })),
            ...(result.response.length > quotable.length
              ? {
                  previewNote: lookupOnly
                    ? `Only the first ${quotable.length} of ${result.response.length} rows are quoted. Narrow the query if you need the rest.`
                    : `Only the first ${quotable.length} of ${result.response.length} rows are quoted here; the person sees all of them.`,
                }
              : {}),
            ...(drawTable ? { tableRendered: artifact.title } : {}),
            note: drawTable
              ? "The rows are on screen as a table. State the count and at most one thing worth noticing. Do not retype rows, and do not mention the table."
              : items.length === 0
                ? "Nothing matched, so nothing was drawn. Say so in one sentence — and if the filters could be wrong, say which one you would relax rather than trying three more queries."
                : "Nothing was drawn — these rows are for you, not for the person. Answer from them, and make a separate call for anything they should actually see.",
          },
          ...(drawTable ? { tables: [artifact] } : {}),
        };
      },
    };
  }

  // ─── aggregate_items ──────────────────────────────────────────────────────

  private aggregateItems(): CopilotTool {
    return {
      name: "aggregate_items",
      description:
        "Group rows of one HRMS table and compute counts, sums or averages over them, then chart the result. Use this for 'how many per / average by / distribution of / breakdown by' questions. The chart is drawn from the query result and shown automatically — narrate the headline figures and do NOT re-list every bucket. For a monthly attendance summary prefer run_report, which matches the Reports page exactly.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", enum: this.catalog.slugs() },
          group_by: {
            type: "array",
            items: { type: "string" },
            description:
              "Columns to group by. Group by the *_id column, not its _data companion. Omit for a single total.",
          },
          metrics: {
            type: "array",
            description: "What to compute per group. At least one.",
            items: {
              type: "object",
              properties: {
                fn: { type: "string", enum: METRICS },
                field: {
                  type: "string",
                  description: "Column to aggregate. Not needed for count.",
                },
                alias: {
                  type: "string",
                  description: "Short name for the result column, e.g. 'total'.",
                },
              },
              required: ["fn", "alias"],
            },
          },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                op: { type: "string", enum: FILTER_OPS },
                value: {},
              },
              required: ["field", "op", "value"],
            },
          },
          chart: {
            type: "string",
            enum: [...CHART_KINDS],
            description:
              "Leave this out. The chart shape is chosen from the data itself — shares of a total become a pie, a date axis becomes a trend line, everything else becomes bars. Only pass a specific kind if the person explicitly asked for that kind of chart, or 'none' if they asked for numbers without one.",
          },
          title: {
            type: "string",
            description: "Chart heading, in the person's language.",
          },
        },
        required: ["table", "metrics"],
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const metrics = this.readMetrics(input.metrics);
        const groupBy = (readArray(input.group_by) ?? []).map(String);
        const { filters: effective, applied } = this.applyDefaults(
          table,
          this.readFilters(input.filters),
        );

        const rows = await this.ucode.aggregate(ctx.caller, table, {
          groupBy,
          metrics,
          filters: effective,
          // Biggest first, so that if the result is cut off at the limit it is
          // the long tail that goes, not the headline. Presentation order is
          // decided afterwards, once the chart shape is known.
          orderBy: metrics[0] ? { alias: metrics[0].alias, direction: "desc" } : undefined,
        });

        // Group keys arrive as raw ids. Swapping them for names is what makes a
        // "by department" chart readable instead of a wall of guids.
        const labelled = await this.labelGroups(ctx, table, groupBy, rows);

        const shape = chooseChart({
          groupBy,
          metrics,
          rows: labelled,
          fields: await this.ucode.fields(ctx.caller, table),
          requested: (readString(input.chart) as ChartChoice | "auto") ?? "auto",
        });

        const title =
          readString(input.title) ??
          (groupBy[0]
            ? `Разбивка по «${columnLabel(groupBy[0])}»`
            : (this.catalog.table(table)?.label ?? table));
        const chart =
          shape.kind === "none"
            ? null
            : buildChart(
                shape.kind,
                title,
                await this.describeFilters(ctx, table, this.readFilters(input.filters)),
                groupBy,
                metrics,
                shape.rows,
              );

        return {
          ok: true,
          summary: `${labelled.length} group(s) over ${table}`,
          data: {
            table,
            groupBy,
            metrics: metrics.map((m) => m.alias),
            ...(applied.length > 0 ? { defaultsApplied: applied } : {}),
            rows: shape.rows,
            ...(chart
              ? {
                  chartsRendered: [chart.title],
                  chartChoice: `${chart.kind}: ${shape.reason}`,
                  note: "The chart is on screen. Say what it shows in a sentence — the shape of it, the outlier, the answer to what was asked. Do not read the buckets out one by one, and do not mention the chart.",
                }
              : { chartSkipped: shape.reason }),
          },
          ...(chart ? { charts: [chart] } : {}),
        };
      },
    };
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  private assertTable(value: unknown): string {
    const table = requireString(value, "table");
    if (!this.catalog.allows(table)) {
      throw new CopilotToolError(
        `Table "${table}" is not available to the Copilot. Available tables: ${this.catalog.slugs().join(", ")}`,
      );
    }
    return table;
  }

  /**
   * Hints for a table, with the employee role id substituted in so the model can
   * actually use the instruction rather than being told about a value it has no
   * way to obtain.
   */
  private hintsFor(table: string): string[] {
    const roleId = this.config.hrms.employeeRoleId;
    return (this.catalog.table(table)?.hints ?? []).map((h) =>
      roleId ? h.replace("<the employee role id>", roleId) : h,
    );
  }

  /**
   * Applies filters the table cannot be read correctly without.
   *
   * `user_base` holds every kind of account, so a query with no `role_id` counts
   * non-staff as employees. Relying on the model to remember that on every call
   * would make the failure silent and plausible — a slightly-too-large headcount
   * reads exactly like a correct one. So we add it when it is missing and report
   * that we did, which the model then passes on.
   */
  private applyDefaults(
    table: string,
    filters: Filter[],
  ): { filters: Filter[]; applied: string[] } {
    const applied: string[] = [];
    const out = [...filters];

    if (table === "user_base") {
      const roleId = this.config.hrms.employeeRoleId;
      if (roleId && !filters.some((f) => f.field === "role_id")) {
        out.push({ field: "role_id", op: "eq", value: roleId });
        applied.push(
          "Restricted to employees (role_id). Ask for other user types explicitly to include them.",
        );
      }
      // "How many people are in Sales" means the people working there now.
      // Counting leavers inflates every headcount, and the number disagrees
      // with the Employees page, which filters the same way.
      if (!filters.some((f) => f.field === "status")) {
        out.push({ field: "status", op: "eq", value: "active" });
        applied.push(
          "Counted only current staff (status active). Dismissed employees are excluded unless the question asks for them.",
        );
      }
    }
    return { filters: out, applied };
  }

  private readFilters(raw: unknown): Filter[] {
    const list = readArray(raw) ?? [];
    return list.map((entry, i) => {
      const r = readRecord(entry);
      if (!r) throw new CopilotToolError(`filters[${i}] must be an object.`);
      const field = requireString(r.field, `filters[${i}].field`);
      const op = requireString(r.op, `filters[${i}].op`) as FilterOp;
      if (!FILTER_OPS.includes(op)) {
        throw new CopilotToolError(
          `filters[${i}].op "${op}" is not supported. Use one of: ${FILTER_OPS.join(", ")}.`,
        );
      }
      if (r.value === undefined || r.value === null) {
        throw new CopilotToolError(`filters[${i}].value is required.`);
      }
      return { field, op, value: r.value as Filter["value"] };
    });
  }

  private readMetrics(
    raw: unknown,
  ): Array<{ fn: AggregateMetric; field?: string; alias: string }> {
    const list = readArray(raw) ?? [];
    if (list.length === 0) {
      throw new CopilotToolError("At least one metric is required.");
    }
    return list.map((entry, i) => {
      const r = readRecord(entry);
      if (!r) throw new CopilotToolError(`metrics[${i}] must be an object.`);
      const fn = requireString(r.fn, `metrics[${i}].fn`) as AggregateMetric;
      if (!METRICS.includes(fn)) {
        throw new CopilotToolError(
          `metrics[${i}].fn "${fn}" is not supported. Use one of: ${METRICS.join(", ")}.`,
        );
      }
      const alias = readString(r.alias) ?? fn;
      if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
        throw new CopilotToolError(
          `metrics[${i}].alias must be a plain name like "total".`,
        );
      }
      return { fn, alias, ...(readString(r.field) ? { field: readString(r.field) } : {}) };
    });
  }

  private readSort(
    raw: unknown,
  ): { field: string; direction: "asc" | "desc" } | undefined {
    const r = readRecord(raw);
    if (!r) return undefined;
    const field = readString(r.field);
    if (!field) return undefined;
    return { field, direction: readString(r.direction) === "asc" ? "asc" : "desc" };
  }

  /**
   * Picks which columns the on-screen table shows. A model-supplied list wins;
   * otherwise take the first handful of readable columns and always lead with a
   * name if the table has one, so a row is identifiable at a glance.
   */
  private resolveColumns(
    table: string,
    fields: FieldDef[],
    requested: string[] | undefined,
  ): FieldDef[] {
    const byName = new Map(fields.map((f) => [f.slug, f]));
    /**
     * Relations arrive as a pair: `departments_id` holds the guid and
     * `departments_id_data` the `{guid, title}` the person should see. Only the
     * id half is a real Postgres column, so the schema knows nothing about the
     * `_data` half and asking for it used to yield a table with the column
     * silently missing — which is why an employee list never showed a
     * department, and the model went off to list the departments table
     * separately just to name them.
     */
    const resolve = (name: string): FieldDef | undefined => {
      const direct = byName.get(name);
      if (direct) return direct;
      if (!name.endsWith("_data")) return undefined;
      const base = byName.get(name.slice(0, -"_data".length));
      return base ? { slug: name, label: base.label, type: "LOOKUP" } : undefined;
    };

    if (requested && requested.length > 0) {
      const picked = requested
        .map((c) => resolve(c))
        .filter((f): f is FieldDef => f !== undefined);
      if (picked.length > 0) return picked.slice(0, MAX_TABLE_COLUMNS);
    }

    /**
     * Whom or what the row is about, which on most tables is a relation rather
     * than a column of its own. An attendance row is a check-in time, a delay
     * and a status — the employee lives on user_base_id_data — so a table built
     * from the schema order alone came out as three columns of times that
     * nobody could attribute to anyone.
     */
    const named = fields
      .filter((f) => !HIDDEN_COLUMNS.has(f.slug) && isIdColumn(f.slug))
      .slice(0, 2)
      .map((f) => `${f.slug}_data`);

    const preferred =
      table === "user_base"
        ? [
            "second_name",
            "first_name",
            "positions_id_data",
            "departments_id_data",
            "birth_date",
            "date_hire",
            "phone",
          ]
        : [...named, "title", "name", "date", "created_at"];

    const picked = preferred
      .map((c) => resolve(c))
      .filter((f): f is FieldDef => f !== undefined);
    // An id whose name is already picked would take one of five slots and then
    // be dropped from the table, because guids are never shown — so the person
    // would get four columns where five were available.
    const rest = fields.filter(
      (f) =>
        !HIDDEN_COLUMNS.has(f.slug) &&
        !f.slug.endsWith("_data") &&
        !picked.some((p) => p.slug === f.slug || p.slug === `${f.slug}_data`),
    );
    return [...picked, ...rest].slice(0, MAX_TABLE_COLUMNS);
  }

  /**
   * A one-line description of what the result covers, for the card's subtitle.
   *
   * Only the filters the person actually asked for — defaults the tool applied
   * on its own are reported to the model instead, which narrates them in prose.
   * Relation ids are resolved to names: "role_id = 52e5168d-660b-…" under a
   * chart tells a human nothing and looks like a leak of something internal.
   */
  private async describeFilters(
    ctx: CopilotToolContext,
    table: string,
    filters: Filter[],
  ): Promise<string | undefined> {
    if (filters.length === 0) return undefined;

    const fields = await this.ucode.fields(ctx.caller, table);
    const byName = new Map(fields.map((f) => [f.slug, f]));

    // Two bounds on one column are one idea — "born between X and Y" — and
    // printing them as two clauses makes the reader reassemble the range.
    const grouped = new Map<string, Filter[]>();
    for (const f of filters) {
      const list = grouped.get(f.field) ?? [];
      list.push(f);
      grouped.set(f.field, list);
    }

    const parts: string[] = [];
    for (const [field, group] of grouped) {
      const def = byName.get(field);
      const label = def?.label ?? columnLabel(field);
      const rendered = await Promise.all(
        group.map(async (f) => this.describeOne(ctx, table, f, def?.type)),
      );
      // A bound we could not put into words would print as a guid; the model
      // still describes it in prose, so drop it rather than leak an id.
      if (rendered.some((r) => r === null)) continue;

      const lower = rendered.find((_, i) => group[i].op === "gt" || group[i].op === "gte");
      const upper = rendered.find((_, i) => group[i].op === "lt" || group[i].op === "lte");
      parts.push(
        lower && upper && group.length === 2
          ? `${label}: ${stripBound(lower)} – ${stripBound(upper)}`
          : `${label}: ${rendered.join(", ")}`,
      );
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  /** One filter as words: "после 08.09.2004", "содержит Иван", "Активен". */
  private async describeOne(
    ctx: CopilotToolContext,
    table: string,
    filter: Filter,
    type: string | undefined,
  ): Promise<string | null> {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    // A relation is filtered by id and has to be named before it can be shown.
    // Keyed on the column rather than on whether the value looks like a uuid:
    // an id is an id whether it reads as "52e5168d-…" or "role-employee-0001",
    // and neither belongs under a table a person is reading.
    const isRelation = filter.field.endsWith("_id") || filter.field === "guid";
    const rendered = await Promise.all(
      values.map(async (v) =>
        isRelation
          ? await this.resolveRelationLabel(ctx, table, filter.field, String(v))
          : formatCell(String(v), type),
      ),
    );
    if (rendered.some((r) => r === null)) return null;
    const joined = rendered.join(", ");
    const prefix = OP_LABEL[filter.op];
    return prefix ? `${prefix} ${joined}` : joined;
  }

  /** The title of the row a relation column points at, when we can find it. */
  private async resolveRelationLabel(
    ctx: CopilotToolContext,
    table: string,
    column: string,
    id: string,
  ): Promise<string | null> {
    const target = await this.relationTarget(ctx, table, column);
    if (!target) return null;
    const labels = await this.lookupLabels(ctx, target, [id]);
    return labels.get(id) ?? null;
  }

  /** Which table a relation column points at, when it is one we may read. */
  private async relationTarget(
    ctx: CopilotToolContext,
    table: string,
    column: string,
  ): Promise<string | null> {
    const fields = await this.ucode.fields(ctx.caller, table);
    const declared = fields.find((f) => f.slug === column)?.relationTable;
    const target = declared ?? guessRelationTable(column);
    return target && this.catalog.allows(target) ? target : null;
  }

  /** guid → title for a set of rows in one call. Missing ids are simply absent. */
  private async lookupLabels(
    ctx: CopilotToolContext,
    target: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    try {
      const related = await this.ucode.list(ctx.caller, target, {
        filters: [{ field: "guid", op: "in", value: ids }],
        limit: 100,
      });
      return new Map(
        related.response.map((item) => [
          String(item.guid),
          rowLabel(item) ?? String(item.guid),
        ]),
      );
    } catch {
      // A missing name is cosmetic — the figures are still right.
      return new Map();
    }
  }

  /**
   * Replaces relation ids in aggregation group keys with their human titles, by
   * fetching the referenced rows once per grouped relation column.
   */
  private async labelGroups(
    ctx: CopilotToolContext,
    table: string,
    groupBy: string[],
    rows: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const relationCols = groupBy.filter((c) => c.endsWith("_id"));
    if (relationCols.length === 0 || rows.length === 0) return rows;

    const labels = new Map<string, Map<string, string>>();

    for (const col of relationCols) {
      const target = await this.relationTarget(ctx, table, col);
      if (!target) continue;
      const ids = [
        ...new Set(
          rows
            .map((r) => r[col])
            .filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      ];
      const resolved = await this.lookupLabels(ctx, target, ids);
      if (resolved.size > 0) labels.set(col, resolved);
    }

    return rows.map((row) => {
      const out = { ...row };
      for (const [col, map] of labels) {
        const id = row[col];
        if (typeof id === "string") out[col] = map.get(id) ?? id;
      }
      return out;
    });
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** guid itself and the raw id half of a relation pair. */
const isIdColumn = (slug: string): boolean =>
  slug === "guid" || slug.endsWith("_id");

const HIDDEN_COLUMNS = new Set([
  "guid",
  "companies_id",
  "created_at",
  "updated_at",
  "deleted_at",
  "custom_data",
  "password",
]);

/** Keeps the columns that at least one row actually filled in. */
const withoutEmptyColumns = (
  columns: FieldDef[],
  rows: Array<Record<string, string | number | null>>,
): FieldDef[] => {
  if (rows.length === 0) return columns;
  const filled = columns.filter((c) =>
    rows.some((row) => {
      const v = row[c.slug];
      return v !== null && v !== undefined && v !== "";
    }),
  );
  // Every column empty means an empty result set, not a bad column choice —
  // keep the headings so the table still says what was searched.
  return filled.length > 0 ? filled : columns;
};

const projectRow = (
  item: UcodeItem,
  columns: FieldDef[],
): Record<string, string | number | null> => {
  const row: Record<string, string | number | null> = {};
  for (const col of columns) {
    const raw = item[col.slug];
    row[col.slug] =
      typeof raw === "number" ? raw : formatCell(displayValue(raw), col.type);
  }
  return row;
};



/** Empty means the value speaks for itself: "Статус: Активен". */
const OP_LABEL: Record<FilterOp, string> = {
  eq: "",
  contains: "содержит",
  in: "",
  gt: "после",
  gte: "с",
  lt: "до",
  lte: "по",
};

/** "после 08.09.2004" → "08.09.2004", for the two ends of a merged range. */
const stripBound = (part: string): string =>
  part.replace(/^(после|с|до|по)\s+/, "");

/**
 * Builds the chart from the aggregation result. The model chose the shape and
 * the heading; every number here comes from `rows`, which is why a charted
 * figure cannot be a hallucination.
 */
const buildChart = (
  kind: CopilotChartKind,
  title: string,
  subtitle: string | undefined,
  groupBy: string[],
  metrics: Metric[],
  rows: Array<Record<string, unknown>>,
): CopilotChart => {
  const xKey = groupBy[0];
  const firstMetric = metrics[0]?.alias ?? "value";
  /**
   * A group's name as a person reads it. An unset column groups into a bucket
   * with no name at all, which renders as a slice and a legend dot with blank
   * text — the reader sees a share of the workforce and cannot tell of what.
   */
  const groupLabel = (row: Record<string, unknown>): string => {
    if (!xKey) return "Всего";
    const raw = row[xKey];
    const text = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
    if (text.trim() === "") return "Не указано";
    return String(formatCell(text) ?? text);
  };

  if (kind === "pie" || kind === "donut") {
    return {
      id: randomUUID(),
      kind,
      title,
      ...(subtitle ? { subtitle } : {}),
      data: rows.map((r) => ({
        name: groupLabel(r),
        value: Number(r[firstMetric] ?? 0),
      })),
    };
  }

  return {
    id: randomUUID(),
    kind,
    title,
    ...(subtitle ? { subtitle } : {}),
    xKey: "label",
    series: metrics.map((m) => ({
      key: m.alias,
      label: metricLabel(m),
      format: "number" as const,
    })),
    data: rows.map((r) => {
      const row: Record<string, string | number> = { label: groupLabel(r) };
      for (const m of metrics) row[m.alias] = Number(r[m.alias] ?? 0);
      return row;
    }),
  };
};

/**
 * A metric in words for the legend. The alias is the model's own shorthand
 * ("total", "avg_salary"); a legend reading "total" tells the person nothing
 * they did not already assume.
 */
type Metric = { fn: AggregateMetric; field?: string; alias: string };

const METRIC_PREFIX: Record<AggregateMetric, string> = {
  count: "Количество",
  sum: "Сумма",
  avg: "Среднее",
  min: "Минимум",
  max: "Максимум",
};

const metricLabel = (m: Metric): string =>
  m.fn === "count" || !m.field
    ? METRIC_PREFIX[m.fn]
    : `${METRIC_PREFIX[m.fn]}: ${columnLabel(m.field)}`;

/** `departments_id` → `departments`, when ucode did not name the target itself. */
const guessRelationTable = (column: string): string | null =>
  column.endsWith("_id") ? column.slice(0, -3) : null;


const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(n)));
