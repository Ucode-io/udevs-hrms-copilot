import { BadRequestException } from "@nestjs/common";
import type { FieldDef, Filter, ListQuery } from "./ucode.types";

/**
 * ucode field types whose column holds an array, where a scalar equality filter
 * has to be sent as a one-element array so the backend emits `&&` (overlap)
 * rather than `=`. In HRMS this is how `status`, `gender` and `language` behave.
 */
const ARRAY_TYPES = new Set(["MULTISELECT", "MULTI_SELECT", "MULTISELECT_ID"]);

/**
 * Compiles structured Filters into the `data` object the ucode item API expects.
 *
 * Two invariants make this safe to hand a language model:
 *
 * 1. **Every field is checked against the table's real columns.** `build_query.go`
 *    silently drops a filter whose key is not a known field, so an invented
 *    column name would not fail — it would quietly widen the result to the whole
 *    table and the model would present that as the answer. We reject instead.
 * 2. **Only the five supported comparison operators are ever emitted.** Anything
 *    else would produce a parameter the statement never binds.
 */
export class FilterCompiler {
  constructor(private readonly fields: Map<string, FieldDef>) {}

  static from(fields: FieldDef[]): FilterCompiler {
    return new FilterCompiler(new Map(fields.map((f) => [f.slug, f])));
  }

  /** Column names, for error messages that let the model correct itself. */
  private known(): string {
    return [...this.fields.keys()].sort().join(", ");
  }

  private field(name: string): FieldDef {
    const f = this.fields.get(name);
    if (!f) {
      throw new BadRequestException(
        `Unknown column "${name}". Available columns: ${this.known()}`,
      );
    }
    return f;
  }

  /**
   * Builds the `data` payload for `GET /v2/items/:table`. `companies_id` is NOT
   * added here — the client injects it from the caller context so no path
   * through this compiler can be talked out of it.
   */
  compileList(query: ListQuery): Record<string, unknown> {
    const data: Record<string, unknown> = {
      limit: clamp(query.limit ?? 20, 1, 100),
      offset: Math.max(0, query.offset ?? 0),
    };

    if (query.search) data.search = query.search;
    if (query.withRelations) data.with_relations = true;

    if (query.sort) {
      const f = this.field(query.sort.field);
      // `buildOrderClause` skips `created_at` outright, so ordering by it is a
      // silent no-op rather than an error. Say so instead of pretending.
      if (f.slug === "created_at") {
        throw new BadRequestException(
          `Sorting by created_at is not supported by this API; results already come back newest-first.`,
        );
      }
      data.order = { [f.slug]: query.sort.direction === "asc" ? 1 : -1 };
    }

    for (const filter of query.filters ?? []) {
      this.applyFilter(data, filter);
    }

    return data;
  }

  /** Merges one filter into the payload, combining ranges on the same column. */
  private applyFilter(data: Record<string, unknown>, filter: Filter): void {
    const field = this.field(filter.field);
    const { op, value } = filter;

    switch (op) {
      case "in": {
        const arr = Array.isArray(value) ? value : [value];
        if (arr.length === 0) {
          throw new BadRequestException(
            `Filter "${field.slug} in []" has no values.`,
          );
        }
        // A bare array is compiled to `= ANY(...)` (or `&&` on an array column),
        // which is what "one of" means. The `$in` operator casts the column to
        // VARCHAR first, so the plain array is the better encoding.
        data[field.slug] = arr;
        return;
      }

      case "eq": {
        if (Array.isArray(value)) {
          throw new BadRequestException(
            `Filter "${field.slug} eq" takes a single value; use "in" for a list.`,
          );
        }
        // An array-valued column needs a one-element array so the backend emits
        // an overlap test rather than comparing an array to a scalar.
        data[field.slug] = ARRAY_TYPES.has(field.type) ? [value] : value;
        return;
      }

      case "contains": {
        if (typeof value !== "string") {
          throw new BadRequestException(
            `Filter "${field.slug} contains" takes a string.`,
          );
        }
        // Text columns compile to a case-insensitive regex match. There is no
        // exact-match encoding for them: the value is regex-quoted server-side,
        // so anchors can't be smuggled in.
        data[field.slug] = value;
        return;
      }

      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (Array.isArray(value)) {
          throw new BadRequestException(
            `Filter "${field.slug} ${op}" takes a single value.`,
          );
        }
        const existing = data[field.slug];
        const range: Record<string, unknown> =
          existing !== undefined && isRange(existing)
            ? { ...existing }
            : existing !== undefined
              ? (() => {
                  throw new BadRequestException(
                    `Column "${field.slug}" already has a non-range filter; combine ranges only.`,
                  );
                })()
              : {};
        range[`$${op}`] = value;
        data[field.slug] = range;
        return;
      }

      default: {
        // Exhaustiveness guard: a new FilterOp must be wired here deliberately,
        // never fall through to the backend as an unknown `$op`.
        const never: never = op;
        throw new BadRequestException(`Unsupported filter operator: ${never}`);
      }
    }
  }
}

const isRange = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(n)));
