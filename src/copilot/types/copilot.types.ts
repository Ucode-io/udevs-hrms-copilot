// ─── HRMS Copilot protocol ──────────────────────────────────────────────────
//
// Shared contract between this service and the HRMS admin SPA
// (udevs_hrms_admin, src/features/copilot). Ported from the VirtuOps Copilot
// protocol and trimmed to what HRMS needs.
//
// Transport: POST /copilot/chat and POST /copilot/confirm both return a
// `text/event-stream` of `CopilotStreamEvent`s, each framed as a single SSE
// data line — `data: ${JSON.stringify(event)}\n\n`.

/**
 * Risk class of a Tool, which decides the execution policy:
 *   - `read`        → runs inline, result fed back to the model, no UI chip.
 *   - `write`       → runs inline and emits `action_executed` so the person
 *                     sees what changed.
 *   - `destructive` → NOT run inline. The loop pauses, emits `action_proposed`
 *                     and waits for POST /copilot/confirm.
 *
 * In HRMS every mutation is `destructive`: creating an employee wires up
 * relations and a login, updating one changes a personnel record. Both deserve
 * an explicit yes. `write` stays in the union because the loop supports it and
 * a future low-stakes mutation may want it.
 */
export type CopilotToolRisk = "read" | "write" | "destructive";

// ─── Charts ─────────────────────────────────────────────────────────────────

/** Visual form of a rendered chart. Maps 1:1 onto an ApexCharts `chart.type`. */
export type CopilotChartKind = "area" | "line" | "bar" | "pie" | "donut";

/** How a numeric value is formatted on an axis / in a tooltip. */
export type CopilotChartFormat = "number" | "currency" | "percent" | "duration";

/** One plotted series in an area/line/bar chart. */
export interface CopilotChartSeries {
  /** Key into each data row holding this series' numeric value. */
  key: string;
  /** Human label for the legend/tooltip. Defaults to `key`. */
  label?: string;
  /** Value formatting hint. Defaults to "number". */
  format?: CopilotChartFormat;
}

/**
 * A chart rendered inline in an assistant message. Built server-side from the
 * actual query result — never from numbers the model retyped — which is why a
 * charted figure cannot be hallucinated. The model only picks the kind and the
 * title, and is told which charts were drawn, not what is in them.
 */
export interface CopilotChart {
  /** Stable id (React key; also the Artifact key used for replay). */
  id: string;
  kind: CopilotChartKind;
  title: string;
  /** Optional context line, e.g. the date range. */
  subtitle?: string;
  /** For area/line/bar: `{ [xKey]: label, [series.key]: number }` per row.
   *  For pie/donut: `{ name, value }` per row. */
  data: Array<Record<string, string | number>>;
  /** Row key used as the X-axis category. Default "label". Ignored for pie/donut. */
  xKey?: string;
  /** Series to plot. Ignored for pie/donut (which read `{name, value}`). */
  series?: CopilotChartSeries[];
}

/** A single headline number shown above the charts. */
export interface CopilotKpi {
  label: string;
  value: string;
  /** Signed percentage change vs the comparison window, when one exists. */
  changePct?: number | null;
  hint?: string;
}

// ─── Deep links ─────────────────────────────────────────────────────────────

/** What a deep link points at — drives the icon the dock renders. */
export type CopilotLinkKind =
  | "employee"
  | "employees"
  | "reports"
  | "time"
  | "settings"
  | "knowledge"
  | "external";

/**
 * A clickable affordance surfaced when something is better finished on a page
 * than in chat — opening an employee, jumping to a report, or a create form
 * pre-filled with what was discussed. Built server-side; rendered as a button.
 *
 * In-app hrefs are bare react-router paths (e.g. "/employees/<guid>").
 */
export interface CopilotLink {
  /** Stable id (React key; also the Artifact key used for replay). */
  id: string;
  label: string;
  href: string;
  /** True when `href` is absolute and should open in a new tab. */
  external?: boolean;
  kind?: CopilotLinkKind;
  description?: string;
}

