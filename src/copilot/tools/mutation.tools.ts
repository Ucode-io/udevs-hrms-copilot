import { Inject, Injectable } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../../config/configuration";
import { UcodeClient } from "../../ucode/ucode.client";
import { formatCell, rowLabel } from "../../ucode/labels";
import type { FieldDef, UcodeItem } from "../../ucode/ucode.types";
import type { CopilotFieldChange } from "../types/copilot.types";
import { TableCatalog } from "../prompt/catalog";
import {
  CopilotToolError,
  displayValue,
  readString,
  readArray,
  readRecord,
  requireRecord,
  requireString,
} from "./tool-support";
import type {
  CopilotTool,
  CopilotToolContext,
  CopilotToolGroup,
} from "./tool.types";

/**
 * Writes.
 *
 * All three are `destructive`, which in this codebase means "never runs without
 * a person approving it", not "deletes something". Creating an employee wires up
 * a login and relations, and editing one changes a personnel record — both are
 * things someone should see spelled out before they happen, and neither is
 * cheap to undo through a chat box.
 */
@Injectable()
export class CopilotMutationTools implements CopilotToolGroup {
  constructor(
    private readonly ucode: UcodeClient,
    private readonly catalog: TableCatalog,
    @Inject(CONFIG) private readonly config: CopilotConfig,
  ) {}

  getTools(): CopilotTool[] {
    return [
      this.createItem(),
      this.createItems(),
      this.updateItem(),
      this.deleteItem(),
    ];
  }

  // ─── create_items ─────────────────────────────────────────────────────────

