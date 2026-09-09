/**
 * Operators the ucode item API actually supports.
 *
 * This list is not a design choice — it is what
 * `ucode_go_object_builder_service/storage/postgres/build_query.go` implements.
 * `buildComparisonFilters` handles exactly `$gt` `$gte` `$lt` `$lte` `$in`, and
 * an unrecognised operator still appends its argument while adding no SQL
 * placeholder, so the statement arrives with more parameters than it binds and
 * Postgres rejects the whole query. Adding `neq` or `is_null` here without
 * backend support would break the request, not degrade it.
 */
export type FilterOp =
  /** Exact match. Only truly exact on `guid` and `*_id` columns — see `contains`. */
  | "eq"
  /** Case-insensitive substring match on a text column (`~*`). */
  | "contains"
  /** Value is one of a set. */
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface Filter {
  field: string;
  op: FilterOp;
  value: string | number | boolean | Array<string | number>;
}

export interface ListQuery {
  filters?: Filter[];
  /** Free-text search across the table's search-flagged columns. */
  search?: string;
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /** Pull `*_id_data` relation objects alongside the raw ids. */
  withRelations?: boolean;
}

export interface ListResult<T = UcodeItem> {
  count: number;
  response: T[];
}

export type UcodeItem = Record<string, unknown>;

/** One column as ucode describes it. */
export interface FieldDef {
  slug: string;
  label: string;
  /** ucode field type, e.g. SINGLE_LINE / NUMBER / DATE / MULTISELECT / LOOKUP. */
  type: string;
  required?: boolean;
  /** Participates in `search`. */
  isSearch?: boolean;
  /** Allowed values for PICK_LIST / MULTISELECT fields. */
  options?: string[];
  /** For relation fields, the table the id points at. */
  relationTable?: string;
}

export type AggregateMetric = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateQuery {
  /** Columns to group by. Empty means a single total row. */
  groupBy?: string[];
  metrics: Array<{ fn: AggregateMetric; field?: string; alias: string }>;
  filters?: Filter[];
  orderBy?: { alias: string; direction: "asc" | "desc" };
  limit?: number;
}

export interface AggregateRow {
  [key: string]: string | number | null;
}

/** Everything the client needs to act as one specific HRMS user. */
export interface CallerContext {
  /** ucode user id from the caller's token. */
  userId: string;
  /** The Company every request is scoped to. Never model- or client-supplied. */
  companiesId: string;
  /** The caller's raw bearer token, forwarded to ucode verbatim. */
  token: string;
}
