import { BadRequestException } from "@nestjs/common";

/**
 * The aggregation endpoint (`POST /v2/items/:table/aggregation`) takes `where`
 * as a raw SQL fragment pasted into the generated statement — there are no bind
 * parameters on that path. Everything we put in it therefore has to be
 * literal-escaped here, and every identifier has to come from the table's real
 * column list (the caller checks that before building a fragment).
 *
 * The model never contributes a character to these strings: it fills a
 * structured Filter, and this module renders it.
 */

/** Matches a NUL byte, which Postgres cannot store in a text value at all. */
const NUL = /\u0000/;

/** Escapes a value as a Postgres literal. Rejects anything not renderable. */
export const sqlLiteral = (value: string | number | boolean): string => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("Non-finite number in filter value.");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value !== "string") {
    throw new BadRequestException("Unsupported filter value type.");
  }
  if (NUL.test(value)) {
    throw new BadRequestException("Filter value contains a NUL byte.");
  }
  // Standard SQL single-quote escaping.
  return `'${value.replace(/'/g, "''")}'`;
};

/**
 * Validates a column name for use as a bare identifier. Callers must already
 * have checked the name against the table's fields; this is the second gate, so
 * a mistake upstream still cannot emit arbitrary SQL.
 */
export const sqlIdentifier = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new BadRequestException(`Invalid column name: ${name}`);
  }
  return `"${name}"`;
};
