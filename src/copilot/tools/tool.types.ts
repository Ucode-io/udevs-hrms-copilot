import type {
  CopilotChart,
  CopilotFieldChange,
  CopilotKpi,
  CopilotLink,
  CopilotTable,
  CopilotToolRisk,
} from "../types/copilot.types";
import type { CallerContext } from "../../ucode/ucode.types";

/**
 * Per-request context handed to every Tool. Built server-side from the bearer
 * token — the model supplies none of it, and in particular not `companiesId`,
 * which scopes every read and write.
 */
export interface CopilotToolContext {
  caller: CallerContext;
  /** HRMS route the person is looking at, for situational awareness. */
  route?: string | null;
}

/** Normalised result every Tool returns. */
export interface CopilotToolResult {
  ok: boolean;
  /** Short human-readable Summary — read by the model, shown on a result chip. */
  summary: string;
  /** Structured payload fed back to the model. Kept small on purpose. */
  data?: unknown;
  /**
   * Artifacts rendered for the person, kept OUT of the token stream: the model
   * is told what was drawn, never the figures inside. That is what makes a
   * charted or tabulated number impossible to misquote.
   */
  charts?: CopilotChart[];
  kpis?: CopilotKpi[];
  tables?: CopilotTable[];
  links?: CopilotLink[];
  /** Present when `ok === false`. */
  error?: string;
}

/** The render artifacts one tool call produced, stored under its tool_use id. */
export interface CopilotArtifactBundle {
  charts?: CopilotChart[];
  kpis?: CopilotKpi[];
  tables?: CopilotTable[];
  links?: CopilotLink[];
}

/** JSON-Schema-ish shape for a Tool's input. Never contains a Company. */
export type CopilotToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface CopilotTool {
  name: string;
  description: string;
  inputSchema: CopilotToolInputSchema;
  risk: CopilotToolRisk;
  /** Builds the confirmation card copy for a destructive Tool. */
  summarize?(
    input: Record<string, unknown>,
    ctx: CopilotToolContext,
  ):
    | { title: string; description: string; changes?: CopilotFieldChange[] }
    | Promise<{
        title: string;
        description: string;
        changes?: CopilotFieldChange[];
      }>;
  execute(
    input: Record<string, unknown>,
    ctx: CopilotToolContext,
  ): Promise<CopilotToolResult>;
}

export interface CopilotToolGroup {
  getTools(): CopilotTool[];
}

/** Held on a Conversation while a destructive action awaits confirmation. */
export interface CopilotPendingAction {
  actionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string;
  description: string;
  changes?: CopilotFieldChange[];
  risk: CopilotToolRisk;
  createdAt: string;
}
