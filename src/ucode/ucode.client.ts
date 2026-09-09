import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { FilterCompiler } from "./filter-compiler";
import { sqlIdentifier, sqlLiteral } from "./sql-literal";
import { columnLabel } from "./labels";
import type {
  AggregateQuery,
  AggregateRow,
  CallerContext,
  FieldDef,
  Filter,
  ListQuery,
  ListResult,
  UcodeItem,
} from "./ucode.types";

/** Raised for a ucode call that came back non-2xx or unusable. */
export class UcodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UcodeError";
  }
}

const FIELD_CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface CachedFields {
  fields: FieldDef[];
  expiresAt: number;
}

/**
 * The Copilot's only door to HRMS data. Everything goes over the public ucode
 * HTTP API as the calling user — there is no privileged data path, so the
 * Copilot can never read something the person could not open themselves.
 *
 * Two rules hold for every method here:
 *
 *  - the Caller's bearer token is forwarded verbatim, so ucode performs its own
 *    per-table permission check on each request;
 *  - `companies_id` is taken from the CallerContext and written over anything
 *    already in the payload. The HRMS SPA does this in a browser interceptor
 *    (`src/api/httpRequest.ts`), which means the backend does not enforce it —
 *    if we forgot it here, every list would quietly span all companies.
 */
@Injectable()
export class UcodeClient {
  private readonly logger = new Logger(UcodeClient.name);
  private readonly fieldCache = new Map<string, CachedFields>();

  constructor(@Inject(CONFIG) private readonly config: CopilotConfig) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * Column definitions for a table, cached briefly (schemas change rarely).
   *
   * Deliberately NOT `/v2/fields/:table`: that route sits behind the gateway's
   * admin middleware (`v1.AuthMiddleware`), while everything under
   * `/v2/items` uses the client one. An HRMS user's token is rejected there
   * with "user not access environment" — they are an app user, not a member of
   * the ucode environment. The schema route lives under items, so it answers to
   * the same token the rest of the copilot already uses.
   */
  async fields(ctx: CallerContext, table: string): Promise<FieldDef[]> {
    const cached = this.fieldCache.get(table);
    if (cached && cached.expiresAt > Date.now()) return cached.fields;

    let fields = await this.schemaFields(ctx, table);
    if (fields.length === 0) fields = await this.sampleFields(ctx, table);
    if (fields.length === 0) {
      throw new UcodeError(`Table "${table}" has no readable columns.`, 404);
    }

    this.fieldCache.set(table, {
      fields,
      expiresAt: Date.now() + FIELD_CACHE_TTL_MS,
    });
    return fields;
  }

