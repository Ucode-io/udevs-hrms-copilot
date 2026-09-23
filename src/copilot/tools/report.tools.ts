import { randomUUID } from "crypto";
import { Inject, Injectable } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../../config/configuration";
import { UcodeClient } from "../../ucode/ucode.client";
import type {
  CopilotChart,
  CopilotKpi,
  CopilotTable,
} from "../types/copilot.types";
import { TableCatalog } from "../prompt/catalog";
import { CopilotToolError, readRecord, readString, requireString } from "./tool-support";
import type {
  CopilotTool,
  CopilotToolGroup,
  CopilotToolResult,
} from "./tool.types";

/**
 * Wrappers over the HRMS report gateway.
 *
 * These exist because the figures behind "attendance for last month" are not a
 * plain GROUP BY: lateness depends on each person's work schedule, absence days
 * are split into excused / unexcused / paid / unpaid by policy, and the Reports
 * page already reconciles all of it. Recomputing that from raw rows would put a
 * second, subtly different set of numbers in front of the same people —
 * a Copilot that disagrees with the dashboard is worse than no Copilot.
 */
@Injectable()
export class CopilotReportTools implements CopilotToolGroup {
  constructor(
    private readonly ucode: UcodeClient,
    private readonly catalog: TableCatalog,
    @Inject(CONFIG) private readonly config: CopilotConfig,
  ) {}

  getTools(): CopilotTool[] {
    return [this.runReport()];
  }

  private runReport(): CopilotTool {
    const reports = this.catalog.allReports();

    return {
      name: "run_report",
      description:
        `Run a prepared HRMS report and show its figures and charts to the person. Prefer this over aggregate_items whenever a report covers the question, because these numbers are the same ones the HRMS Reports pages display. Available reports:\n${this.catalog.promptReports()}\n\nThe cards and charts are rendered automatically — narrate the headline figures and what stands out, do NOT re-list every number.`,
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            enum: reports.map((r) => r.name),
            description: "Which report to run.",
          },
          month: {
            type: "string",
            description:
              "Month as YYYY-MM. Omit to get the report's own default period. kpi, timesheet and budget also accept a bare YYYY for a whole year.",
          },
          date: {
            type: "string",
            description:
              "One day as YYYY-MM-DD. Required by daily_status and ignored by every other report.",
          },
          bucket: {
            type: "string",
            enum: [...DAILY_BUCKETS],
            description:
              "daily_status only: which of the five lists to put on screen. Omit to show the counts alone — do that when the question is about the shape of the day rather than about who is in one of the lists.",
          },
          period: {
            type: "string",
            enum: [...KPI_PERIODS],
            description:
              "kpi only: which period the board is cut into. Omit for yearly, the view the KPI page opens on.",
          },
          search: {
            type: "string",
            description:
              "Narrow the rows to a name (attendance_table and kpi only).",
          },
          lookup_only: {
            type: "boolean",
            description:
              "Set true when you need the report's numbers to answer something else — a ranking, a comparison — rather than to show the report itself. Nothing is drawn and the rows are handed to you instead. Without it every call puts its cards, charts and table on screen, which is a lot of report for a question like \"who are the top three\".",
          },
        },
        required: ["report"],
      },
      execute: async (input, ctx) => {
        const name = requireString(input.report, "report");
        const entry = this.catalog.report(name);
        if (!entry) {
          throw new CopilotToolError(
            `Unknown report "${name}". Available: ${this.catalog.reportNames().join(", ")}`,
          );
        }

        const params: Record<string, unknown> = {};
        switch (entry.name) {
          // Takes nothing and always returns the whole board.
          case "tasks":
            break;

          case "kpi": {
            const period = readString(input.period) ?? "yearly";
            if (!KPI_PERIODS.includes(period)) {
              throw new CopilotToolError(
                `Unknown period "${period}". Use one of: ${KPI_PERIODS.join(", ")}.`,
              );
            }
            params.period_type = period;
            const anchor = kpiAnchor(readString(input.date), readString(input.month));
            if (anchor) params.as_of_date = anchor;
            const search = readString(input.search);
            if (search) params.search = search;
            break;
          }

          case "timesheet": {
            const span = monthSpan(readString(input.month));
            if (span) {
              params.date_from = span.from;
              params.date_to = span.to;
            }
            break;
          }

          case "budget": {
            // A budget is always one whole year; a month only narrows which of
            // its twelve columns the answer is read from, at render time.
            params.year = budgetYear(readString(input.month));
            break;
          }

          case "daily_status": {
            const date = readString(input.date);
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              throw new CopilotToolError(
                `daily_status needs a date like 2026-09-13, got "${date ?? "nothing"}".`,
              );
            }
            params.date = date;
            // Checked here rather than at render time, so a bad bucket costs a
            // correction instead of a pointless call to the gateway first.
            const bucket = readString(input.bucket);
            if (bucket && !BUCKETS[bucket]) {
              throw new CopilotToolError(
                `Unknown bucket "${bucket}". Use one of: ${DAILY_BUCKETS.join(", ")}.`,
              );
            }
            break;
          }

          default: {
            const month = readString(input.month);
            if (month) {
              if (!/^\d{4}-\d{2}$/.test(month)) {
                throw new CopilotToolError(
                  `month must look like 2026-08, got "${month}".`,
                );
              }
              params.month = month;
            }
            const search = readString(input.search);
            if (search) params.search = search;
            if (entry.name === "attendance_table") {
              params.page = 1;
              params.limit = 50;
            }
          }
        }

        const raw = await this.ucode.invokeFunction(
          ctx.caller,
          this.config.hrms.reportsFunction,
          entry.method,
          params,
        );
        const result = extractResult(raw, entry.method);
        if (!result) {
          throw new CopilotToolError(
            "The report gateway returned nothing usable for that period.",
          );
        }

        let rendered: CopilotToolResult;
        if (entry.name === "daily_status") {
          rendered = renderDailyStatus(
            result,
            readString(input.date) ?? "",
            readString(input.bucket),
          );
        } else if (entry.name === "tasks") {
          // Statuses and priorities are ids on a task; their titles live in a
          // second method. Two calls beat showing someone a board of uuids.
          const directories = extractResult(
            await this.ucode.invokeFunction(
              ctx.caller,
              this.config.hrms.reportsFunction,
              "task_directories_get",
              {},
            ),
            "task_directories_get",
          );
          rendered = renderTasks(result, directories);
        } else if (entry.name === "kpi") {
          rendered = renderKpi(result);
        } else if (entry.name === "timesheet") {
          rendered = renderTimesheet(result);
        } else if (entry.name === "budget") {
          rendered = renderBudget(result, monthIndex(readString(input.month)));
        } else {
          // From `params`, not from the input again: this is the month that was
          // actually asked for, already validated.
          const month = readString(params.month);
          rendered =
            entry.name === "attendance"
              ? renderAttendance(result, month)
              : renderAttendanceTable(result, month);
        }

        return input.lookup_only === true ? asLookup(rendered) : rendered;
      },
    };
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Turns the attendance summary into cards and charts.
 *
 * Every figure is copied straight out of the gateway response, so what the
 * person sees here is identical to the Reports page for the same month. The
 * model is handed the headline numbers only, and told the charts are already on
 * screen.
 */
