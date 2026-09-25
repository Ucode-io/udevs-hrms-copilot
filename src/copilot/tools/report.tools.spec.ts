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
  get_kpi_table: {
    count: 1,
    period_type: "yearly",
    period: { from: "2026-01-01", to: "2026-12-31", label: "2026 год" },
    items: [
      {
        guid: "k1",
        position: "CEO",
        title: "MRR",
        value_symbol: "$",
        value_symbol_position: "suffix",
        plan_total: 50783,
        actual_total: 50783,
        percent_total: 100,
        has_children: true,
        children: [
          {
            guid: "k2",
            position: "CEO",
            title: "План Продаж",
            value_symbol: "$",
            value_symbol_position: "suffix",
            plan_total: 2000,
            actual_total: 0,
            percent_total: 0,
            has_children: false,
            children: [],
          },
        ],
      },
    ],
    groups: [],
  },
  get_timesheet_report: {
    cards: {
      from: "2026-09-01",
      to: "2026-09-30",
      days: 30,
      employees_count: 3,
      active_employees: 2,
      idle_employees: 1,
      worked_seconds: 396000,
      plan_seconds: 432000,
      completion_rate: 91.7,
      overtime_seconds: 7200,
      shortfall_seconds: 43200,
      manual_pending_seconds: 3600,
      manual_pending_count: 2,
    },
    charts: {
      by_day: [
        { date: "2026-09-01", worked_hours: 8, plan_hours: 8 },
        { date: "2026-09-02", worked_hours: 6, plan_hours: 8 },
      ],
      top_shortfall: [
        {
          name: "Сидоров Сидор",
          department: "Разработка",
          worked_seconds: 100800,
          plan_seconds: 144000,
          deviation_seconds: -43200,
        },
      ],
      top_overtime: [
        {
          name: "Иванов Иван",
          department: "Продажи",
          worked_seconds: 151200,
          plan_seconds: 144000,
          deviation_seconds: 7200,
        },
      ],
    },
  },
  budget_get: {
    year: 2026,
    years: [2026],
    departments: [
      { id: "d1", title: "Разработка" },
      { id: "d2", title: "Продажи" },
      { id: "d3", title: "Пустой отдел" },
    ],
    rows: [
      { id: "r1", departmentId: "d1", kind: "employee", name: "Иванов Иван" },
      { id: "r2", departmentId: "d1", kind: "vacancy", name: "Backend" },
      { id: "r3", departmentId: "d2", kind: "employee", name: "Петров Пётр" },
    ],
    amounts: [
      {
        rowId: "r1",
        year: 2026,
        // January and February only; the rest of the year is still empty.
        months: [
          { plan: 1000, fact: 1000 },
          { plan: 1000, fact: 500 },
          ...Array.from({ length: 10 }, () => ({ plan: 0, fact: 0 })),
        ],
      },
      {
        rowId: "r3",
        year: 2026,
        months: [
          { plan: 700, fact: 700 },
          ...Array.from({ length: 11 }, () => ({ plan: 0, fact: 0 })),
        ],
      },
    ],
    positions: [],
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

const build = (): { run: CopilotTool; invoke: jest.Mock } => {
  const invoke = jest.fn(async (_c, _fn, method: string) => ({
    method,
    result: GATEWAY[method as keyof typeof GATEWAY],
  }));
  const ucode = { invokeFunction: invoke } as unknown as UcodeClient;

  const tools = new CopilotReportTools(ucode, new TableCatalog(), config);
  const found = tools.getTools().find((t) => t.name === "run_report");
  if (!found) throw new Error("run_report is not registered");
  return { run: found, invoke };
};

const tool = (): CopilotTool => build().run;

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

describe("run_report: kpi", () => {
  /**
   * The default has to match the KPI page, which opens on the year. A KPI
   * belongs to exactly one period type, so asking the gateway for the wrong one
   * returns an empty board rather than the same targets rolled up.
   */
  it("asks for the year by default, the view the KPI page opens on", async () => {
    const { run, invoke } = build();
    await run.execute({ report: "kpi" }, ctx);

    expect(invoke).toHaveBeenCalledWith(
      ctx.caller,
      "reports-fn",
      "get_kpi_table",
      { period_type: "yearly" },
    );
  });

  it("anchors a bare year and a month inside the period they name", async () => {
    const byYear = build();
    await byYear.run.execute({ report: "kpi", month: "2025" }, ctx);
    expect(byYear.invoke.mock.calls[0][3]).toMatchObject({ as_of_date: "2025-06-15" });

    const byMonth = build();
    await byMonth.run.execute(
      { report: "kpi", period: "monthly", month: "2026-03" },
      ctx,
    );
    expect(byMonth.invoke.mock.calls[0][3]).toMatchObject({
      period_type: "monthly",
      as_of_date: "2026-03-15",
    });
  });

  it("rejects a period the gateway does not have before calling it", async () => {
    const { run, invoke } = build();
    await expect(
      run.execute({ report: "kpi", period: "годовой" }, ctx),
    ).rejects.toThrow(/Unknown period/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("indents a child target under its parent and keeps the unit on the figure", async () => {
    const result = await tool().execute({ report: "kpi" }, ctx);
    const rows = result.tables?.[0].rows ?? [];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "MRR", percent: "100%" });
    // Grouped the Russian way, so the separator is a non-breaking space.
    expect(String(rows[0].actual).replace(/\s/g, " ")).toBe("50 783 $");
    // The child is a row of its own; only its indent says whose it is.
    expect(String(rows[1].title)).toMatch(/^  План Продаж$/);
  });

  it("counts what is behind rather than making the person read the table", async () => {
    const result = await tool().execute({ report: "kpi" }, ctx);
    const data = result.data as Record<string, unknown>;

    expect(data).toMatchObject({ total: 2, averagePercent: 50, achieved: 1, untouched: 1 });
  });

  /**
   * An empty board is nearly always the wrong period, not a company without
   * targets — so it must not read as "you have no KPIs".
   */
  it("blames the period when the board comes back empty", async () => {
    const { run, invoke } = build();
    invoke.mockResolvedValueOnce({
      method: "get_kpi_table",
      result: { count: 0, period_type: "weekly", period: { label: "01.09.2026 - 07.09.2026" }, items: [] },
    });

    const result = await run.execute({ report: "kpi", period: "weekly" }, ctx);

    expect(result.tables).toBeUndefined();
    expect((result.data as Record<string, unknown>).noData).toBe(true);
    expect((result.data as Record<string, unknown>).note).toContain("period");
  });
});

describe("run_report: timesheet", () => {
  it("turns a month into the span the gateway wants, leap years included", async () => {
    const september = build();
    await september.run.execute({ report: "timesheet", month: "2026-09" }, ctx);
    expect(september.invoke.mock.calls[0][3]).toEqual({
      date_from: "2026-09-01",
      date_to: "2026-09-30",
    });

    const february = build();
    await february.run.execute({ report: "timesheet", month: "2028-02" }, ctx);
    expect(february.invoke.mock.calls[0][3]).toMatchObject({ date_to: "2028-02-29" });

    // Nothing asked for is the gateway's own default — the current week.
    const bare = build();
    await bare.run.execute({ report: "timesheet" }, ctx);
    expect(bare.invoke.mock.calls[0][3]).toEqual({});
  });

  /**
   * Shortfall and overtime are opposite findings, and the sign is the only
   * thing telling them apart once both are in one column.
   */
  it("shows both sides of the deviation, signed", async () => {
    const result = await tool().execute({ report: "timesheet", month: "2026-09" }, ctx);
    const titles = result.tables?.map((t) => t.title);

    expect(titles).toEqual(["Недобор часов", "Переработка"]);
    expect(result.tables?.[0].rows[0]).toMatchObject({
      employee: "Сидоров Сидор",
      deviation: "−12 ч",
    });
    expect(result.tables?.[1].rows[0]).toMatchObject({ deviation: "+2 ч" });
  });

  it("names the people with no activity at all", async () => {
    const result = await tool().execute({ report: "timesheet", month: "2026-09" }, ctx);

    expect(result.kpis?.find((k) => k.label === "Без активности")?.value).toBe("1");
    expect(result.kpis?.find((k) => k.label === "Отработано")?.value).toBe("110 ч");
  });

  /**
   * A period the tracking integration never covered comes back all zeros.
   * Reporting that as "0 hours worked" is a different, and false, statement.
   */
  it("does not read an untracked period as zero hours worked", async () => {
    const { run, invoke } = build();
    invoke.mockResolvedValueOnce({
      method: "get_timesheet_report",
      result: { cards: { from: "2020-01-01", to: "2020-01-07", worked_seconds: 0, plan_seconds: 0 }, charts: {} },
    });

    const result = await run.execute({ report: "timesheet", month: "2020-01" }, ctx);

    expect(result.kpis).toBeUndefined();
    expect((result.data as Record<string, unknown>).noData).toBe(true);
  });
});

describe("run_report: budget", () => {
  it("asks for one year, whether the question named a month or not", async () => {
    const byMonth = build();
    await byMonth.run.execute({ report: "budget", month: "2026-02" }, ctx);
    expect(byMonth.invoke.mock.calls[0][3]).toEqual({ year: 2026 });

    const byYear = build();
    await byYear.run.execute({ report: "budget", month: "2026" }, ctx);
    expect(byYear.invoke.mock.calls[0][3]).toEqual({ year: 2026 });
  });

  /** Totals are derived from the rows, the way the page derives them. */
  it("adds the twelve months up per department", async () => {
    const result = await tool().execute({ report: "budget", month: "2026" }, ctx);
    const rows = result.tables?.[0].rows ?? [];
    const data = result.data as Record<string, unknown>;

    expect(data).toMatchObject({ planTotal: 2700, factTotal: 2200, vacancies: 1 });
    // Sorted by plan, so the biggest department leads.
    expect(rows[0]).toMatchObject({
      department: "Разработка",
      rows: 2,
      vacancies: 1,
      percent: "75%",
    });
    // Grouped the Russian way, so the separator is a non-breaking space.
    expect(String(rows[0].plan).replace(/\s/g, " ")).toBe("2 000");
  });

  it("reads one month out of the twelve when the question named one", async () => {
    const result = await tool().execute({ report: "budget", month: "2026-02" }, ctx);
    const data = result.data as Record<string, unknown>;

    // February: only r1 has an amount there — 1000 planned, 500 actual.
    expect(data).toMatchObject({ month: 2, planTotal: 1000, factTotal: 500 });
    expect(result.tables?.[0].subtitle).toBe("февраль 2026");
  });

  /**
   * A department with rows and no amounts is the gap someone opens the budget
   * to find, so it has to appear rather than be filtered out with the zeros.
   */
  it("keeps a department whose amounts are still empty", async () => {
    const result = await tool().execute({ report: "budget", month: "2026" }, ctx);
    const rows = result.tables?.[0].rows ?? [];

    // d3 has no rows at all and is absent; d2 has a row and must be listed.
    expect(rows.map((r) => r.department)).toEqual(["Разработка", "Продажи"]);
  });

  it("says the year is empty rather than drawing a table of nothing", async () => {
    const { run, invoke } = build();
    invoke.mockResolvedValueOnce({
      method: "budget_get",
      result: { year: 2030, departments: [], rows: [], amounts: [] },
    });

    const result = await run.execute({ report: "budget", month: "2030" }, ctx);

    expect(result.tables).toBeUndefined();
    expect((result.data as Record<string, unknown>).noData).toBe(true);
  });
});