  /**
   * The import path: a list of people that arrived as a file becomes one batch
   * of rows behind one confirmation card.
   *
   * It exists because create_item cannot do this. The loop allows eight tool
   * calls per question and holds one Pending Action at a time, so a
   * twenty-person spreadsheet through create_item is twenty cards across three
   * questions — and nobody reads the twentieth.
   */
  private createItems(): CopilotTool {
    return {
      name: "create_items",
      description:
        "Create SEVERAL rows in one HRMS table at once — this is how a list from an attached file gets imported. Read the file, call describe_table, map each entry onto real columns, resolve every relation to a guid with list_items (a relation column takes an id, never a name), then send all the rows in one call. One confirmation card covers the whole batch, so do NOT call create_item in a loop and do not ask the person to confirm first. Leave a column out of a row when the file does not say — do not invent values. Rows whose column set differs are fine. For employees (user_base) every row needs an email: it becomes the person's login, and the batch is refused without it — so if the file has no email column, ask for the addresses rather than calling this and rather than making them up.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", enum: this.catalog.slugs() },
          rows: {
            type: "array",
            description: `Up to ${MAX_BULK_ROWS} rows. Each is a column-to-value object, exactly as create_item takes.`,
            items: { type: "object" },
          },
        },
        required: ["table", "rows"],
      },
      summarize: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const rows = this.assertRows(input.rows);
        const fields = await this.fieldMap(ctx, table);
        const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        // Throws for a batch that cannot be written at all, so the person is
        // never shown a card whose only outcome is an error on approval.
        this.applyWriteDefaults(table, rows);

        return {
          title: `Добавить ${rows.length} ${plural(rows.length, "запись", "записи", "записей")} — ${this.label(table)}?`,
          description: `Заполняются: ${columns.map((c) => fields.get(c)?.label ?? c).join(", ")}.`,
          // One line per row, so a batch is still something a person can read
          // before approving it. ponytail: relation columns are left out of the
          // line because they hold guids; the column list above names them.
          changes: [
            ...rows.slice(0, MAX_PREVIEW_ROWS).map((row, i) => ({
              field: `row-${i}`,
              label: String(i + 1),
              before: null,
              after: previewRow(row, fields),
            })),
            ...(rows.length > MAX_PREVIEW_ROWS
              ? [
                  {
                    field: "row-rest",
                    label: "…",
                    before: null,
                    after: `и ещё ${rows.length - MAX_PREVIEW_ROWS}`,
                  },
                ]
              : []),
          ],
        };
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const rows = this.assertRows(input.rows);
        await this.assertColumns(ctx, table, [
          ...new Set(rows.flatMap((r) => Object.keys(r))),
        ]);

        const { rows: prepared, applied } = this.applyWriteDefaults(table, rows);

        // Sequential on purpose: ucode has no bulk insert, and firing a hundred
        // creates at once at a backend that answers one at a time turns a slow
        // import into a failed one.
        const failures: Array<{ row: number; error: string }> = [];
        // Someone who exists but holds no job yet: worth naming separately,
        // because the fix is editing a person rather than importing them again.
        const incomplete: Array<{ row: number; error: string }> = [];
        let created = 0;
        for (const [i, values] of prepared.entries()) {
          try {
            const row = await this.ucode.create(ctx.caller, table, values);
            created++;
            if (table === "user_base" && typeof row.guid === "string") {
              try {
                await this.createWorkRow(ctx, row.guid, values);
              } catch (e) {
                incomplete.push({
                  row: i + 1,
                  error: `created, but their work record (department, position, salary) was not: ${message(e)}`,
                });
              }
            }
          } catch (e) {
            failures.push({ row: i + 1, error: message(e) });
          }
        }

        return {
          ok: created > 0,
          summary:
            failures.length === 0
              ? `Добавлено ${created} — ${this.label(table)}`
              : `Добавлено ${created} из ${prepared.length}, с ошибкой ${failures.length}`,
          data: {
            table,
            created,
            failed: failures.length,
            ...(applied.length > 0 ? { defaultsApplied: applied } : {}),
            // Enough to name what went wrong without replaying a hundred errors.
            ...(failures.length > 0
              ? { failures: failures.slice(0, 10) }
              : {}),
            ...(incomplete.length > 0
              ? { incomplete: incomplete.slice(0, 10) }
              : {}),
          },
          ...(created === 0
            ? { error: failures[0]?.error ?? "Nothing was created." }
            : {}),
        };
      },
    };
  }

  // ─── create_item ──────────────────────────────────────────────────────────

  private createItem(): CopilotTool {
    return {
      name: "create_item",
      description:
        "Create one row in an HRMS table. Call describe_table first and resolve every relation to a real guid with list_items — a relation column takes an id, never a name. Do not ask the person to confirm: calling this shows them a confirmation card automatically, and nothing is written until they approve it.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", enum: this.catalog.slugs() },
          values: {
            type: "object",
            description:
              "Column values for the new row. Relation columns take the related row's guid.",
          },
        },
        required: ["table", "values"],
      },
      summarize: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const values = requireRecord(input.values, "values");
        const fields = await this.fieldMap(ctx, table);
        return {
          title: `Создать ${noun(table).acc}?`,
          description: `Добавит новую запись: ${noun(table).nom}.`,
          changes: Object.entries(values).map(([field, after]) => ({
            field,
            label: fields.get(field)?.label ?? field,
            before: null,
            after: cell(displayValue(after), fields.get(field)?.type),
          })),
        };
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const { rows, applied } = this.applyWriteDefaults(table, [
          requireRecord(input.values, "values"),
        ]);
        await this.assertColumns(ctx, table, Object.keys(rows[0]));

        const created = await this.ucode.create(ctx.caller, table, rows[0]);
        const guid = typeof created.guid === "string" ? created.guid : null;
        // One employee and a hundred are the same two writes.
        if (table === "user_base" && guid) {
          await this.createWorkRow(ctx, guid, rows[0]);
        }
        return {
          ok: true,
          summary: `Создан${noun(table).ending} ${noun(table).nom}`,
          data: {
            table,
            guid,
            created: guid !== null,
            ...(applied.length > 0 ? { defaultsApplied: applied } : {}),
          },
        };
      },
    };
  }

  // ─── update_item ──────────────────────────────────────────────────────────

  private updateItem(): CopilotTool {
    return {
      name: "update_item",
      description:
        "Change columns on one existing HRMS row, identified by its guid. Only send the columns that change. Call describe_table first, and resolve relations to guids with list_items. Do not ask the person to confirm: calling this shows them a card with the exact before/after, and nothing is written until they approve it.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", enum: this.catalog.slugs() },
          guid: { type: "string", description: "Row id, from list_items." },
          values: {
            type: "object",
            description: "Only the columns being changed.",
          },
        },
        required: ["table", "guid", "values"],
      },
      summarize: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const guid = requireString(input.guid, "guid");
        const values = requireRecord(input.values, "values");
        const fields = await this.fieldMap(ctx, table);

        // Reading the row first is what makes the card worth showing: without a
        // "before" the person is approving a change they cannot evaluate.
        const current = await this.ucode.getOne(ctx.caller, table, guid);
        const changes: CopilotFieldChange[] = Object.entries(values).map(
          ([field, after]) => ({
            field,
            label: fields.get(field)?.label ?? field,
            before: current ? cell(displayValue(current[field]), fields.get(field)?.type) : null,
            after: cell(displayValue(after), fields.get(field)?.type),
          }),
        );

        return {
          title: `Изменить: ${describeRow(current, table)}?`,
          description: `Изменит ${changes.length} ${plural(changes.length, "поле", "поля", "полей")} в этой записи.`,
          changes,
        };
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const guid = requireString(input.guid, "guid");
        const values = requireRecord(input.values, "values");
        await this.assertColumns(ctx, table, Object.keys(values));

        // The row is re-read under the caller's own token, so a guid the model
        // invented or borrowed from another Company fails here rather than
        // silently updating something the person cannot even see.
        const current = await this.ucode.getOne(ctx.caller, table, guid);
        if (!current) {
          throw new CopilotToolError(
            `No row ${guid} in ${table} that you can access.`,
          );
        }

        await this.ucode.update(ctx.caller, table, guid, values);
        return {
          ok: true,
          summary: `Изменено: ${describeRow(current, table)}`,
          data: { table, guid, changed: Object.keys(values) },
        };
      },
    };
  }

  // ─── delete_item ──────────────────────────────────────────────────────────

  private deleteItem(): CopilotTool {
    return {
      name: "delete_item",
      description:
        "Delete one HRMS row by its guid. For an employee who has left the company, updating their status to dismissed is almost always what is actually wanted — deleting removes the record and its history. Do not ask the person to confirm: calling this shows them a confirmation card automatically.",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", enum: this.catalog.slugs() },
          guid: { type: "string", description: "Row id, from list_items." },
        },
        required: ["table", "guid"],
      },
      summarize: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const guid = requireString(input.guid, "guid");
        const current = await this.ucode.getOne(ctx.caller, table, guid);
        return {
          title: `Удалить: ${describeRow(current, table)}?`,
          description:
            table === "user_base"
              ? "Удалит карточку сотрудника вместе с её историей. Если человек просто уволился, статус «Уволен» сохранит запись."
              : `Удалит эту запись: ${noun(table).nom}.`,
        };
      },
      execute: async (input, ctx) => {
        const table = this.assertTable(input.table);
        const guid = requireString(input.guid, "guid");
        const current = await this.ucode.getOne(ctx.caller, table, guid);
        if (!current) {
          throw new CopilotToolError(
            `No row ${guid} in ${table} that you can access.`,
          );
        }
        await this.ucode.remove(ctx.caller, table, guid);
        // The person is two rows, so deleting one of them is a half-delete that
        // leaves a work record pointing at nobody. Done after, not before: if
        // this fails the person is still gone, which is what was asked for,
        // where the other order would destroy their job history and keep them.
        const orphans =
          table === "user_base" ? await this.deleteWorkRows(ctx, guid) : null;

        return {
          ok: true,
          summary: `Удалено: ${describeRow(current, table)}`,
          data: {
            table,
            guid,
            deleted: true,
            ...(orphans ? { workRecords: orphans } : {}),
          },
        };
      },
    };
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  /** The `rows` argument of a batch write, checked before anything is shown. */
  private assertRows(value: unknown): Array<Record<string, unknown>> {
    const rows = readArray(value);
    if (!rows || rows.length === 0) {
      throw new CopilotToolError("Field \"rows\" must be a non-empty array of objects.");
    }
    if (rows.length > MAX_BULK_ROWS) {
      throw new CopilotToolError(
        `${rows.length} rows is more than the ${MAX_BULK_ROWS} one batch takes. Send the first ${MAX_BULK_ROWS} and the rest after they are approved.`,
      );
    }
    return rows.map((row, i) => {
      const record = readRecord(row);
      if (!record || Object.keys(record).length === 0) {
        throw new CopilotToolError(`Row ${i + 1} is not a column-to-value object.`);
      }
      return record;
    });
  }

  /**
   * Fills the columns a new employee row is invisible — or rejected — without.
   *
   * Both the Employees page and the Copilot's own reads filter `user_base` by
   * `role_id` and `status`, so a row created without them matches no list anyone
   * looks at. Write-side twin of `applyDefaults` in data.tools.ts.
   *
   * `login` and `client_type_id` are a harder requirement than that: `user_base`
   * is an auth table, and production answers a create without credentials with
   * 500 "this table is auth table. Auth information not fully given". Which
   * fields satisfy it exactly is not established; what is known is the shape the
   * SPA's own employee form sends, so these mirror it — login is the person's
   * email, and the client type is the constant that form stamps on everyone.
   */
  private withCreateDefaults(
    table: string,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    if (table !== "user_base") return values;
    const roleId = this.config.hrms.employeeRoleId;
    const login = readString(values.login) ?? readString(values.email);
    return {
      ...(roleId ? { role_id: roleId } : {}),
      status: "active",
      ...(login ? { login } : {}),
      client_type_id: this.config.hrms.clientTypeId,
      ...values,
    };
  }

  /** The same defaults over a batch, with a line for the model when they fired. */
  private applyWriteDefaults(
    table: string,
    rows: Array<Record<string, unknown>>,
  ): { rows: Array<Record<string, unknown>>; applied: string[] } {
    const out = rows.map((row) => this.withCreateDefaults(table, row));

    // Caught here rather than row by row against the backend: half an import
    // written and half refused is the worst outcome, and the person can add the
    // missing addresses to their file and try again.
    if (table === "user_base") {
      const nameless = out
        .map((row, i) => (readString(row.login) ? null : i + 1))
        .filter((i): i is number => i !== null);
      if (nameless.length > 0) {
        throw new CopilotToolError(
          `An employee signs in with their email, so a row without one cannot be created. Rows without an email: ${nameless.join(", ")}. Ask the person for those addresses — do not invent them.`,
        );
      }
    }
    const filled = out.filter(
      (row, i) => Object.keys(row).length > Object.keys(rows[i]).length,
    ).length;

    return {
      rows: out,
      applied:
        filled > 0
          ? [
              `${filled} row(s) arrived without role_id or status and were created as active employees. Say so — any other user type or status has to be asked for explicitly.`,
            ]
          : [],
    };
  }

  /**
   * The other half of creating an employee.
   *
   * A person is two rows in this HRMS: `user_base`, which is who they are and
   * how they sign in, and `employee_works`, which is the job they hold —
   * department, position, salary, from which date. The SPA's employee form
   * writes both (Employees/Form/index.tsx), and the Work section of a person's
   * card reads the second one, so a create that skips it leaves every imported
   * employee looking unassigned.
   *
   * `employee_works` is deliberately not in the Allowlist: it is not a table the
   * model may name, it is part of what "create an employee" means here.
   */
  private async createWorkRow(
    ctx: CopilotToolContext,
    userGuid: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const work: Record<string, unknown> = { user_base_id: userGuid };
    for (const column of WORK_COLUMNS) {
      if (values[column] !== undefined) work[column] = values[column];
    }
    // The form defaults this to the hire date, falling back to today.
    work.date_from = values.date_hire ?? new Date().toISOString().slice(0, 10);
    await this.ucode.create(ctx.caller, EMPLOYEE_WORK_TABLE, work);
  }

  /**
   * Removes the work records of a person who no longer exists. Returns what
   * happened, for the model to pass on — a leftover row is worth a sentence,
   * because nothing in the Copilot can reach it afterwards.
   */
  private async deleteWorkRows(
    ctx: CopilotToolContext,
    userGuid: string,
  ): Promise<string> {
    try {
      const found = await this.ucode.list(ctx.caller, EMPLOYEE_WORK_TABLE, {
        filters: [{ field: "user_base_id", op: "eq", value: userGuid }],
        limit: 50,
      });
      let removed = 0;
      for (const row of found.response) {
        if (typeof row.guid === "string") {
          await this.ucode.remove(ctx.caller, EMPLOYEE_WORK_TABLE, row.guid);
          removed++;
        }
      }
      return `${removed} work record(s) removed with them.`;
    } catch (e) {
      return `their work record could not be removed and is now orphaned: ${message(e)}`;
    }
  }

  /**
   * The one gate every mutation passes through.
   *
   * Read-only tables are refused here rather than warned about in a Hint,
   * because the damage is silent: a shift written outside its series, a survey
   * whose body became an object, a laptop reassigned with no movement history.
   * None of those fail loudly — the row lands and the page shows it wrong.
   */
  private assertTable(value: unknown): string {
    const table = requireString(value, "table");
    if (!this.catalog.allows(table)) {
      throw new CopilotToolError(
        `Table "${table}" is not available to the Copilot. Available tables: ${this.catalog.slugs().join(", ")}`,
      );
    }
    const entry = this.catalog.table(table);
    if (entry?.readOnly) {
      throw new CopilotToolError(
        `"${entry.label}" can be read but not changed from the Copilot: ${entry.readOnlyReason}`,
      );
    }
    return table;
  }

  private label(table: string): string {
    return this.catalog.table(table)?.label ?? table;
  }

  private async fieldMap(
    ctx: CopilotToolContext,
    table: string,
  ): Promise<Map<string, FieldDef>> {
    const fields = await this.ucode.fields(ctx.caller, table);
    return new Map(fields.map((f) => [f.slug, f]));
  }

  /**
   * Rejects a write naming a column the table does not have. ucode would accept
   * the request and drop the unknown key, so without this a confident "done"
   * could follow a change that never happened.
   */
  private async assertColumns(
    ctx: CopilotToolContext,
    table: string,
    names: string[],
  ): Promise<void> {
    if (names.length === 0) {
      throw new CopilotToolError("No values given, so there is nothing to write.");
    }
    const fields = await this.fieldMap(ctx, table);
    const unknown = names.filter((n) => !fields.has(n));
    if (unknown.length > 0) {
      throw new CopilotToolError(
        `Unknown column(s) on ${table}: ${unknown.join(", ")}. Available: ${[...fields.keys()].sort().join(", ")}`,
      );
    }
    for (const guard of PROTECTED_COLUMNS) {
      if (names.includes(guard)) {
        throw new CopilotToolError(
          `Column "${guard}" cannot be set through the Copilot.`,
        );
      }
    }
  }
}

