import { CopilotMutationTools } from "./mutation.tools";
import { TableCatalog } from "../prompt/catalog";
import { UcodeClient } from "../../ucode/ucode.client";
import type { CopilotConfig } from "../../config/configuration";
import type { CopilotTool, CopilotToolContext } from "./tool.types";
import type { FieldDef } from "../../ucode/ucode.types";

const config: CopilotConfig = {
  port: 8080,
  corsOrigins: [],
  anthropicApiKey: null,
  model: "claude-sonnet-5",
  effort: "high",
  maxConcurrentStreams: 2,
  billing: { serviceSecret: null, quotaCacheMs: 30_000 },
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
    billingFunction: "billing-fn",
  },
  telegram: {
    botToken: null,
    webhookSecret: null,
    hickvisionFunction: "hickvision-fn",
    webUrl: null,
    miniAppUrl: "https://employee.test",
  },
};

const ctx: CopilotToolContext = {
  caller: { userId: "user-1", companiesId: "company-a", projectId: "project-1", token: "tok" },
  route: null,
};

const EMPLOYEE_FIELDS: FieldDef[] = [
  { slug: "guid", label: "Guid", type: "UUID" },
  { slug: "first_name", label: "Имя", type: "SINGLE_LINE" },
  { slug: "second_name", label: "Фамилия", type: "SINGLE_LINE" },
  { slug: "date_hire", label: "Дата найма", type: "DATE" },
  { slug: "email", label: "Почта", type: "EMAIL" },
  { slug: "login", label: "Логин", type: "SINGLE_LINE" },
  { slug: "client_type_id", label: "Тип клиента", type: "LOOKUP" },
  { slug: "positions_id", label: "Должность", type: "LOOKUP" },
  { slug: "status", label: "Статус", type: "MULTISELECT" },
  { slug: "role_id", label: "Роль", type: "LOOKUP" },
  { slug: "departments_id", label: "Отдел", type: "LOOKUP" },
];

const stub = (
  onCreate?: (values: Record<string, unknown>, index: number) => void,
): {
  tools: CopilotTool[];
  creates: Array<Record<string, unknown>>;
  works: Array<Record<string, unknown>>;
  removed: Array<{ table: string; guid: string }>;
} => {
  const client = new UcodeClient(config);
  const creates: Array<Record<string, unknown>> = [];
  const works: Array<Record<string, unknown>> = [];
  const removed: Array<{ table: string; guid: string }> = [];
  // Counted separately from `creates`: a row that throws is still a row that
  // was attempted, and the hook is asked "which attempt is this".
  let attempts = 0;

  jest.spyOn(client, "fields").mockResolvedValue(EMPLOYEE_FIELDS);
  jest.spyOn(client, "getOne").mockResolvedValue({
    guid: "user-1",
    first_name: "Иван",
    second_name: "Иванов",
  });
  jest.spyOn(client, "list").mockResolvedValue({
    count: 1,
    response: [{ guid: "work-1", user_base_id: "user-1" }],
  });
  jest.spyOn(client, "remove").mockImplementation(async (_c, table, guid) => {
    removed.push({ table, guid });
  });
  jest.spyOn(client, "create").mockImplementation(async (_c, table, values) => {
    if (table === "employee_works") {
      works.push(values);
      return { guid: `work-${works.length}` };
    }
    onCreate?.(values, attempts++);
    creates.push(values);
    return { guid: `new-${creates.length}` };
  });

  return {
    tools: new CopilotMutationTools(client, new TableCatalog(), config).getTools(),
    creates,
    works,
    removed,
  };
};

const toolNamed = (tools: CopilotTool[], name: string): CopilotTool => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

/** A row shaped the way a file gives one: an email, because that is the login. */
const rows = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({
    first_name: `Имя${i + 1}`,
    second_name: `Фамилия${i + 1}`,
    email: `person${i + 1}@example.test`,
    departments_id: "dept-1",
  }));

// Creating a person writes two rows, so deleting one has to remove both —
// otherwise every delete leaves a work record pointing at a guid that is gone,
// and nothing in the Copilot can reach it afterwards.
describe("delete_item", () => {
  it("takes the work record with the person", async () => {
    const { tools, removed } = stub();

    const result = await toolNamed(tools, "delete_item").execute(
      { table: "user_base", guid: "user-1" },
      ctx,
    );

    expect(removed).toEqual([
      { table: "user_base", guid: "user-1" },
      { table: "employee_works", guid: "work-1" },
    ]);
    expect(result.data).toMatchObject({ workRecords: "1 work record(s) removed with them." });
  });

  it("leaves other tables alone", async () => {
    const { tools, removed } = stub();

    await toolNamed(tools, "delete_item").execute(
      { table: "departments", guid: "dept-1" },
      ctx,
    );

    expect(removed).toEqual([{ table: "departments", guid: "dept-1" }]);
  });
});