const renderAttendance = (
  result: Record<string, unknown>,
  requestedMonth: string | undefined,
): CopilotToolResult => {
  const cards = readRecord(result.cards) ?? {};
  const charts = readRecord(result.charts) ?? {};

  // A month nobody has filled in comes back as a full set of zeros. Rendering
  // eight cards reading 0 states nothing and looks like a broken report; the
  // useful answer is that the month is empty and which months are not.
  const empty =
    Number(cards.employees_count ?? 0) === 0 &&
    Number(cards.worked_days ?? 0) === 0 &&
    Number(cards.scheduled_working_days ?? 0) === 0;
  if (empty) {
    const months = readRecord(result.filters)?.available_months ?? null;
    return {
      ok: true,
      summary: `No attendance recorded for ${readString(cards.month) ?? requestedMonth ?? "that month"}`,
      data: {
        month: readString(cards.month) ?? requestedMonth ?? null,
        noData: true,
        availableMonths: months,
        note: "Nothing was recorded for this month — no cards or charts are shown. Say so in one sentence and, if other months are listed here, name them.",
      },
    };
  }
  const month = readString(cards.month) ?? requestedMonth ?? "";
  const subtitle = month ? monthLabel(month) : undefined;

  // The wording is the Reports/Attendance page's own — the Copilot quotes the
  // same figures, so it has to call them by the same names.
  const kpis: CopilotKpi[] = [
    kpi("Сотрудники", cards.employees_count),
    kpi("Рабочие дни (план)", cards.scheduled_working_days),
    kpi("Отработано дней", cards.worked_days),
    kpi("Вовремя, дней", cards.on_time_days),
    kpi("Опозданий", cards.late_arrivals_count),
    kpiDuration("Общее время опозданий", cards.total_late_time),
    kpi("Дней отсутствия", cards.total_absent_days),
    kpi("Прогулы, дней", cards.unexcused_absent_days),
  ].filter((k): k is CopilotKpi => k !== null);

  const rendered: CopilotChart[] = [];

  const absenceCounts = Array.isArray(charts.absence_counts)
    ? (charts.absence_counts as Array<Record<string, unknown>>)
    : [];
  if (absenceCounts.some((a) => Number(a.count ?? 0) > 0)) {
    rendered.push({
      id: randomUUID(),
      // A ring, like every other share-of-a-total the Copilot draws, so the
      // report charts and the ad-hoc ones do not look like two products.
      kind: "donut",
      title: "Отсутствия по типам",
      ...(subtitle ? { subtitle } : {}),
      data: absenceCounts.map((a) => ({
        name: String(a.label ?? a.key ?? "—"),
        value: Number(a.count ?? 0),
      })),
    });
  }

  const topLate = Array.isArray(charts.top_late_time)
    ? (charts.top_late_time as Array<Record<string, unknown>>)
    : [];
  if (topLate.length > 0) {
    rendered.push({
      id: randomUUID(),
      kind: "bar",
      title: "Больше всего опозданий",
      ...(subtitle ? { subtitle } : {}),
      xKey: "label",
      // The gateway reports late time in minutes; charting the raw figure and
      // labelling it as duration keeps the axis honest.
      series: [{ key: "value", label: "Время опоздания", format: "duration" }],
      data: topLate.map((p) => ({
        label: String(p.full_name ?? "—"),
        value: Number(p.total_late_time ?? 0),
      })),
    });
  }

  return {
    ok: true,
    summary: month
      ? `Attendance for ${month}: ${cards.late_arrivals_count ?? 0} late arrival(s), ${cards.total_absent_days ?? 0} absent day(s)`
      : "Attendance summary",
    data: {
      month,
      cards,
      chartsRendered: rendered.map((c) => c.title),
      note: "Every figure here is already on screen as a card, and the charts are drawn. Write at most two sentences about what stands out or looks wrong in them. Do not list the figures back — a list under identical cards is the same information twice — and do not mention the screen, the cards or the charts.",
      availableMonths: readRecord(result.filters)?.available_months ?? null,
    },
    kpis,
    ...(rendered.length > 0 ? { charts: rendered } : {}),
  };
};

