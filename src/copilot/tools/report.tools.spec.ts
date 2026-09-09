import { CopilotReportTools } from "./report.tools";
import { TableCatalog } from "../prompt/catalog";
import { UcodeClient } from "../../ucode/ucode.client";
import type { CopilotConfig } from "../../config/configuration";
import type { CopilotTool, CopilotToolContext } from "./tool.types";

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
  route: "/tasks",
};

/** What the gateway answers; invokeFunction unwraps to `{method, result}`. */
const GATEWAY = {
  task_list: {
    tasks: [
      { id: "t1", code: "TASK-001", title: "Task1", statusId: "s-todo", priorityId: "p-mid", assigneeIds: [], deadline: "2026-08-09T00:00:00Z" },
      { id: "t2", code: "TASK-002", title: "Task 1", statusId: "s-doing", priorityId: "p-mid", assigneeIds: ["e1"], deadline: null },
      { id: "t3", code: "TASK-003", title: "Готово", statusId: "s-done", priorityId: null, assigneeIds: ["e1"], deadline: null },
    ],
    employees: [{ id: "e1", name: "Азиз Каримов" }],
  },
  task_directories_get: {
    statuses: [
      { id: "s-todo", title: "К выполнению", group: "todo" },
      { id: "s-doing", title: "В работе", group: "in progress" },
      // No `group` at all: the legacy isFinal flag is the only marker of done.
      { id: "s-done", title: "Завершено", isFinal: true },
    ],
    priorities: [{ id: "p-mid", title: "Средний" }],
  },
};

const tool = (): CopilotTool => {
  const ucode = {
    invokeFunction: jest.fn(async (_c, _fn, method: string) => ({
      method,
      result: GATEWAY[method as keyof typeof GATEWAY],
    })),
  } as unknown as UcodeClient;

  const tools = new CopilotReportTools(ucode, new TableCatalog(), config);
  const found = tools.getTools().find((t) => t.name === "run_report");
  if (!found) throw new Error("run_report is not registered");
  return found;
};

describe("run_report: tasks", () => {
  /**
   * The question this report exists for. "Not finished" is not a row count —
   * it is every task whose status is not in the done group.
   */
  it("counts what is not finished, across both unfinished groups", async () => {
    const result = await tool().execute({ report: "tasks" }, ctx);
    const data = result.data as Record<string, unknown>;

    expect(data.total).toBe(3);
    expect(data.notFinished).toBe(2);
    expect(data.byStatusGroup).toEqual({ todo: 1, in_progress: 1, completed: 1 });
  });

  it("shows titles rather than ids, and names the assignee", async () => {
    const result = await tool().execute({ report: "tasks" }, ctx);
    const rows = result.tables?.[0].rows ?? [];

    expect(rows[0]).toMatchObject({ code: "TASK-001", status: "К выполнению" });
    expect(rows[1]).toMatchObject({ status: "В работе", assignee: "Азиз Каримов" });
    expect(JSON.stringify(rows)).not.toContain("s-todo");
  });

  it("draws nothing and quotes the rows when the call is a lookup", async () => {
    const result = await tool().execute({ report: "tasks", lookup_only: true }, ctx);

    expect(result.tables).toBeUndefined();
    expect((result.data as Record<string, unknown>).rows).toHaveLength(3);
  });
});
