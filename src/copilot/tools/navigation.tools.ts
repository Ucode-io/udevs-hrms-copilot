import { randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import type { CopilotLink, CopilotLinkKind } from "../types/copilot.types";
import { CopilotToolError, readString, requireString } from "./tool-support";
import type { CopilotTool, CopilotToolGroup } from "./tool.types";

/**
 * Pages the Copilot can hand someone a button to.
 *
 * Labels are the HRMS UI's own words for these pages, so the button names the
 * destination the way the sidebar and the Reports index do.
 *
 * Two jobs. Some things genuinely belong on a page — creating an employee is a
 * form with required relations and dynamic fields, and walking that through a
 * chat box would be ten questions where a pre-filled form is one screen. And
 * some answers are better finished by looking: a report the person will want to
 * filter themselves.
 *
 * Kept as an explicit map rather than free-form paths so the model cannot
 * fabricate a route. `:id` is substituted from `rowId`.
 */
interface PageDef {
  path: string;
  label: string;
  kind: CopilotLinkKind;
  needsRowId?: boolean;
  description?: string;
}

const PAGES: Record<string, PageDef> = {
  employees: {
    path: "/employees",
    label: "Открыть список сотрудников",
    kind: "employees",
  },
  employee: {
    path: "/employees/:id",
    label: "Открыть карточку сотрудника",
    kind: "employee",
    needsRowId: true,
  },
  employee_edit: {
    path: "/employees/:id/edit",
    label: "Редактировать сотрудника",
    kind: "employee",
    needsRowId: true,
  },
  employee_new: {
    path: "/employees/new",
    label: "Открыть форму нового сотрудника",
    kind: "employee",
    description:
      "The form covers required relations and any custom fields this company defines.",
  },
  organization_structure: {
    path: "/organization/structure",
    label: "Открыть орг структуру",
    kind: "employees",
  },
  dashboard: { path: "/dashboard", label: "Открыть дашборд", kind: "reports" },
  tasks: { path: "/tasks", label: "Открыть задачи", kind: "reports" },
  kpi: { path: "/kpi", label: "Открыть KPI", kind: "reports" },
  chats: { path: "/chats", label: "Открыть чаты", kind: "employees" },
  surveys: { path: "/surveys", label: "Открыть опросы", kind: "knowledge" },
  budgeting: { path: "/budgeting", label: "Открыть бюджет", kind: "reports" },
  property: { path: "/property", label: "Открыть имущество", kind: "settings" },
  documents: { path: "/documents", label: "Открыть документы", kind: "knowledge" },
  reports: { path: "/reports", label: "Открыть отчёты", kind: "reports" },
  report_attendance: {
    path: "/reports/attendance",
    label: "Открыть отчёт «Посещаемость»",
    kind: "reports",
  },
  report_lateness: {
    path: "/reports/lateness",
    label: "Открыть отчёт «Опоздания»",
    kind: "reports",
  },
  report_staff_count: {
    path: "/reports/staff-count",
    label: "Открыть отчёт «Численность персонала»",
    kind: "reports",
  },
  report_staff_turnover: {
    path: "/reports/staff-turnover",
    label: "Открыть отчёт «Текучесть сотрудников»",
    kind: "reports",
  },
  report_age_distribution: {
    path: "/reports/age-distribution",
    label: "Открыть отчёт «Возрастное распределение»",
    kind: "reports",
  },
  report_absence_balance: {
    path: "/reports/absence-balance",
    label: "Открыть отчёт «Баланс отсутствий»",
    kind: "reports",
  },
  time_attendance: {
    path: "/time/attendance",
    label: "Открыть журнал посещаемости",
    kind: "time",
  },
  timesheet: { path: "/timesheet", label: "Открыть табель времени", kind: "time" },
  work_schedules: { path: "/shifts", label: "Открыть график работы", kind: "time" },
  trainings: { path: "/trainings", label: "Открыть тренинги", kind: "reports" },
  vacancies: {
    path: "/recruiting/vacancies",
    label: "Открыть вакансии",
    kind: "reports",
  },
  candidates: {
    path: "/recruiting/candidates",
    label: "Открыть кандидатов",
    kind: "reports",
  },
  knowledge_base: {
    path: "/knowledge-base",
    label: "Открыть базу знаний",
    kind: "knowledge",
  },
  knowledge_article: {
    path: "/knowledge-base/articles/:id",
    label: "Открыть статью",
    kind: "knowledge",
    needsRowId: true,
    description: "The rowId is an article guid from kb_list_articles.",
  },
  settings: { path: "/settings", label: "Открыть настройки", kind: "settings" },
};

/** The page list injected into the system prompt, so the two cannot drift. */
export const COPILOT_PAGE_MAP: string = Object.entries(PAGES)
  .map(
    ([key, p]) => `- ${key}${p.needsRowId ? " (needs rowId)" : ""}: ${p.label}`,
  )
  .join("\n");

@Injectable()
export class CopilotNavigationTools implements CopilotToolGroup {
  getTools(): CopilotTool[] {
    return [
      {
        name: "open_page",
        description:
          `Give the person a button that opens an HRMS page. Use it when they ask where something is, when they want to look at or edit something on screen, or when a task is genuinely a form rather than a conversation — creating an employee, for instance. Surface the button; never paste a raw path into your reply. Pages:\n${COPILOT_PAGE_MAP}`,
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "string",
              enum: Object.keys(PAGES),
              description: "Which page to open.",
            },
            rowId: {
              type: "string",
              description: "Row guid, for the pages that need one.",
            },
            label: {
              type: "string",
              description:
                "Button text in the person's language. Omit for the default.",
            },
          },
          required: ["page"],
        },
        execute: async (input) => {
          const key = requireString(input.page, "page");
          const page = PAGES[key];
          if (!page) {
            throw new CopilotToolError(
              `Unknown page "${key}". Available: ${Object.keys(PAGES).join(", ")}`,
            );
          }

          let href = page.path;
          if (page.needsRowId) {
            const rowId = readString(input.rowId);
            if (!rowId) {
              throw new CopilotToolError(`Page "${key}" needs a rowId.`);
            }
            href = href.replace(":id", encodeURIComponent(rowId));
          }

          const link: CopilotLink = {
            id: randomUUID(),
            label: readString(input.label) ?? page.label,
            href,
            kind: page.kind,
            ...(page.description ? { description: page.description } : {}),
          };

          return {
            ok: true,
            summary: `Offered a link to ${href}`,
            data: {
              page: key,
              linkRendered: link.label,
              note: "The button is on screen with its own label. Do not describe it, do not tell them to click it, and never write the path out — just finish your answer.",
            },
            links: [link],
          };
        },
      },
    ];
  }
}