/**
 * One day, split the way the day actually splits.
 *
 * The five counts are the answer to "как прошёл вчерашний день"; one of the
 * five lists is the answer to "кто опоздал". Which is why `bucket` is a
 * parameter rather than five tables: a question about the late people should
 * not leave four other lists on the screen.
 */
const renderDailyStatus = (
  result: Record<string, unknown>,
  date: string,
  bucket: string | undefined,
): CopilotToolResult => {
  const counts = readRecord(result.counts) ?? {};
  const subtitle = dayLabel(date);

  const kpis: CopilotKpi[] = [
    kpi("Опоздали", counts.late),
    kpi("Вовремя", counts.on_time),
    kpi("Отсутствуют", counts.absent),
    kpi("В отпуске / на больничном", counts.on_absence_policy),
    kpi("Удалённо", counts.remote),
  ].filter((k): k is CopilotKpi => k !== null);

  // Already validated by the caller, which is the only one there is.
  const spec = bucket ? BUCKETS[bucket] : undefined;
  const rows = spec ? asArray(result[spec.key]) : [];
  const table: CopilotTable | null =
    spec && rows.length > 0
      ? {
          id: randomUUID(),
          title: spec.title,
          subtitle,
          columns: spec.columns,
          rows: rows.map(spec.row),
        }
      : null;

  return {
    ok: true,
    summary: `${date}: ${Number(counts.late ?? 0)} late, ${Number(counts.absent ?? 0)} absent of ${Number(counts.total ?? 0)}`,
    data: {
      date,
      counts,
      ...(spec ? { bucket: spec.key, listed: rows.length } : {}),
      ...(table ? { tableRendered: table.title } : {}),
      note: table
        ? "The counts are on screen as cards and the list as a table. Answer the question in one sentence — usually how many, and the one name worth singling out. Do not read the list back."
        : spec
          ? `Nobody is in the "${spec.title}" list for this day. Say so in one sentence; the counts are on screen.`
          : "Only the counts are on screen. If the person asked who is in one of these groups rather than how many, call this again with the matching bucket.",
    },
    kpis,
    ...(table ? { tables: [table] } : {}),
  };
};

/** Per-employee attendance rows, rendered as a table rather than as prose. */
const renderAttendanceTable = (
  result: Record<string, unknown>,
  requestedMonth: string | undefined,
): CopilotToolResult => {
  const items = Array.isArray(result.items)
    ? (result.items as Array<Record<string, unknown>>)
    : [];
  const pagination = readRecord(result.pagination) ?? {};
  const total = Number(pagination.total_count ?? items.length);

  const table: CopilotTable = {
    id: randomUUID(),
    title: "Посещаемость по сотрудникам",
    ...(requestedMonth ? { subtitle: monthLabel(requestedMonth) } : {}),
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "worked_days", label: "Отработано" },
      { key: "on_time_days", label: "Вовремя" },
      { key: "late_days", label: "Опозданий" },
      { key: "total_late_time", label: "Время опозданий" },
      { key: "total_absent_days", label: "Отсутствий" },
    ],
    rows: items.map((i) => ({
      employee: String(i.employee ?? "—"),
      worked_days: Number(i.worked_days ?? 0),
      on_time_days: Number(i.on_time_days ?? 0),
      late_days: Number(i.late_days ?? 0),
      // Lateness is only meaningful when the person has a schedule to be late
      // against; the gateway zeroes it otherwise, so say so rather than showing
      // a 0 that reads as perfect punctuality.
      total_late_time:
        i.has_work_schedule === false ? "нет графика" : Number(i.total_late_time ?? 0),
      total_absent_days: Number(i.total_absent_days ?? 0),
    })),
    totalCount: total,
  };

  return {
    ok: true,
    summary: `Attendance rows for ${total} employee(s)`,
    data: {
      totalEmployees: total,
      returned: items.length,
      tableRendered: table.title,
      note: "The table is on screen. Write at most two sentences about what stands out; do not list rows and do not mention the table. Rows marked 'нет графика' have no work schedule, so their late time is not computed rather than zero.",
    },
    tables: [table],
  };
};

