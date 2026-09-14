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
  caller: { userId: "user-1", companiesId: "company-a", projectId: "project-1", token: "tok" },
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
  get_daily_status: {
    date: "2026-09-11",
    counts: { late: 2, on_time: 40, absent: 3, on_absence_policy: 1, remote: 0, total: 46 },
    late: [
      {
        guid: "e1",
        full_name: "Иванов Иван",
        department_title: "Разработка",
        check_in_time: "09:21",
        delay_time: "00:21",
        delay_minutes: 21,
      },
      {
        guid: "e2",
        full_name: "Петров Пётр",
        department_title: "Продажи",
        check_in_time: "09:05",
        delay_time: "00:05",
        delay_minutes: 5,
      },
    ],
    on_time: [],
    absent: [
      {
        guid: "e3",
        full_name: "Сидоров Сидор",
        department_title: "Разработка",
        reason: "no_check_in",
      },
    ],
    on_absence_policy: [],
    remote: [],
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

describe("run_report: daily_status", () => {
  /**
   * The question the whole report exists for — "кто опоздал вчера" — which a
   * filter on the attendance table cannot answer: lateness there is an array
   * membership OR a "ЧЧ:ММ" string parsed to minutes, over one dominant row
   * per person per day.
   */
  it("answers who was late, and only who was late", async () => {
    const result = await tool().execute(
      { report: "daily_status", date: "2026-09-11", bucket: "late" },
      ctx,
    );

    expect(result.tables).toHaveLength(1);
    expect(result.tables?.[0].title).toBe("Опоздавшие");
    expect(result.tables?.[0].rows).toEqual([
      {
        employee: "Иванов Иван",
        department: "Разработка",
        check_in: "09:21",
        delay: "00:21",
      },
      {
        employee: "Петров Пётр",
        department: "Продажи",
        check_in: "09:05",
        delay: "00:05",
      },
    ]);
    // The four other lists are not the question and must not be on screen.
    expect(JSON.stringify(result.tables)).not.toContain("Сидоров");
  });

  it("shows the counts alone when no bucket was asked for", async () => {
    const result = await tool().execute(
      { report: "daily_status", date: "2026-09-11" },
      ctx,
    );

    expect(result.tables).toBeUndefined();
    expect(result.kpis?.map((k) => k.value)).toEqual(["2", "40", "3", "1", "0"]);
  });

  it("draws no table for an empty list, and says so", async () => {
    const result = await tool().execute(
      { report: "daily_status", date: "2026-09-11", bucket: "on_time" },
      ctx,
    );

    expect(result.tables).toBeUndefined();
    expect((result.data as Record<string, unknown>).note).toContain("Nobody");
  });

  it("refuses a day it cannot ask the gateway for", async () => {
    // Without this the gateway rejects the call and the person sees a generic
    // failure instead of the model simply passing a date.
    await expect(
      tool().execute({ report: "daily_status", date: "вчера" }, ctx),
    ).rejects.toThrow(/date like/);
    await expect(
      tool().execute({ report: "daily_status" }, ctx),
    ).rejects.toThrow(/date like/);
  });

  it("rejects an unknown bucket before calling the gateway", async () => {
    const run = tool();
    await expect(
      run.execute(
        { report: "daily_status", date: "2026-09-11", bucket: "опоздавшие" },
        ctx,
      ),
    ).rejects.toThrow(/Unknown bucket/);
  });

  it("names the reason an absent person is absent", async () => {
    const result = await tool().execute(
      { report: "daily_status", date: "2026-09-11", bucket: "absent" },
      ctx,
    );

    expect(result.tables?.[0].rows[0]).toMatchObject({
      employee: "Сидоров Сидор",
      reason: "Нет отметки прихода",
    });
  });
});
