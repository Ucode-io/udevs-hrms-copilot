import { explain } from "./tool-registry.service";

/**
 * Every message here was taken from a production log on 2026-09-09, where the
 * model answered each one by retrying the same call until the turn budget ran
 * out and the person was left looking at a panel that had silently stopped.
 */
describe("explain", () => {
  it("turns a uuid syntax error into 'resolve the name first'", () => {
    const out = explain(
      'rpc error: code = Unknown desc = error while getting count: ERROR: invalid input syntax for type uuid: "Разработка" (SQLSTATE 22P02)',
    );
    expect(out).toContain("Разработка");
    expect(out).toContain("list_items");
    expect(out).not.toContain("SQLSTATE");
  });

  it("tells the model to stop retrying a search this table cannot do", () => {
    for (const type of ["date", "text[]"]) {
      const out = explain(
        `rpc error: ERROR: operator does not exist: ${type} ~* unknown (SQLSTATE 42883)`,
      );
      expect(out).toContain("Use filters instead");
      expect(out).toContain("Do not retry");
    }
  });

  it("names the array shape a column wants", () => {
    expect(explain('ERROR: malformed array literal: "active"')).toContain("list");
  });

  it("sends an unknown column back to describe_table", () => {
    const out = explain('ERROR: column "salery" does not exist');
    expect(out).toContain("salery");
    expect(out).toContain("describe_table");
  });

  it("leaves anything it does not recognise alone", () => {
    expect(explain("Conversation not found")).toBe("Conversation not found");
  });
});