/**
 * The Tasks board: counts per status group, then the tasks themselves.
 *
 * The counts are the point. "How many are unfinished" is the question people
 * actually ask, and it is not a row count — it is everything whose status is
 * not in the done group, which only the directories can tell us.
 */
const renderTasks = (
  result: Record<string, unknown>,
  directories: Record<string, unknown> | null,
): CopilotToolResult => {
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  const employees = new Map(
    (Array.isArray(result.employees) ? result.employees : [])
      .map((e) => readRecord(e))
      .filter((e): e is Record<string, unknown> => e !== null)
      .map((e) => [String(e.id), readString(e.name) ?? String(e.id)]),
  );

  const statuses = new Map<string, { title: string; group: string }>();
  for (const raw of asArray(directories?.statuses)) {
    const id = readString(raw.id);
    if (!id) continue;
    statuses.set(id, {
      title: readString(raw.title) ?? id,
      // `group` is backfilled; until it is, `isFinal` is the only marker of a
      // done column, which is exactly the distinction the counts turn on.
      group: statusGroup(raw.group, raw.isFinal === true),
    });
  }
  const priorities = new Map(
    asArray(directories?.priorities).map((raw) => [
      readString(raw.id) ?? "",
      readString(raw.title) ?? "",
    ]),
  );

  const counts: Record<string, number> = { todo: 0, in_progress: 0, completed: 0 };
  const rows = tasks
    .map((raw) => readRecord(raw))
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((task) => {
      const status = statuses.get(readString(task.statusId) ?? "");
      counts[status?.group ?? "todo"] = (counts[status?.group ?? "todo"] ?? 0) + 1;
      const assignees = (Array.isArray(task.assigneeIds) ? task.assigneeIds : [])
        .map((id) => employees.get(String(id)) ?? null)
        .filter((name): name is string => name !== null);

      return {
        code: readString(task.code) ?? "—",
        title: readString(task.title) ?? "—",
        status: status?.title ?? "—",
        priority: priorities.get(readString(task.priorityId) ?? "") || "—",
        assignee: assignees.join(", ") || "—",
        deadline: readString(task.deadline)?.slice(0, 10) ?? "—",
      };
    });

  const open = counts.todo + counts.in_progress;
  const table: CopilotTable = {
    id: randomUUID(),
    title: "Задачи",
    subtitle: `${rows.length} всего · ${open} не завершено`,
    columns: [
      { key: "code", label: "Код" },
      { key: "title", label: "Задача" },
      { key: "status", label: "Статус" },
      { key: "assignee", label: "Исполнитель" },
      { key: "deadline", label: "Дедлайн" },
    ],
    rows,
    totalCount: rows.length,
  };

  return {
    ok: true,
    summary: `${rows.length} task(s), ${open} not finished`,
    data: {
      total: rows.length,
      notFinished: open,
      byStatusGroup: {
        todo: counts.todo,
        in_progress: counts.in_progress,
        completed: counts.completed,
      },
      tableRendered: table.title,
      note: "The board is on screen. Answer the question asked — usually a count — in one sentence. 'Not finished' means the to-do and in-progress groups together; do not retype the rows.",
    },
    tables: [table],
  };
};

/**
 * Tracked time against the schedule.
 *
 * The plan here is each person's own schedule minus holidays, which is why this
 * report exists at all: "8 hours times working days" is wrong for half the
 * company, and a Copilot quoting that number would contradict the page while
 * looking equally confident.
 */