/**
 * Columns a chat message must never move. `companies_id` is the tenant boundary
 * and is injected from the Caller; `guid` identifies the row rather than
 * describing it; the rest are audit fields the database owns.
 */
/** Rows one approved batch may carry. Beyond this the import is split. */
const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const EMPLOYEE_WORK_TABLE = "employee_works";

/**
 * What the work row carries. The relations are written to both rows — the
 * Employees list reads them off `user_base`, the person's Work section off
 * `employee_works` — which is what the SPA's form does too.
 */
const WORK_COLUMNS = [
  "employment_types_id",
  "departments_id",
  "locations_id",
  "positions_id",
  "experience_levels_id",
  "employee_work_reason_id",
  "salary",
];

const MAX_BULK_ROWS = 200;
/** Rows spelled out on the confirmation card before it collapses to a count. */
const MAX_PREVIEW_ROWS = 15;

const PROTECTED_COLUMNS = [
  "companies_id",
  "guid",
  "created_at",
  "updated_at",
  "deleted_at",
];

/**
 * One row of a batch as a single line on the confirmation card. Relation
 * columns are left out — they hold guids, and fifteen lines of uuid is not
 * something anyone can check a batch against.
 */
const previewRow = (
  row: Record<string, unknown>,
  fields: Map<string, FieldDef>,
): string => {
  const parts = Object.entries(row)
    .filter(([key]) => !key.endsWith("_id") && key !== "guid")
    .map(([key, value]) => cell(displayValue(value), fields.get(key)?.type))
    .filter((v): v is string => v !== null && v !== "");
  const line = parts.join(", ");
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || "—";
};

