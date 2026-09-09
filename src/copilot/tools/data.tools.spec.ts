import { CopilotDataTools } from "./data.tools";
import { TableCatalog } from "../prompt/catalog";
import { UcodeClient } from "../../ucode/ucode.client";
import type { CopilotConfig } from "../../config/configuration";
import type { CopilotTool, CopilotToolContext } from "./tool.types";
import type { FieldDef, Filter } from "../../ucode/ucode.types";

const config: CopilotConfig = {
  port: 8080,
  corsOrigins: [],
  anthropicApiKey: null,
  model: "claude-sonnet-5",
  effort: "high",
  maxConcurrentStreams: 2,
  ucode: {
    baseUrl: "https://ucode.test",
    projectId: "project-1",
    environmentId: "env-1",
    serviceApiKey: null,
  },
  hrms: {
    employeeRoleId: "role-employee",
    clientTypeId: "client-type-1",
    reportsFunction: "reports-fn",
  },
};

const ctx: CopilotToolContext = {
  caller: { userId: "user-1", companiesId: "company-a", token: "tok" },
  route: "/employees",
};

const EMPLOYEE_FIELDS: FieldDef[] = [
  { slug: "guid", label: "Guid", type: "UUID" },
  { slug: "first_name", label: "Имя", type: "SINGLE_LINE" },
  { slug: "second_name", label: "Фамилия", type: "SINGLE_LINE" },
  { slug: "birth_date", label: "Дата рождения", type: "DATE" },
  { slug: "status", label: "Статус", type: "MULTISELECT" },
  { slug: "role_id", label: "Роль", type: "LOOKUP" },
  { slug: "departments_id", label: "Отдел", type: "LOOKUP" },
  // No `*_id_data` entries on purpose: those are synthesised by the backend's
  // with_relations flag and never appear in the table's real schema, so the
  // Copilot has to derive them from the id column.
  { slug: "positions_id", label: "Должность", type: "LOOKUP" },
  { slug: "date_hire", label: "Дата найма", type: "DATE" },
  { slug: "phone", label: "Телефон", type: "SINGLE_LINE" },
];

/** A UcodeClient whose network calls are replaced, capturing what was asked. */
const stubClient = (
  listResult: { count: number; response: Array<Record<string, unknown>> } = {
    count: 0,
    response: [],
  },
): {
  client: UcodeClient;
  listCalls: Array<{ table: string; query: unknown }>;
  aggregateCalls: Array<{ table: string; query: unknown }>;
} => {
  const client = new UcodeClient(config);
  const listCalls: Array<{ table: string; query: unknown }> = [];
  const aggregateCalls: Array<{ table: string; query: unknown }> = [];

  jest.spyOn(client, "fields").mockResolvedValue(EMPLOYEE_FIELDS);
  jest.spyOn(client, "list").mockImplementation(async (_c, table, query) => {
    listCalls.push({ table, query });
    return listResult;
  });
  jest.spyOn(client, "aggregate").mockImplementation(async (_c, table, query) => {
    aggregateCalls.push({ table, query });
    return [
      { departments_id: "dept-1", total: 7 },
      { departments_id: "dept-2", total: 3 },
    ];
  });

  return { client, listCalls, aggregateCalls };
};