const renderTimesheet = (result: Record<string, unknown>): CopilotToolResult => {
  const cards = readRecord(result.cards) ?? {};
  const charts = readRecord(result.charts) ?? {};
  const from = readString(cards.from) ?? "";
  const to = readString(cards.to) ?? "";
  const subtitle = from && to ? `${dayLabel(from)} — ${dayLabel(to)}` : undefined;

  // Nothing tracked and nothing scheduled is not a company that worked zero
  // hours — it is a period outside the tracking integration's reach, and eight
  // zeroed cards would state that as fact.
  if (
    Number(cards.worked_seconds ?? 0) === 0 &&
    Number(cards.plan_seconds ?? 0) === 0
  ) {
    return {
      ok: true,
      summary: `No tracked time for ${from || "that period"} — ${to || ""}`.trim(),
      data: {
        from,
        to,
        noData: true,
        employees: Number(cards.employees_count ?? 0),
        note: "Neither tracked hours nor a schedule exist for this period — no cards are shown. Say so in one sentence; do not report it as zero hours worked, which is a different statement.",
      },
    };
  }

  const kpis: CopilotKpi[] = [
    kpi("Сотрудники", cards.employees_count),
    kpi("Отработано", hoursLabel(cards.worked_seconds)),
    kpi("План", hoursLabel(cards.plan_seconds)),
    kpi("Выполнение", `${Number(cards.completion_rate ?? 0)}%`),
    kpi("Переработка", hoursLabel(cards.overtime_seconds)),
    kpi("Недобор", hoursLabel(cards.shortfall_seconds)),
    // The whole point of opening this report: people with a schedule and not a
    // single entry against it.
    kpi("Без активности", cards.idle_employees),
    Number(cards.manual_pending_count ?? 0) > 0
      ? {
          label: "Ручное время на подтверждении",
          value: hoursLabel(cards.manual_pending_seconds),
          hint: `${cards.manual_pending_count} запис(ей)`,
        }
      : null,
  ].filter((k): k is CopilotKpi => k !== null);

  const rendered: CopilotChart[] = [];
  const byDay = asArray(charts.by_day);
  // A year of daily bars is 366 unreadable columns; the cards already carry the
  // totals, so the chart is simply dropped rather than drawn illegibly.
  if (byDay.length > 0 && byDay.length <= 31) {
    rendered.push({
      id: randomUUID(),
      kind: "bar",
      title: "Часы по дням",
      ...(subtitle ? { subtitle } : {}),
      xKey: "label",
      series: [
        { key: "worked", label: "Отработано" },
        { key: "plan", label: "План" },
      ],
      data: byDay.map((d) => ({
        label: (readString(d.date) ?? "").slice(5).split("-").reverse().join("."),
        worked: Number(d.worked_hours ?? 0),
        plan: Number(d.plan_hours ?? 0),
      })),
    });
  }

  // Two lists rather than one: a shortfall and an overtime are different
  // conversations with the person, and picking one for the reader would answer
  // only half the questions this report gets asked.
  const tables = [
    deviationTable(charts.top_shortfall, "Недобор часов", subtitle),
    deviationTable(charts.top_overtime, "Переработка", subtitle),
  ].filter((t): t is CopilotTable => t !== null);

  return {
    ok: true,
    summary: `${from}–${to}: ${hoursLabel(cards.worked_seconds)} of ${hoursLabel(cards.plan_seconds)} (${Number(cards.completion_rate ?? 0)}%), ${Number(cards.idle_employees ?? 0)} with no activity`,
    data: {
      from,
      to,
      days: Number(cards.days ?? 0),
      cards,
      chartsRendered: rendered.map((c) => c.title),
      tablesRendered: tables.map((t) => t.title),
      note: "Every figure is already on screen. Write at most two sentences on what stands out. \"Без активности\" counts people who have a schedule and no entry at all against it — that is usually a tracking gap, not idleness, so do not accuse anyone. Pending manual time explains part of any shortfall.",
    },
    kpis,
    ...(rendered.length > 0 ? { charts: rendered } : {}),
    ...(tables.length > 0 ? { tables } : {}),
  };
};

/** One side of the deviation from plan, as a table, or nothing when empty. */
const deviationTable = (
  value: unknown,
  title: string,
  subtitle: string | undefined,
): CopilotTable | null => {
  const rows = asArray(value);
  if (rows.length === 0) return null;

  return {
    id: randomUUID(),
    title,
    ...(subtitle ? { subtitle } : {}),
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "worked", label: "Отработано" },
      { key: "plan", label: "План" },
      { key: "deviation", label: "Отклонение" },
    ],
    rows: rows.map((r) => ({
      employee: readString(r.name) ?? "—",
      department: readString(r.department) ?? "—",
      worked: hoursLabel(r.worked_seconds),
      plan: hoursLabel(r.plan_seconds),
      // Signed on purpose: the same column holds both lists, and "−12 ч" and
      // "12 ч" are opposite findings.
      deviation: `${Number(r.deviation_seconds ?? 0) > 0 ? "+" : "−"}${hoursLabel(Math.abs(Number(r.deviation_seconds ?? 0)))}`,
    })),
    totalCount: rows.length,
  };
};

/**
 * The payroll budget for one year, totalled per department.
 *
 * The gateway hands back the parts — departments, rows, twelve months of
 * amounts — and the page adds them up itself, so this does the same arithmetic
 * for the same reason: totals are derived bottom-up from the rows, never stored,
 * so a stored total can never disagree with its parts.
 */
