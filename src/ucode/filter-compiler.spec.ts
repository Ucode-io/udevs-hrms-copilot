import { BadRequestException } from "@nestjs/common";
import { FilterCompiler } from "./filter-compiler";
import type { FieldDef } from "./ucode.types";

const fields: FieldDef[] = [
  { slug: "guid", label: "Guid", type: "UUID" },
  { slug: "first_name", label: "First name", type: "SINGLE_LINE" },
  { slug: "birth_date", label: "Birth date", type: "DATE" },
  { slug: "status", label: "Status", type: "MULTISELECT" },
  { slug: "departments_id", label: "Department", type: "LOOKUP" },
  { slug: "created_at", label: "Created", type: "DATE_TIME" },
];

const compiler = FilterCompiler.from(fields);

describe("FilterCompiler", () => {
  it("compiles an age range into one date range on birth_date", () => {
    // The question this exists for: "employees younger than 22 and older
    // than 19". There is no age column, so both bounds land on birth_date and
    // must merge into a single range rather than one overwriting the other.
    const data = compiler.compileList({
      filters: [
        { field: "birth_date", op: "gt", value: "2004-01-15" },
        { field: "birth_date", op: "lte", value: "2007-01-15" },
      ],
    });

    expect(data.birth_date).toEqual({
      $gt: "2004-01-15",
      $lte: "2007-01-15",
    });
  });

  it("rejects a column the table does not have", () => {
    // The backend silently ignores an unknown filter key, which would return
    // every row and read exactly like a correct answer. Failing loudly is the
    // whole point.
    expect(() =>
      compiler.compileList({ filters: [{ field: "age", op: "gt", value: 19 }] }),
    ).toThrow(BadRequestException);
  });

  it("names the real columns when it rejects one, so the model can correct itself", () => {
    expect(() =>
      compiler.compileList({ filters: [{ field: "age", op: "gt", value: 19 }] }),
    ).toThrow(/birth_date/);
  });

  it("wraps a scalar in an array for an array-valued column", () => {
    // status is MULTISELECT; a bare scalar would compare an array column to a
    // string, so the one-element array is what makes the backend emit an
    // overlap test.
    const data = compiler.compileList({
      filters: [{ field: "status", op: "eq", value: "active" }],
    });
    expect(data.status).toEqual(["active"]);
  });

  it("leaves a scalar column alone", () => {
    const data = compiler.compileList({
      filters: [{ field: "departments_id", op: "eq", value: "dept-1" }],
    });
    expect(data.departments_id).toBe("dept-1");
  });

  it("sends 'in' as a plain array", () => {
    const data = compiler.compileList({
      filters: [{ field: "guid", op: "in", value: ["a", "b"] }],
    });
    expect(data.guid).toEqual(["a", "b"]);
  });

  it("refuses to mix a range with an equality on the same column", () => {
    expect(() =>
      compiler.compileList({
        filters: [
          { field: "birth_date", op: "eq", value: "2000-01-01" },
          { field: "birth_date", op: "gt", value: "1990-01-01" },
        ],
      }),
    ).toThrow(BadRequestException);
  });

  it("rejects an empty 'in' list rather than silently matching nothing", () => {
    expect(() =>
      compiler.compileList({ filters: [{ field: "guid", op: "in", value: [] }] }),
    ).toThrow(BadRequestException);
  });

  it("rejects a list where a single value is required", () => {
    expect(() =>
      compiler.compileList({
        filters: [{ field: "birth_date", op: "gt", value: ["a", "b"] }],
      }),
    ).toThrow(BadRequestException);
  });

  it("says so when asked to sort by created_at, which the backend ignores", () => {
    // buildOrderClause skips created_at outright, so accepting it would mean
    // promising an ordering that never happens.
    expect(() =>
      compiler.compileList({ sort: { field: "created_at", direction: "asc" } }),
    ).toThrow(BadRequestException);
  });

  it("maps sort direction onto the backend's 1/-1 encoding", () => {
    expect(
      compiler.compileList({ sort: { field: "first_name", direction: "asc" } })
        .order,
    ).toEqual({ first_name: 1 });
    expect(
      compiler.compileList({ sort: { field: "first_name", direction: "desc" } })
        .order,
    ).toEqual({ first_name: -1 });
  });

  it("clamps the page size", () => {
    expect(compiler.compileList({ limit: 5000 }).limit).toBe(100);
    expect(compiler.compileList({ limit: 0 }).limit).toBe(1);
    expect(compiler.compileList({}).limit).toBe(20);
  });

  it("never emits a Company itself — the client owns that", () => {
    // Tenancy is injected by UcodeClient from the CallerContext. If the compiler
    // also wrote it, a model-supplied filter could plausibly compete with it.
    const data = compiler.compileList({
      filters: [{ field: "first_name", op: "contains", value: "ali" }],
    });
    expect(data.companies_id).toBeUndefined();
  });
});