  /** The live Postgres schema, as the items API exposes it. */
  private async schemaFields(
    ctx: CallerContext,
    table: string,
  ): Promise<FieldDef[]> {
    try {
      const body = await this.request(ctx, "GET", `/v2/items/${table}/schema`);
      return extractSchemaColumns(body);
    } catch (e) {
      this.logger.warn(
        `schema lookup failed for ${table}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /**
   * Last resort: read one row and take its keys.
   *
   * Cruder than a schema — no types beyond what the values reveal — but it can
   * never be denied when the caller can already list the table, and it describes
   * exactly the columns that caller can see. Better a usable answer from a thin
   * description than a refusal.
   */
  private async sampleFields(
    ctx: CallerContext,
    table: string,
  ): Promise<FieldDef[]> {
    try {
      const body = await this.request(
        ctx,
        "GET",
        `/v2/items/${table}`,
        undefined,
        {
          data: JSON.stringify({ limit: 1, offset: 0, companies_id: ctx.companiesId }),
          companies_id: ctx.companiesId,
        },
      );
      const payload = unwrap(body) as { response?: unknown };
      const row = Array.isArray(payload?.response) ? payload.response[0] : null;
      if (!row || typeof row !== "object") return [];
      return Object.entries(row as Record<string, unknown>)
        .filter(([slug]) => !slug.endsWith("_data"))
        .map(([slug, value]) => ({
          slug,
          label: columnLabel(slug),
          type: inferType(slug, value),
        }));
    } catch {
      return [];
    }
  }

  async list(
    ctx: CallerContext,
    table: string,
    query: ListQuery,
  ): Promise<ListResult> {
    const compiler = FilterCompiler.from(await this.fields(ctx, table));
    const data = compiler.compileList(query);
    // Tenant scope, written last so nothing above can have dropped it.
    data.companies_id = ctx.companiesId;

    const body = await this.request(
      ctx,
      "GET",
      `/v2/items/${table}`,
      undefined,
      { data: JSON.stringify(data), companies_id: ctx.companiesId },
    );
    const payload = unwrap(body) as { count?: unknown; response?: unknown };
    return {
      count: Number(payload?.count ?? 0),
      response: Array.isArray(payload?.response)
        ? (payload.response as UcodeItem[])
        : [],
    };
  }

  async getOne(
    ctx: CallerContext,
    table: string,
    guid: string,
  ): Promise<UcodeItem | null> {
    const body = await this.request(
      ctx,
      "GET",
      `/v2/items/${table}/${encodeURIComponent(guid)}`,
      undefined,
      { with_relations: "true", companies_id: ctx.companiesId },
    );
    const payload = unwrap(body) as { response?: unknown };
    const item = (payload?.response ?? null) as UcodeItem | null;
    if (!item) return null;
    // The by-guid endpoint takes the id at face value, so verify the row we got
    // back actually belongs to the Caller's Company before handing it over.
    const owner = item.companies_id;
    if (typeof owner === "string" && owner !== ctx.companiesId) return null;
    return item;
  }

  /**
   * Grouped aggregation. `columns`, `group_by` and `where` are all generated
   * here from the structured query — the model supplies column names and metric
   * kinds, never SQL text.
   */
  async aggregate(
    ctx: CallerContext,
    table: string,
    query: AggregateQuery,
  ): Promise<AggregateRow[]> {
    const fields = await this.fields(ctx, table);
    const known = new Set(fields.map((f) => f.slug));
    const check = (name: string): string => {
      if (!known.has(name)) {
        throw new UcodeError(
          `Unknown column "${name}" on ${table}. Available: ${[...known].sort().join(", ")}`,
          400,
        );
      }
      return name;
    };
    // status / gender / language are Postgres arrays. `"status" = 'active'`
    // makes the server try to parse 'active' as an array literal and the whole
    // aggregation fails with a 500 — the item path avoids this because its
    // filter compiler wraps array values, and this path builds its own SQL.
    const arrayColumns = new Set(
      fields.filter((f) => ARRAY_FIELD_TYPES.has(f.type)).map((f) => f.slug),
    );
    const isArrayColumn = (name: string): boolean => arrayColumns.has(name);

    const typeOf = (name: string): string =>
      fields.find((f) => f.slug === name)?.type.toUpperCase() ?? "";

    const groupBy = (query.groupBy ?? []).map(check);
    const columns = [
      ...groupBy.map(sqlIdentifier),
      ...query.metrics.map((m) => {
        const alias = sqlIdentifier(m.alias);
        if (m.fn === "count") return `COUNT(*) AS ${alias}`;
        if (!m.field) {
          throw new UcodeError(`Metric "${m.fn}" needs a column.`, 400);
        }
        const col = sqlIdentifier(check(m.field));
        const isDate = typeOf(m.field).startsWith("DATE");

        if (isDate && m.fn === "avg") {
          // Postgres cannot average dates, so `AVG(birth_date)` fails with a
          // server error — and the one question this system exists to answer
          // ("average age by department") is exactly that call. Age in years is
          // what the person means by an average over a birth date anyway.
          return `AVG(DATE_PART('year', AGE(${col}))) AS ${alias}`;
        }
        if (isDate && m.fn === "sum") {
          throw new UcodeError(
            `Adding up the dates in "${m.field}" is not meaningful. Use avg for an average age or span, or min / max for the earliest and latest.`,
            400,
          );
        }
        return `${m.fn.toUpperCase()}(${col}) AS ${alias}`;
      }),
    ];

    const payload: Record<string, unknown> = {
      operation: "SELECT",
      table,
      columns,
      where: this.buildWhere(ctx, query.filters ?? [], check, isArrayColumn),
      limit: Math.min(query.limit ?? 200, 1000),
    };
    if (groupBy.length > 0) payload.group_by = groupBy.map(sqlIdentifier);
    if (query.orderBy) {
      const dir = query.orderBy.direction === "asc" ? "ASC" : "DESC";
      payload.order_by = [`${sqlIdentifier(query.orderBy.alias)} ${dir}`];
    }

    const body = await this.request(
      ctx,
      "POST",
      `/v2/items/${table}/aggregation`,
      { data: payload, is_cached: false },
    );
    return extractAggregateRows(body);
  }

  /**
   * Renders the `where` fragment for an aggregation. Always opens with the
   * tenant and the soft-delete guard: the aggregation path builds its own SQL
   * and does not inherit the `deleted_at IS NULL` the item endpoints add.
   */
  private buildWhere(
    ctx: CallerContext,
    filters: Filter[],
    check: (name: string) => string,
    isArrayColumn: (name: string) => boolean = () => false,
  ): string {
    const parts = [
      `"deleted_at" IS NULL`,
      `"companies_id" = ${sqlLiteral(ctx.companiesId)}`,
    ];

    for (const f of filters) {
      const col = sqlIdentifier(check(f.field));
      const isArray = isArrayColumn(f.field);

      if (isArray && ["gt", "gte", "lt", "lte"].includes(f.op)) {
        throw new UcodeError(
          `Column "${f.field}" holds a list of values; compare it with eq or in, not ${f.op}.`,
          400,
        );
      }

      switch (f.op) {
        case "eq":
          parts.push(
            isArray
              ? `${col}::text[] && ARRAY[${sqlLiteral(scalar(f.value))}]::text[]`
              : `${col} = ${sqlLiteral(scalar(f.value))}`,
          );
          break;
        case "contains":
          parts.push(`${col}::text ILIKE ${sqlLiteral(`%${scalar(f.value)}%`)}`);
          break;
        case "in": {
          const values = Array.isArray(f.value) ? f.value : [f.value];
          if (values.length === 0) {
            throw new UcodeError(`Filter "${f.field} in []" has no values.`, 400);
          }
          const list = values.map(sqlLiteral).join(", ");
          // An array column overlaps the wanted set; a scalar one is a member.
          parts.push(
            isArray
              ? `${col}::text[] && ARRAY[${list}]::text[]`
              : `${col} IN (${list})`,
          );
          break;
        }
        case "gt":
          parts.push(`${col} > ${sqlLiteral(scalar(f.value))}`);
          break;
        case "gte":
          parts.push(`${col} >= ${sqlLiteral(scalar(f.value))}`);
          break;
        case "lt":
          parts.push(`${col} < ${sqlLiteral(scalar(f.value))}`);
          break;
        case "lte":
          parts.push(`${col} <= ${sqlLiteral(scalar(f.value))}`);
          break;
      }
    }
    return parts.join(" AND ");
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  async create(
    ctx: CallerContext,
    table: string,
    data: Record<string, unknown>,
  ): Promise<UcodeItem> {
    const body = await this.request(ctx, "POST", `/v2/items/${table}`, {
      data: { ...(await this.coerce(ctx, table, data)), companies_id: ctx.companiesId },
    });
    return (unwrap(body) as { response?: UcodeItem })?.response ?? {};
  }

  async update(
    ctx: CallerContext,
    table: string,
    guid: string,
    data: Record<string, unknown>,
  ): Promise<UcodeItem> {
    const body = await this.request(ctx, "PUT", `/v2/items/${table}`, {
      data: {
        ...(await this.coerce(ctx, table, data)),
        guid,
        companies_id: ctx.companiesId,
      },
    });
    return (unwrap(body) as { response?: UcodeItem })?.response ?? {};
  }

  /**
   * Shapes values to their column's type before a write.
   *
   * status, gender and language are Postgres arrays, and a model writing
   * `status: "dismissed"` is writing the obvious thing — but the column holds
   * `["dismissed"]`, and a bare string either errors or leaves a row whose
   * status no longer matches any query that filters on it. The read path
   * already wraps array values (FilterCompiler does it for filters); this is
   * the same rule on the way in.
   */
  private async coerce(
    ctx: CallerContext,
    table: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fields = await this.fields(ctx, table);
    const byName = new Map(fields.map((f) => [f.slug, f]));
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      const isArrayColumn = ARRAY_FIELD_TYPES.has(byName.get(key)?.type ?? "");
      if (isArrayColumn && value !== null && !Array.isArray(value)) {
        out[key] = [value];
      } else if (!isArrayColumn && Array.isArray(value)) {
        throw new UcodeError(
          `Column "${key}" on ${table} holds a single value, not a list.`,
          400,
        );
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async remove(ctx: CallerContext, table: string, guid: string): Promise<void> {
    await this.request(ctx, "DELETE", `/v2/items/${table}`, {
      ids: [guid],
      companies_id: ctx.companiesId,
    });
  }

  /** Calls an HRMS cloud function (the report gateway). */
  async invokeFunction(
    ctx: CallerContext,
    fn: string,
    method: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const body = await this.request(ctx, "POST", `/v2/invoke_function/${fn}`, {
      data: {
        method,
        data: { ...data, companies_id: ctx.companiesId },
      },
    });
    return findResult(body);
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /**
   * One request as the Caller. `opts.serviceKey` swaps the Caller's bearer for
   * the service API key — used only for the Copilot's own bookkeeping
   * collections, never for HRMS data.
   */
  async request(
    ctx: CallerContext | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
    opts: { serviceKey?: boolean } = {},
  ): Promise<unknown> {
    const url = new URL(this.config.ucode.baseUrl + path);
    url.searchParams.set("project-id", this.config.ucode.projectId);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // The cloud-function gateway rejects a user bearer that arrives with an
    // Environment-Id ("user not access environment"), while the item routes
    // require one. The HRMS SPA draws the same line: its shared axios client
    // sets the header, and reports.service.ts posts to invoke_function without
    // it. Mirror that split rather than a single global header.
    if (!path.startsWith("/v2/invoke_function/")) {
      headers["Environment-Id"] = this.config.ucode.environmentId;
    }
    if (opts.serviceKey) {
      const key = this.config.ucode.serviceApiKey;
      if (!key) {
        throw new UcodeError("No ucode service API key configured.", 500);
      }
      headers.Authorization = "API-KEY";
      headers["X-Api-Key"] = key;
    } else {
      if (!ctx) throw new UcodeError("No caller context for a ucode call.", 500);
      headers.Authorization = `Bearer ${ctx.token}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(
        `ucode ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
      );
      throw new UcodeError(
        res.status === 401 || res.status === 403
          ? "You don't have access to that data."
          : `Request to the HRMS backend failed (${res.status}).`,
        res.status,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UcodeError(
        "The HRMS backend returned a malformed response.",
        502,
      );
    }
  }
}

// ─── Response shapes ────────────────────────────────────────────────────────

/**
 * ucode nests its payload as `{ data: { data: <payload> } }` on the item
 * endpoints; some routes return one level less. Mirrors the unwrapping the HRMS
 * SPA already does in its axios response interceptor.
 */
const unwrap = (body: unknown): unknown => {
  const b = body as { data?: { data?: unknown } } | null;
  return b?.data?.data ?? b?.data ?? body;
};

/**
 * The cloud-function gateway nests its result inconsistently — the HRMS SPA
 * carries the same recursive unwrapper for the calendar feed
 * (`attendanceCalendar.service.ts`). Walk down a lone `data`/`response` wrapper
 * until something with real shape appears.
 */
const findResult = (body: unknown, depth = 0): unknown => {
  if (depth > 6 || body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 1 && (keys[0] === "data" || keys[0] === "response")) {
    return findResult((body as Record<string, unknown>)[keys[0]], depth + 1);
  }
  return body;
};

/**
 * Digs the rows out of the aggregation response.
 *
 * That endpoint nests one level deeper than the item routes — the real payload
 * is `{data:{data:{data:[...]}}}` — so unwrapping like an item list yields an
 * object, not an array. Reading only `.response` (the item shape) silently
 * produced an empty result for every aggregation: no error, no rows, and the
 * model dutifully reporting that nothing matched.
 */
const extractAggregateRows = (body: unknown): AggregateRow[] => {
  let node: unknown = body;
  for (let depth = 0; depth < 6; depth++) {
    if (Array.isArray(node)) return node as AggregateRow[];
    if (!node || typeof node !== "object") return [];
    const rec = node as Record<string, unknown>;
    const next = rec.data ?? rec.response ?? rec.rows;
    if (next === undefined) return [];
    node = next;
  }
  return [];
};

const scalar = (v: unknown): string | number | boolean => {
  if (Array.isArray(v)) {
    throw new UcodeError("This filter takes a single value, not a list.", 400);
  }
  return v as string | number | boolean;
};

/** Reads `{ columns: [{ name, type }] }` out of the schema endpoint. */
const extractSchemaColumns = (body: unknown): FieldDef[] => {
  const raw = unwrap(body) as { columns?: unknown } | null;
  const columns = Array.isArray(raw?.columns) ? raw.columns : [];
  return columns
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const col = c as Record<string, unknown>;
      const slug = typeof col.name === "string" ? col.name : null;
      if (!slug) return null;
      const pgType = typeof col.type === "string" ? col.type : "text";
      return {
        slug,
        label: columnLabel(slug),
        type: mapPgType(pgType, slug),
      } satisfies FieldDef;
    })
    .filter((f): f is FieldDef => f !== null);
};

/**
 * Postgres type to the shape the rest of the copilot reasons about.
 *
 * Two mappings carry real weight. An array column has to come back as
 * MULTISELECT, because that is what makes the filter compiler wrap a scalar so
 * the backend emits an overlap test instead of comparing an array to a string —
 * `status`, `gender` and `language` are all arrays in HRMS. And a date has to
 * be recognisable, because that is how the chart picker knows to plot a trend in
 * chronological order rather than a bar per category.
 */
/** ucode field types that hold a list rather than a single value. */
const ARRAY_FIELD_TYPES = new Set(["MULTISELECT", "MULTI_SELECT", "MULTISELECT_ID"]);

const mapPgType = (pgType: string, slug: string): string => {
  const t = pgType.toLowerCase();
  if (t.includes("[]") || t.startsWith("_") || t === "array") return "MULTISELECT";
  if (t.startsWith("timestamp") || t === "datetime") return "DATE_TIME";
  if (t === "date") return "DATE";
  if (t.startsWith("time")) return "TIME";
  if (t === "boolean" || t === "bool") return "BOOLEAN";
  if (
    t.startsWith("int") ||
    t === "numeric" ||
    t === "real" ||
    t === "double precision" ||
    t === "bigint" ||
    t === "smallint"
  ) {
    return "NUMBER";
  }
  if (t === "jsonb" || t === "json") return "JSON";
  if (t === "uuid") return slug === "guid" ? "UUID" : "LOOKUP";
  return "SINGLE_LINE";
};

/** Type guessed from one sample value, for the fallback path. */
const inferType = (slug: string, value: unknown): string => {
  if (Array.isArray(value)) return "MULTISELECT";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "DATE_TIME";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "DATE";
  }
  if (slug === "guid") return "UUID";
  if (slug.endsWith("_id")) return "LOOKUP";
  return "SINGLE_LINE";
};