describe("create_items", () => {
  it("writes every row of an imported batch", async () => {
    const { tools, creates } = stub();

    const result = await toolNamed(tools, "create_items").execute(
      { table: "user_base", rows: rows(3) },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(creates).toHaveLength(3);
    expect(creates[0]).toMatchObject({ first_name: "Имя1", second_name: "Фамилия1" });
  });

  // A row written without role_id and status imports "successfully" and then
  // appears in no list anyone looks at — the failure nobody notices.
  it("creates imported people as active employees and says that it did", async () => {
    const { tools, creates } = stub();

    const result = await toolNamed(tools, "create_items").execute(
      { table: "user_base", rows: rows(2) },
      ctx,
    );

    expect(creates.every((c) => c.role_id === "role-employee")).toBe(true);
    expect(creates.every((c) => c.status === "active")).toBe(true);
    expect(result.data).toMatchObject({
      defaultsApplied: [expect.stringContaining("2 row(s)")],
    });
  });

  it("keeps a role the file actually named", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "create_items").execute(
      {
        table: "user_base",
        rows: [{ first_name: "Админ", email: "a@example.test", role_id: "role-admin" }],
      },
      ctx,
    );

    expect(creates[0].role_id).toBe("role-admin");
  });

  // user_base is an auth table: production answers a create with no credentials
  // with 500 "this table is auth table. Auth information not fully given".
  it("signs an imported person in with their email", async () => {
    const { tools, creates } = stub();

    await toolNamed(tools, "create_items").execute(
      { table: "user_base", rows: rows(1) },
      ctx,
    );

    expect(creates[0].login).toBe("person1@example.test");
    expect(creates[0].client_type_id).toBe("client-type-1");
  });

  it("refuses the whole batch when a row has no email, before writing any of it", async () => {
    const { tools, creates } = stub();

    await expect(
      toolNamed(tools, "create_items").execute(
        {
          table: "user_base",
          rows: [rows(1)[0], { first_name: "Без", second_name: "Почты" }],
        },
        ctx,
      ),
    ).rejects.toThrow(/Rows without an email: 2/);
    expect(creates).toHaveLength(0);
  });

  // A person is two rows here: who they are, and the job they hold. The SPA's
  // form writes both, and the Work section of their card reads the second.
  it("gives every imported person a work record", async () => {
    const { tools, works } = stub();

    await toolNamed(tools, "create_items").execute(
      {
        table: "user_base",
        rows: [{ ...rows(1)[0], positions_id: "pos-1", date_hire: "2026-09-01" }],
      },
      ctx,
    );

    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({
      user_base_id: "new-1",
      departments_id: "dept-1",
      positions_id: "pos-1",
      date_from: "2026-09-01",
    });
  });

  // Twenty rows written, three refused: reporting either "done" or "failed"
  // would be a lie, and the person has to know which three to fix.
  it("reports a partial import honestly", async () => {
    const { tools } = stub((_values, index) => {
      if (index === 1) throw new Error("phone already registered");
    });

    const result = await toolNamed(tools, "create_items").execute(
      { table: "user_base", rows: rows(3) },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 из 3");
    expect(result.data).toMatchObject({
      created: 2,
      failed: 1,
      failures: [{ row: 2, error: "phone already registered" }],
    });
  });

  it("fails as a whole when nothing could be written", async () => {
    const { tools } = stub(() => {
      throw new Error("permission denied");
    });

    const result = await toolNamed(tools, "create_items").execute(
      { table: "user_base", rows: rows(2) },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  // ucode drops an unknown key silently, so without this the tool would report
  // rows created with a column that never landed.
  it("refuses a batch naming a column the table does not have", async () => {
    const { tools, creates } = stub();

    await expect(
      toolNamed(tools, "create_items").execute(
        {
          table: "user_base",
          rows: [{ first_name: "Иван", email: "i@example.test", zarplata: 100 }],
        },
        ctx,
      ),
    ).rejects.toThrow(/zarplata/);
    expect(creates).toHaveLength(0);
  });

  it("refuses a batch larger than one approval should cover", async () => {
    const { tools } = stub();

    await expect(
      toolNamed(tools, "create_items").execute(
        { table: "user_base", rows: rows(201) },
        ctx,
      ),
    ).rejects.toThrow(/200/);
  });

  describe("the confirmation card", () => {
    it("spells out the rows and then collapses to a count", async () => {
      const { tools } = stub();
      const tool = toolNamed(tools, "create_items");

      const card = await tool.summarize!({ table: "user_base", rows: rows(20) }, ctx);

      expect(card.title).toContain("20 записей");
      expect(card.description).toContain("Отдел");
      // Fifteen readable lines, then one that admits to the rest.
      expect(card.changes).toHaveLength(16);
      expect(card.changes![0].after).toBe("Имя1, Фамилия1, person1@example.test");
      expect(card.changes![15].after).toBe("и ещё 5");
    });

    it("leaves relation guids off the lines a person reads", async () => {
      const { tools } = stub();
      const tool = toolNamed(tools, "create_items");

      const card = await tool.summarize!({ table: "user_base", rows: rows(1) }, ctx);

      expect(card.changes![0].after).not.toContain("dept-1");
    });
  });
});

/**
 * Read-only tables fail at the gate, not in production data. Each of these
 * writes would be accepted by ucode and land a row the page then renders
 * wrong — a shift outside its series, a survey whose body is an object, a
 * laptop reassigned with no movement history.
 */
describe("read-only tables", () => {
  it.each([
    ["create_item", { table: "shift", values: { date: "2026-09-23" } }],
    ["update_item", { table: "properties", guid: "p-1", values: { status: "assigned" } }],
    ["delete_item", { table: "surveys", guid: "s-1" }],
  ])("refuses %s and says why", async (name, input) => {
    const { tools, creates, removed } = stub();

    await expect(toolNamed(tools, name).execute(input, ctx)).rejects.toThrow(
      /can be read but not changed/,
    );
    expect(creates).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it("still lets a writable table through", async () => {
    const { tools, removed } = stub();

    await toolNamed(tools, "delete_item").execute(
      { table: "departments", guid: "dept-1" },
      ctx,
    );

    expect(removed).toHaveLength(1);
  });
});