/** A human handle for a row, for confirmation copy and result chips. */
const describeRow = (row: UcodeItem | null, table: string): string =>
  (row ? rowLabel(row) : null) ?? noun(table).nom;

/**
 * What one row of a table is called, in the two forms the confirmation copy
 * needs: "Создать сотрудника?" (accusative) and "Изменит 1 поле — сотрудник"
 * (nominative). The card is the last thing a person reads before a record
 * changes, so it has to name what is changing in their own language rather
 * than showing them a table slug.
 */
const TABLE_NOUNS: Record<
  string,
  { nom: string; acc: string; ending: string }
> = {
  user_base: { nom: "сотрудник", acc: "сотрудника", ending: "" },
  attendance: { nom: "отметка посещаемости", acc: "отметку посещаемости", ending: "а" },
  absences: { nom: "отсутствие", acc: "отсутствие", ending: "о" },
  absence_policies: { nom: "политика отсутствий", acc: "политику отсутствий", ending: "а" },
  departments: { nom: "отдел", acc: "отдел", ending: "" },
  positions: { nom: "должность", acc: "должность", ending: "а" },
  locations: { nom: "филиал", acc: "филиал", ending: "" },
  regions: { nom: "регион", acc: "регион", ending: "" },
  employment_types: { nom: "тип занятости", acc: "тип занятости", ending: "" },
  experience_levels: { nom: "уровень опыта", acc: "уровень опыта", ending: "" },
  skills: { nom: "навык", acc: "навык", ending: "" },
  trainings: { nom: "тренинг", acc: "тренинг", ending: "" },
  documents: { nom: "документ", acc: "документ", ending: "" },
  vacancies: { nom: "вакансия", acc: "вакансию", ending: "а" },
  candidates: { nom: "кандидат", acc: "кандидата", ending: "" },
};

/** The card is read by a person: "active → dismissed" should say Активен → Уволен. */
const cell = (value: string | null, type: string | undefined): string | null => {
  const formatted = formatCell(value, type);
  return typeof formatted === "string" ? formatted : value;
};

const noun = (table: string): { nom: string; acc: string; ending: string } =>
  TABLE_NOUNS[table] ?? { nom: "запись", acc: "запись", ending: "а" };

/** 1 поле / 2 поля / 5 полей. */
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};
