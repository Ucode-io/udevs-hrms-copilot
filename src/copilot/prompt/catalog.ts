import { readFileSync } from "fs";
import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { load } from "js-yaml";

export interface TableEntry {
  slug: string;
  label: string;
  description: string;
  hints: string[];
}

export interface ReportParam {
  name: string;
  description: string;
  required: boolean;
}

export interface ReportEntry {
  name: string;
  method: string;
  description: string;
  params: ReportParam[];
}

/**
 * The Allowlist and the Hints, loaded once from `tables.yaml`.
 *
 * Keeping this in YAML rather than TypeScript is deliberate: adding a table or
 * correcting a Hint is the most frequent change this service will see, and it
 * should not need a code review of control flow to land.
 */
@Injectable()
export class TableCatalog {
  private readonly logger = new Logger(TableCatalog.name);
  private readonly tables: Map<string, TableEntry>;
  private readonly reports: Map<string, ReportEntry>;

  constructor() {
    const raw = load(
      readFileSync(join(__dirname, "tables.yaml"), "utf8"),
    ) as {
      tables?: Array<Record<string, unknown>>;
      reports?: Array<Record<string, unknown>>;
    };

    this.tables = new Map(
      (raw.tables ?? []).map((t) => {
        const entry: TableEntry = {
          slug: String(t.slug),
          label: String(t.label ?? t.slug),
          description: String(t.description ?? "").trim(),
          hints: Array.isArray(t.hints)
            ? t.hints.map((h) => String(h).trim()).filter(Boolean)
            : [],
        };
        return [entry.slug, entry];
      }),
    );

    this.reports = new Map(
      (raw.reports ?? []).map((r) => {
        const entry: ReportEntry = {
          name: String(r.name),
          method: String(r.method),
          description: String(r.description ?? "").trim(),
          params: Array.isArray(r.params)
            ? r.params.map((p) => {
                const rec = p as Record<string, unknown>;
                return {
                  name: String(rec.name),
                  description: String(rec.description ?? ""),
                  required: rec.required === true,
                };
              })
            : [],
        };
        return [entry.name, entry];
      }),
    );

    this.logger.log(
      `Allowlist loaded: ${this.tables.size} tables, ${this.reports.size} reports`,
    );
  }

  /** True when the Copilot is permitted to touch this table at all. */
  allows(slug: string): boolean {
    return this.tables.has(slug);
  }

  table(slug: string): TableEntry | undefined {
    return this.tables.get(slug);
  }

  allTables(): TableEntry[] {
    return [...this.tables.values()];
  }

  report(name: string): ReportEntry | undefined {
    return this.reports.get(name);
  }

  allReports(): ReportEntry[] {
    return [...this.reports.values()];
  }

  /** Table slugs, for the enum on every table-taking Tool. */
  slugs(): string[] {
    return [...this.tables.keys()];
  }

  reportNames(): string[] {
    return [...this.reports.keys()];
  }

  /**
   * The one-line-per-table catalogue that goes in the system prompt. Column
   * detail is deliberately left out — the model calls describe_table for the one
   * table it actually needs, which keeps the cached prefix small and stops it
   * from confusing similarly-named columns across fifteen tables.
   */
  promptCatalog(): string {
    return this.allTables()
      .map((t) => `- ${t.slug} (${t.label}): ${collapse(t.description)}`)
      .join("\n");
  }

  promptReports(): string {
    return this.allReports()
      .map((r) => `- ${r.name}: ${collapse(r.description)}`)
      .join("\n");
  }
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
