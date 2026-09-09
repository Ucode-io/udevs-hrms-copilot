import { randomUUID } from "crypto";
import { HttpException, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { UcodeError } from "../../ucode/ucode.client";
import { CopilotDataTools } from "./data.tools";
import { CopilotReportTools } from "./report.tools";
import { CopilotMutationTools } from "./mutation.tools";
import { CopilotNavigationTools } from "./navigation.tools";
import { CopilotKnowledgeTools } from "./knowledge.tools";
import { CopilotToolError } from "./tool-support";
import type {
  CopilotPendingAction,
  CopilotTool,
  CopilotToolContext,
  CopilotToolResult,
} from "./tool.types";

@Injectable()
export class CopilotToolRegistry {
  private readonly logger = new Logger(CopilotToolRegistry.name);
  private readonly tools: Map<string, CopilotTool>;

  constructor(
    dataTools: CopilotDataTools,
    reportTools: CopilotReportTools,
    mutationTools: CopilotMutationTools,
    navigationTools: CopilotNavigationTools,
    knowledgeTools: CopilotKnowledgeTools,
  ) {
    const all = [
      ...dataTools.getTools(),
      ...reportTools.getTools(),
      ...mutationTools.getTools(),
      ...navigationTools.getTools(),
      ...knowledgeTools.getTools(),
    ];
    this.tools = new Map(all.map((t) => [t.name, t]));
    this.logger.log(`Registered ${this.tools.size} tools`);
  }

  get(name: string): CopilotTool | undefined {
    return this.tools.get(name);
  }

  /** Tool schemas for the Anthropic Messages API. No Company appears anywhere. */
  anthropicTools(): Anthropic.Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));
  }

  /** Builds the confirmation card for a destructive Tool. */
  async buildPendingAction(
    tool: CopilotTool,
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: CopilotToolContext,
  ): Promise<CopilotPendingAction> {
    let title = `Confirm: ${tool.name}`;
    let description = `Run "${tool.name}".`;
    let changes;

    if (tool.summarize) {
      try {
        const s = await tool.summarize(input, ctx);
        title = s.title;
        description = s.description;
        changes = s.changes;
      } catch (e) {
        // A summary that cannot be built is still worth confirming — show the
        // reason rather than a card the person cannot interpret.
        description = this.errorMessage(e) ?? description;
      }
    }

    return {
      actionId: randomUUID(),
      toolUseId,
      toolName: tool.name,
      input,
      title,
      description,
      ...(changes && changes.length > 0 ? { changes } : {}),
      risk: tool.risk,
      createdAt: new Date().toISOString(),
    };
  }

  async execute(
    ctx: CopilotToolContext,
    tool: CopilotTool,
    input: Record<string, unknown>,
  ): Promise<CopilotToolResult> {
    try {
      return await tool.execute(input, ctx);
    } catch (e) {
      // A Tool error is a message written for the model to recover from — an
      // unknown column comes back with the real column list, so the next turn
      // corrects itself instead of the person seeing "something went wrong".
      if (
        e instanceof CopilotToolError ||
        e instanceof UcodeError ||
        e instanceof HttpException
      ) {
        return {
          ok: false,
          summary: "That didn't work",
          error: this.errorMessage(e) ?? "That didn't work",
        };
      }
      this.logger.error(
        `Tool "${tool.name}" failed`,
        e instanceof Error ? e.stack : String(e),
      );
      return {
        ok: false,
        summary: "That didn't work",
        error: "Something went wrong while doing that.",
      };
    }
  }

  private errorMessage(e: unknown): string | null {
    if (e instanceof HttpException) {
      const res = e.getResponse();
      if (typeof res === "string") return res;
      if (res && typeof res === "object" && "message" in res) {
        const m = (res as { message: unknown }).message;
        if (Array.isArray(m)) return m.join("; ");
        if (typeof m === "string") return m;
      }
      return e.message;
    }
    if (e instanceof Error) return explain(e.message);
    return null;
  }
}

/**
 * Turns a Postgres failure into an instruction the model can act on.
 *
 * The raw text is accurate and useless: told "operator does not exist: date ~*
 * unknown", a model retries the same call until the turn budget runs out and
 * the person is left looking at a panel that simply stopped. Each of these was
 * observed in production, and each has exactly one correct next move.
 */
export const explain = (message: string): string => {
  const uuid = /invalid input syntax for type uuid: "([^"]+)"/.exec(message);
  if (uuid) {
    return `"${uuid[1]}" is a name, and a relation column holds a guid. Look it up first — list_items on the table the column points at (departments, positions, locations …), take the guid of the row whose title matches, and filter on that. Do not send the name.`;
  }

  if (/operator does not exist: (date|timestamp|text\[\]|uuid)[^~]*~\*/.test(message)) {
    return "Free-text search does not work on this table: the backend runs it over every column and gives up on date and list columns. Use filters instead — an exact field filter, or a range on the date column. Do not retry the search.";
  }

  if (/malformed array literal/.test(message)) {
    return "That column holds a list, so its value has to be sent as one — [\"active\"], not \"active\".";
  }

  if (/column "([^"]+)" does not exist/.test(message)) {
    const column = /column "([^"]+)" does not exist/.exec(message)?.[1];
    return `There is no column "${column}" on that table. Call describe_table and use a column from the list it returns.`;
  }

  return message;
};