const toolNamed = (tools: CopilotTool[], name: string): CopilotTool => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe("CopilotDataTools", () => {
  describe("list_items", () => {
    it("passes an age range through as a birth_date range", async () => {
      // The headline scenario: "employees younger than 22 and older than 19".
      // There is no age column, so the model converts to dates and the range has
      // to survive intact all the way to the query.
      const { client, listCalls } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await toolNamed(tools, "list_items").execute(
        {
          table: "user_base",
          filters: [
            { field: "birth_date", op: "gt", value: "2004-01-15" },
            { field: "birth_date", op: "lte", value: "2007-01-15" },
          ],
        },
        ctx,
      );

      expect(listCalls).toHaveLength(1);
      expect(listCalls[0].query).toMatchObject({
        filters: expect.arrayContaining([
          { field: "birth_date", op: "gt", value: "2004-01-15" },
          { field: "birth_date", op: "lte", value: "2007-01-15" },
        ]),
      });
    });

    it("restricts user_base to employees even when the model forgets", async () => {
      // user_base holds every kind of account. Without role_id the count silently
      // includes non-staff — a wrong number that looks exactly like a right one.
      const { client, listCalls } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await toolNamed(tools, "list_items").execute({ table: "user_base" }, ctx);

      const filters = (listCalls[0].query as { filters: unknown[] }).filters;
      expect(filters).toContainEqual({
        field: "role_id",
        op: "eq",
        value: "role-employee",
      });
    });

    it("tells the model that it applied that default", async () => {
      // A silent default is a lie by omission: the person should be told the
      // headcount excludes non-employees.
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base" },
        ctx,
      );

      expect((result.data as { defaultsApplied?: string[] }).defaultsApplied)
        .toBeDefined();
    });

    it("counts only current staff unless asked otherwise", async () => {
      // A headcount that includes leavers disagrees with every screen in the
      // product, and nobody asking "how many people are in Sales" means it.
      const { client, listCalls } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await toolNamed(tools, "list_items").execute({ table: "user_base" }, ctx);

      const { filters } = listCalls[0].query as { filters: Filter[] };
      expect(filters).toContainEqual({ field: "status", op: "eq", value: "active" });
    });

    it("leaves the status alone when the question is about leavers", async () => {
      const { client, listCalls } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await toolNamed(tools, "list_items").execute(
        {
          table: "user_base",
          filters: [{ field: "status", op: "eq", value: "dismissed" }],
        },
        ctx,
      );

      const { filters } = listCalls[0].query as { filters: Filter[] };
      expect(filters.filter((f) => f.field === "status")).toEqual([
        { field: "status", op: "eq", value: "dismissed" },
      ]);
    });

    it("does not override an explicit role filter", async () => {
      const { client, listCalls } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await toolNamed(tools, "list_items").execute(
        {
          table: "user_base",
          filters: [{ field: "role_id", op: "eq", value: "role-manager" }],
        },
        ctx,
      );

      const filters = (listCalls[0].query as { filters: Array<{ value: string }> })
        .filters;
      expect(filters.filter((f) => f.value === "role-employee")).toHaveLength(0);
    });

    it("renders rows as a table and keeps the model's copy short", async () => {
      // The rows are on screen already; echoing all of them back would spend
      // tokens and invite the model to retype a name incorrectly.
      const { client } = stubClient({
        count: 42,
        response: Array.from({ length: 20 }, (_, i) => ({
          guid: `e${i}`,
          first_name: `Имя${i}`,
          second_name: `Фамилия${i}`,
        })),
      });
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base", title: "Сотрудники 19-22" },
        ctx,
      );

      expect(result.tables?.[0].rows).toHaveLength(20);
      expect(result.tables?.[0].totalCount).toBe(42);
      // The person gets every fetched row; the model gets a bounded quote of
      // them, so a long result cannot crowd out the conversation.
      const { preview } = result.data as { preview: unknown[] };
      expect(preview.length).toBeLessThanOrEqual(30);
      expect(preview.length).toBeLessThanOrEqual(result.tables![0].rows.length);
    });

    it("shows a relation by name, though the schema has no such column", async () => {
      // departments_id_data is synthesised by with_relations. Dropping it left
      // an employee list with no department in it, and sent the model off to
      // list the departments table separately just to name them.
      const { client } = stubClient({
        count: 1,
        response: [
          {
            guid: "e1",
            first_name: "Имя",
            departments_id: "dept-1",
            departments_id_data: { guid: "dept-1", title: "Разработка" },
          },
        ],
      });
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base", columns: ["first_name", "departments_id_data"] },
        ctx,
      );

      expect(result.tables?.[0].columns.map((c) => c.key)).toEqual([
        "first_name",
        "departments_id_data",
      ]);
      expect(result.tables?.[0].rows[0].departments_id_data).toBe("Разработка");
    });

    it("keeps guids out of the table the person reads", async () => {
      const { client } = stubClient({
        count: 1,
        response: [{ guid: "865ced3b-fe3b-4652-bd6d-abc79a4495ea", first_name: "Имя" }],
      });
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base", columns: ["guid", "first_name"] },
        ctx,
      );

      expect(result.tables?.[0].columns.map((c) => c.key)).toEqual(["first_name"]);
      // ...but the model still gets it, or it cannot update or open the row and
      // spends a turn asking for the same list again.
      const { preview } = result.data as { preview: Array<{ guid?: string }> };
      expect(preview[0].guid).toBe("865ced3b-fe3b-4652-bd6d-abc79a4495ea");
    });

    it("hands the model a row id even when nobody asked for one", async () => {
      const { client } = stubClient({
        count: 1,
        response: [{ guid: "e-1", first_name: "Имя" }],
      });
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base", columns: ["first_name"] },
        ctx,
      );

      const { preview } = result.data as { preview: Array<{ guid?: string }> };
      expect(preview[0].guid).toBe("e-1");
    });

    it("drops a column no row filled in", async () => {
      const { client } = stubClient({
        count: 2,
        response: [
          { first_name: "Имя", phone: null },
          { first_name: "Имя2", phone: "" },
        ],
      });
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "list_items").execute(
        { table: "user_base", columns: ["first_name", "phone"] },
        ctx,
      );

      expect(result.tables?.[0].columns.map((c) => c.key)).toEqual(["first_name"]);
    });

    it("refuses a table outside the allowlist", async () => {
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await expect(
        toolNamed(tools, "list_items").execute({ table: "contracts" }, ctx),
      ).rejects.toThrow(/not available/);
    });

    it("rejects an operator the backend cannot express", async () => {
      // An unsupported operator reaches Postgres as an argument with no
      // placeholder and breaks the statement, so it is caught here.
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await expect(
        toolNamed(tools, "list_items").execute(
          {
            table: "user_base",
            filters: [{ field: "status", op: "neq", value: "dismissed" }],
          },
          ctx,
        ),
      ).rejects.toThrow(/not supported/);
    });
  });

  describe("aggregate_items", () => {
    it("builds the chart from the query result, not from model input", async () => {
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "aggregate_items").execute(
        {
          table: "user_base",
          group_by: ["departments_id"],
          metrics: [{ fn: "count", alias: "total" }],
          chart: "bar",
          title: "Сотрудники по отделам",
        },
        ctx,
      );

      const chart = result.charts?.[0];
      expect(chart?.kind).toBe("bar");
      expect(chart?.title).toBe("Сотрудники по отделам");
      // 7 and 3 come from the stubbed aggregation, so the chart can only ever
      // show what the query returned.
      expect(chart?.data.map((r) => r.total)).toEqual([7, 3]);
    });

    it("skips the chart when asked for none", async () => {
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "aggregate_items").execute(
        {
          table: "user_base",
          metrics: [{ fn: "count", alias: "total" }],
          chart: "none",
        },
        ctx,
      );

      expect(result.charts).toBeUndefined();
    });

    it("rejects a metric with no column to aggregate", async () => {
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      await expect(
        toolNamed(tools, "aggregate_items").execute(
          { table: "user_base", metrics: [] },
          ctx,
        ),
      ).rejects.toThrow(/At least one metric/);
    });
  });

  describe("describe_table", () => {
    it("substitutes the real employee role id into the hint", async () => {
      // A hint telling the model to filter by "the employee role id" is useless
      // unless the id is in it.
      const { client } = stubClient();
      const tools = new CopilotDataTools(client, new TableCatalog(), config).getTools();

      const result = await toolNamed(tools, "describe_table").execute(
        { table: "user_base" },
        ctx,
      );

      const notes = (result.data as { importantNotes: string[] }).importantNotes;
      expect(notes.join(" ")).toContain("role-employee");
      expect(notes.join(" ")).not.toContain("<the employee role id>");
    });
  });
});
