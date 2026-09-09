import { rowLabel } from "./labels";

describe("rowLabel", () => {
  /**
   * The regression this exists for: a lookup that only knew about `title` and
   * `name` answered every employee with the guid it was handed, which is how a
   * chart grouped by user_base_id ended up with an axis of uuids.
   */
  it("names a person from their three name columns", () => {
    expect(
      rowLabel({
        guid: "u1",
        first_name: "Азиз",
        second_name: "Каримов",
        middle_name: null,
      }),
    ).toBe("Каримов Азиз");
  });

  it("falls back to a title for a row that is not a person", () => {
    expect(rowLabel({ guid: "d1", title: "Разработка" })).toBe("Разработка");
  });

  it("returns null when a row has no human handle, so the caller decides", () => {
    expect(rowLabel({ guid: "x1", salary: 100 })).toBeNull();
    expect(rowLabel({ guid: "x2", title: "   " })).toBeNull();
  });
});