/** Why the assistant turn stopped. */
export type CopilotStopReason =
  | "end_turn"
  | "awaiting_confirmation"
  | "max_turns"
  /** The model hit the per-turn output cap — the reply is truncated. */
  | "max_tokens"
  | "error"
  | "refusal";

export type CopilotErrorCode =
  | "forbidden"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "invalid_action"
  | "action_expired"
  /** The Anthropic call or the overall loop exceeded its deadline. */
  | "timeout"
  /** Misconfigured or unpayable upstream — retrying will not help. */
  | "unavailable"
  | "internal";

/**
 * A destructive action awaiting explicit confirmation. `args` are already
 * validated server-side; the client only displays `title`/`description` and
 * echoes `actionId` back on confirm.
 */
export interface CopilotProposedAction {
  actionId: string;
  toolName: string;
  title: string;
  description: string;
  args: Record<string, unknown>;
  risk: CopilotToolRisk;
  /** Field-level before/after for an update, so the card shows what changes. */
  changes?: CopilotFieldChange[];
}

/** One field a confirmed update will change. */
export interface CopilotFieldChange {
  field: string;
  label?: string;
  before: string | null;
  after: string | null;
}

/** Outcome of an executed action. */
export interface CopilotExecutedAction {
  actionId: string;
  toolName: string;
  ok: boolean;
  summary: string;
  error?: string;
}

/** Server → client streaming events (SSE). Discriminated on `type`. */
export type CopilotStreamEvent =
  | { type: "message_start"; messageId: string; conversationId: string }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      toolUseId: string;
      risk: CopilotToolRisk;
    }
  | { type: "action_executed"; action: CopilotExecutedAction }
  | { type: "action_proposed"; action: CopilotProposedAction }
  | { type: "chart"; chart: CopilotChart }
  | { type: "kpis"; kpis: CopilotKpi[] }
  | { type: "link"; link: CopilotLink }
  | { type: "table"; table: CopilotTable }
  | {
      type: "message_complete";
      messageId: string;
      stopReason: CopilotStopReason;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string; code?: CopilotErrorCode };

/**
 * A result set rendered as a table instead of being retyped into prose. Same
 * guarantee as a chart: the rows come from the query result, so a listed name
 * or date is never invented. The model gets a compact preview plus the row
 * count and is told the full table is already on screen.
 */
export interface CopilotTable {
  id: string;
  title: string;
  subtitle?: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
  /** Total matching rows, when more exist than were rendered. */
  totalCount?: number;
  /** Deep link opening the same result in the HRMS UI, when one applies. */
  link?: CopilotLink;
}

/** Body of POST /copilot/chat. */
export interface CopilotChatRequest {
  conversationId?: string | null;
  message: string;
  context?: {
    /** Current HRMS route, for the agent's situational awareness. */
    route?: string | null;
  };
}

/** Body of POST /copilot/confirm. Returns the same SSE stream as /chat. */
export interface CopilotConfirmRequest {
  conversationId: string;
  actionId: string;
  decision: "approve" | "reject";
}

// ─── Session history ────────────────────────────────────────────────────────

export interface CopilotConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotConversationDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CopilotMessage[];
  /** actionId still awaiting confirmation, so a reopened panel re-renders it. */
  pendingActionId: string | null;
}

// ─── Client-side view models ────────────────────────────────────────────────

export type CopilotMessageRole = "user" | "assistant";

export type CopilotActionState =
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "failed";

export interface CopilotMessageAction {
  actionId: string;
  toolName: string;
  title: string;
  description: string;
  risk: CopilotToolRisk;
  state: CopilotActionState;
  changes?: CopilotFieldChange[];
  summary?: string;
  error?: string;
}

export type CopilotMessageStatus = "streaming" | "complete" | "error";

export interface CopilotMessage {
  id: string;
  role: CopilotMessageRole;
  content: string;
  createdAt: string;
  actions?: CopilotMessageAction[];
  charts?: CopilotChart[];
  kpis?: CopilotKpi[];
  tables?: CopilotTable[];
  links?: CopilotLink[];
  status?: CopilotMessageStatus;
  /** True when the reply was cut off by the output token cap. */
  truncated?: boolean;
  /** Name of the file sent with this message, for the chip on it. */
  file?: { name: string; size: number };
}