const renderBudget = (
  result: Record<string, unknown>,
  month: number | null,
): CopilotToolResult => {
  const year = Number(result.year ?? 0);
  const label = month ? `${MONTHS[month - 1]} ${year}` : `${year} год`;

  const departments = new Map(
    asArray(result.departments).map((d) => [
      readString(d.id) ?? "",
      readString(d.title) ?? "—",
    ]),
  );
  const rows = asArray(result.rows);
  const departmentOf = new Map(
    rows.map((r) => [readString(r.id) ?? "", readString(r.departmentId) ?? ""]),
  );

  // Amounts are per row per year, twelve months deep. A month narrows the read
  // to one of the twelve; without one the year is the sum of all twelve.
  const totals = new Map<string, { plan: number; fact: number }>();
  for (const entry of asArray(result.amounts)) {
    if (Number(entry.year) !== year) continue;
    const department = departmentOf.get(readString(entry.rowId) ?? "");
    if (department === undefined) continue;
    const months = asArray(entry.months);
    const picked = month ? months.slice(month - 1, month) : months;
    const sum = totals.get(department) ?? { plan: 0, fact: 0 };
    for (const m of picked) {
      sum.plan += Number(m.plan ?? 0);
      sum.fact += Number(m.fact ?? 0);
    }
    totals.set(department, sum);
  }

  const counts = new Map<string, { rows: number; vacancies: number }>();
  for (const row of rows) {
    const department = readString(row.departmentId) ?? "";
    const count = counts.get(department) ?? { rows: 0, vacancies: 0 };
    count.rows += 1;
    if (readString(row.kind) === "vacancy") count.vacancies += 1;
    counts.set(department, count);
  }

  if (counts.size === 0) {
    return {
      ok: true,
      summary: `No budget rows for ${year}`,
      data: {
        year,
        noData: true,
        note: "This year's budget has no rows at all — nothing was drawn. Say so in one sentence; each year is its own dataset, so another year may well be filled in.",
      },
    };
  }

  // Every department that has rows, even one whose amounts are all still empty:
  // an unfilled department is exactly what someone opening the budget looks for.
  const tableRows: DailyRow[] = [...counts.entries()]
    .map(([id, count]) => {
      const sum = totals.get(id) ?? { plan: 0, fact: 0 };
      return {
        department: departments.get(id) ?? "—",
        rows: count.rows,
        vacancies: count.vacancies,
        plan: money(sum.plan),
        fact: money(sum.fact),
        percent: sum.plan > 0 ? `${Math.round((sum.fact / sum.plan) * 100)}%` : "—",
        _plan: sum.plan,
      };
    })
    .sort((a, b) => Number(b._plan) - Number(a._plan))
    .map(({ _plan: _drop, ...row }) => row);

  const plan = [...totals.values()].reduce((sum, t) => sum + t.plan, 0);
  const fact = [...totals.values()].reduce((sum, t) => sum + t.fact, 0);
  const vacancies = rows.filter((r) => readString(r.kind) === "vacancy").length;

  const kpis: CopilotKpi[] = [
    kpi("План", money(plan)),
    kpi("Факт", money(fact)),
    kpi("Исполнение", plan > 0 ? `${Math.round((fact / plan) * 100)}%` : "—"),
    kpi("Строк", rows.length),
    kpi("Вакансий", vacancies),
  ].filter((k): k is CopilotKpi => k !== null);

  const table: CopilotTable = {
    id: randomUUID(),
    title: "Бюджет по отделам",
    subtitle: label,
    columns: [
      { key: "department", label: "Отдел" },
      { key: "rows", label: "Строк" },
      { key: "vacancies", label: "Вакансий" },
      { key: "plan", label: "План" },
      { key: "fact", label: "Факт" },
      { key: "percent", label: "Исполнение" },
    ],
    rows: tableRows,
    totalCount: tableRows.length,
  };

  return {
    ok: true,
    summary: `Budget ${label}: plan ${money(plan)}, actual ${money(fact)}, ${vacancies} vacancy row(s)`,
    data: {
      year,
      ...(month ? { month } : {}),
      planTotal: plan,
      factTotal: fact,
      rows: rows.length,
      vacancies,
      tableRendered: table.title,
      note: "The cards and the per-department table are on screen. Two sentences at most on what stands out. A department whose plan is 0 has rows but no amounts entered yet, which is a gap in the plan rather than a department that costs nothing. Tax and bonus percentages on a row are reference notes and are NOT included in these sums.",
    },
    kpis,
    tables: [table],
  };
};

/** Seconds as the hours people actually say: "7 ч 30 мин", "0 ч". */
const hoursLabel = (value: unknown): string => {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds)) return "0 ч";
  const minutes = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
};

/** A money figure, grouped but unitless — the budget carries no currency. */
const money = (value: number): string =>
  Math.round(value).toLocaleString("ru-RU");

/** "2026-03" → that month's first and last day; a bare "2026" → the year. */
const monthSpan = (month: string | undefined): { from: string; to: string } | null => {
  if (!month) return null;
  if (/^\d{4}$/.test(month)) return { from: `${month}-01-01`, to: `${month}-12-31` };
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) {
    throw new CopilotToolError(
      `month must look like 2026-08 or 2026, got "${month}".`,
    );
  }
  // Day 0 of the next month is the last day of this one, leap years included.
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${last}` };
};

/** The year a budget question is about; today's when it names none. */
const budgetYear = (month: string | undefined): number => {
  if (!month) return new Date().getFullYear();
  const m = /^(\d{4})(?:-\d{2})?$/.exec(month);
  if (!m) {
    throw new CopilotToolError(
      `month must look like 2026-08 or 2026, got "${month}".`,
    );
  }
  return Number(m[1]);
};

/** Which of the twelve columns to read, or null for the whole year. */
const monthIndex = (month: string | undefined): number | null => {
  const m = month ? /^\d{4}-(\d{2})$/.exec(month) : null;
  return m ? Number(m[1]) : null;
};

/**
 * The KPI board: every target with its plan, its actual and the percent.
 *
 * Flattened rather than nested, because a chat table has no disclosure triangle
 * — a child target indented under its parent is the closest the panel gets to
 * the tree the KPI page draws. The percent is the gateway's own, not recomputed
 * here: a parent's actual comes from its children through a per-row aggregation
 * (sum / min / max / avg) that only the gateway knows.
 */
const renderKpi = (result: Record<string, unknown>): CopilotToolResult => {
  const period = readRecord(result.period) ?? {};
  const label = readString(period.label) ?? "";
  const periodType = readString(result.period_type) ?? "";

  const rows: DailyRow[] = [];
  const percents: number[] = [];
  const walk = (nodes: Array<Record<string, unknown>>, depth: number): void => {
    for (const node of nodes) {
      const percent = Number(node.percent_total ?? 0);
      percents.push(percent);
      rows.push({
        position: readString(node.position) ?? "—",
        // Indented with figure spaces (U+2007): a plain leading space collapses
        // away when the cell is laid out, and the child lands level with its
        // parent.
        title: `${"  ".repeat(depth)}${readString(node.title) ?? "—"}`,
        plan: kpiValue(node.plan_total, node),
        actual: kpiValue(node.actual_total, node),
        percent: `${percent}%`,
      });
      walk(asArray(node.children), depth + 1);
    }
  };
  walk(asArray(result.items), 0);

  // An empty board is almost always the wrong period rather than a company with
  // no targets — KPIs live in exactly one period type, so the yearly default
  // shows nothing at all for a company that only keeps monthly ones.
  if (rows.length === 0) {
    return {
      ok: true,
      summary: `No ${periodType || ""} KPI for ${label || "that period"}`.replace(/\s+/g, " "),
      data: {
        period: label,
        periodType,
        noData: true,
        note: "This period has no KPI targets at all — nothing was drawn. Say so in one sentence and offer the other periods (yearly, quarterly, monthly, weekly), because a company usually keeps its targets in just one of them.",
      },
    };
  }

  const achieved = percents.filter((p) => p >= 100).length;
  const untouched = percents.filter((p) => p === 0).length;
  const average = Math.round(
    percents.reduce((sum, p) => sum + p, 0) / percents.length,
  );

  const kpis: CopilotKpi[] = [
    kpi("KPI", rows.length),
    kpi("Среднее выполнение", `${average}%`),
    kpi("Выполнено", achieved),
    kpi("Без движения", untouched),
  ].filter((k): k is CopilotKpi => k !== null);

  const table: CopilotTable = {
    id: randomUUID(),
    title: "KPI",
    ...(label ? { subtitle: label } : {}),
    columns: [
      { key: "position", label: "Должность" },
      { key: "title", label: "KPI" },
      { key: "plan", label: "План" },
      { key: "actual", label: "Факт" },
      { key: "percent", label: "%" },
    ],
    rows,
    totalCount: rows.length,
  };

  return {
    ok: true,
    summary: `${rows.length} KPI for ${label || periodType}: ${average}% on average, ${achieved} at or above plan`,
    data: {
      period: label,
      periodType,
      total: rows.length,
      averagePercent: average,
      achieved,
      untouched,
      tableRendered: table.title,
      note: "The cards and the table are on screen. Write at most three sentences on what stands out — which positions are behind, which targets are at zero with the period already underway — and do not read the rows back. A target at 0% usually means nobody has filled the actual in, not that the work did not happen.",
    },
    kpis,
    tables: [table],
  };
};

/** Period types the KPI board is cut into; the gateway's own list. */
const KPI_PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"];

/**
 * The day the KPI gateway builds the period around.
 *
 * It takes `as_of_date` and works outwards to the enclosing week, month,
 * quarter or year, so an anchor only has to land somewhere inside the period it
 * names — which is why a bare month or year is enough, and why the middle of
 * one is picked rather than its first day.
 */
const kpiAnchor = (
  date: string | undefined,
  month: string | undefined,
): string | null => {
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new CopilotToolError(`date must look like 2026-09-13, got "${date}".`);
    }
    return date;
  }
  if (!month) return null;
  if (/^\d{4}-\d{2}$/.test(month)) return `${month}-15`;
  if (/^\d{4}$/.test(month)) return `${month}-06-15`;
  throw new CopilotToolError(
    `month must look like 2026-08 or 2026, got "${month}".`,
  );
};

/** A KPI figure carries its own unit — "50 783 $", "14 %", "$1 200". */
const kpiValue = (value: unknown, node: Record<string, unknown>): string => {
  const num = Number(value ?? 0);
  const text = Number.isFinite(num) ? num.toLocaleString("ru-RU") : "0";
  const symbol = readString(node.value_symbol) ?? "";
  if (!symbol) return text;
  return node.value_symbol_position === "prefix"
    ? `${symbol}${text}`
    : `${text} ${symbol}`;
};

// ─── daily_status buckets ───────────────────────────────────────────────────

type DailyRow = Record<string, string | number | null>;

interface BucketSpec {
  /** Key on the gateway response holding this list. */
  key: string;
  title: string;
  columns: Array<{ key: string; label: string }>;
  row: (r: Record<string, unknown>) => DailyRow;
}

const person = (r: Record<string, unknown>): DailyRow => ({
  employee: readString(r.full_name) ?? "—",
  department: readString(r.department_title) ?? "—",
});

const BUCKETS: Record<string, BucketSpec> = {
  late: {
    key: "late",
    title: "Опоздавшие",
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "check_in", label: "Пришёл" },
      { key: "delay", label: "Опоздание" },
    ],
    row: (r) => ({
      ...person(r),
      check_in: readString(r.check_in_time) ?? "—",
      delay: readString(r.delay_time) ?? "—",
    }),
  },
  on_time: {
    key: "on_time",
    title: "Пришли вовремя",
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "check_in", label: "Пришёл" },
      { key: "check_out", label: "Ушёл" },
    ],
    row: (r) => ({
      ...person(r),
      check_in: readString(r.check_in_time) ?? "—",
      check_out: readString(r.check_out_time) ?? "—",
    }),
  },
  absent: {
    key: "absent",
    title: "Отсутствуют",
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "reason", label: "Причина" },
    ],
    row: (r) => ({
      ...person(r),
      // The gateway's two reasons say different things: one is a record saying
      // the person was away, the other is the absence of any record at all.
      reason:
        readString(r.reason) === "marked_absent"
          ? "Отмечен отсутствующим"
          : "Нет отметки прихода",
    }),
  },
  on_absence_policy: {
    key: "on_absence_policy",
    title: "В отпуске / на больничном",
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "policy", label: "Тип" },
      { key: "until", label: "По" },
    ],
    row: (r) => ({
      ...person(r),
      policy: readString(r.policy_title) ?? "—",
      until: readString(r.absence_date_to)?.slice(0, 10) ?? "—",
    }),
  },
  remote: {
    key: "remote",
    title: "Работают удалённо",
    columns: [
      { key: "employee", label: "Сотрудник" },
      { key: "department", label: "Отдел" },
      { key: "check_in", label: "Отметился" },
    ],
    row: (r) => ({
      ...person(r),
      check_in: readString(r.check_in_time) ?? (r.checked_in ? "да" : "—"),
    }),
  },
};

const DAILY_BUCKETS = Object.keys(BUCKETS);

const asArray = (value: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(value) ? value : [])
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);

/** Mirrors normalizeStatusGroup in the SPA (modules/Tasks/statusGroups.ts). */
const statusGroup = (value: unknown, isFinal: boolean): string => {
  const fallback = isFinal ? "completed" : "todo";
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return fallback;
  if (key === "in_process" || key === "inprocess" || key === "inprogress") {
    return "in_progress";
  }
  if (key === "done" || key === "complete") return "completed";
  return ["todo", "in_progress", "completed"].includes(key) ? key : fallback;
};

/**
 * The same report, handed to the model instead of to the person.
 *
 * Drops the cards, charts and table, and quotes the rows in their place —
 * without that swap a lookup would be strictly worse than useless: the renderer
 * keeps the rows in the artifact only, so the model would lose the numbers it
 * asked for *and* the person would still see nothing.
 */
const asLookup = (result: CopilotToolResult): CopilotToolResult => {
  const rows = result.tables?.[0]?.rows ?? [];
  const quoted = rows.slice(0, LOOKUP_ROW_QUOTE);
  const { tables: _tables, charts: _charts, kpis: _kpis, ...rest } = result;

  return {
    ...rest,
    data: {
      ...(typeof result.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : {}),
      tableRendered: undefined,
      rows: quoted,
      ...(rows.length > quoted.length
        ? { rowsNote: `Only the first ${quoted.length} of ${rows.length} rows are quoted.` }
        : {}),
      note: "Nothing was drawn — these figures are for you, not for the person. Answer from them, and run the report again without lookup_only if they should see it.",
    },
  };
};

/** Rows quoted to the model for a lookup, where the quote is all it gets. */
const LOOKUP_ROW_QUOTE = 60;

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** "2026-08" reads as a machine key; "август 2026" reads as a month. */
const monthLabel = (month: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = MONTHS[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : month;
};

/** "2026-09-13" reads as a machine key; "13 сентября 2026" reads as a day. */
const dayLabel = (date: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const name = m ? MONTHS_GENITIVE[Number(m[2]) - 1] : undefined;
  return m && name ? `${Number(m[3])} ${name} ${m[1]}` : date;
};

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const kpi = (label: string, value: unknown): CopilotKpi | null =>
  value === undefined || value === null
    ? null
    : { label, value: String(value) };

/** Late time arrives in minutes; render it as hours and minutes. */
const kpiDuration = (label: string, value: unknown): CopilotKpi | null => {
  if (value === undefined || value === null) return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return { label, value: h > 0 ? `${h} ч ${m} мин` : `${m} мин`, hint: "за месяц" };
};

/**
 * Digs `result` out of a cloud-function response.
 *
 * The payload sits at `{data:{data:{method, result}}}`, but with `status` and
 * `description` as siblings at each level, so peeling "the single data key"
 * stops at the top and finds nothing. Search for the `{method, result}` node
 * instead — the same breadth-first walk the HRMS SPA does in
 * `normalizeGatewayResponse`, and for the same reason: the nesting differs
 * between deployments.
 *
 * `server_error` is checked on the way down because the gateway reports a
 * failed report *inside* a 200/201 body. Without this a broken report reads as
 * an empty one, and the assistant reports "no data for that month" in good
 * faith.
 */
const extractResult = (
  raw: unknown,
  method: string,
): Record<string, unknown> | null => {
  const queue: unknown[] = [raw];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const node = readRecord(queue.shift());
    if (!node || seen.has(node)) continue;
    seen.add(node);

    const serverError = readString(node.server_error);
    if (serverError) throw new CopilotToolError(serverError);

    const result = readRecord(node.result);
    if (result && node.method === method) return result;

    for (const key of ["data", "result", "response"]) {
      if (node[key] !== undefined) queue.push(node[key]);
    }
  }
  return null;
};
