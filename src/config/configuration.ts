/**
 * Flat env-backed config. Everything the service needs is read once at boot and
 * validated here, so a missing key fails the pod at startup rather than mid
 * conversation.
 */
export interface CopilotConfig {
  port: number;
  corsOrigins: string[];
  anthropicApiKey: string | null;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxConcurrentStreams: number;
  ucode: {
    baseUrl: string;
    /**
     * Fallback project, used when a request carries no Project-Id header, and
     * the fixed project of the Copilot's own bookkeeping — the service API key
     * is issued against this one. Callers name their own project per request.
     */
    projectId: string;
    environmentId: string;
    /** Used ONLY for the copilot's own bookkeeping collections. */
    serviceApiKey: string | null;
  };
  hrms: {
    employeeRoleId: string | null;
    /** Stamped on every employee the SPA's own form creates. */
    clientTypeId: string;
    reportsFunction: string;
  };
  telegram: {
    /**
     * The HRMS bot's token. Absent means the bot half of this service is off —
     * the webhook route then refuses rather than half-working, and the panel is
     * unaffected.
     */
    botToken: string | null;
    /**
     * Shared with Telegram through setWebhook and echoed back by it on every
     * call as X-Telegram-Bot-Api-Secret-Token. The webhook URL is public, so
     * this is the only thing separating Telegram from anyone who guesses it.
     */
    webhookSecret: string | null;
    /** ucode cloud function owning group and phone binding. */
    hickvisionFunction: string;
    /**
     * Base URL of the HRMS panel, used to turn the Copilot's in-app links
     * ("/employees/<guid>") into buttons. Without it those links are dropped
     * rather than sent as a path Telegram cannot open.
     */
    webUrl: string | null;
  };
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const str = (key: string, fallback?: string): string => {
  const v = process.env[key]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
};

const optional = (key: string): string | null =>
  process.env[key]?.trim() || null;

const int = (key: string, fallback: number): number => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const loadConfig = (): CopilotConfig => {
  const effort = str("COPILOT_EFFORT", "high");
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `COPILOT_EFFORT must be one of ${EFFORTS.join(" | ")}, got "${effort}"`,
    );
  }

  return {
    port: int("PORT", 8080),
    // A trailing slash is stripped rather than honoured. An Origin header is
    // scheme://host[:port] and never carries one, so "https://hrms.ucode.co/"
    // matches nothing — and the way that fails is a browser CORS error that
    // reads as the service being down, from a value that looks correct in
    // Vault. Same treatment as UCODE_BASE_URL below, for the same reason.
    corsOrigins: str("CORS_ORIGINS", "http://localhost:5199")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    anthropicApiKey: optional("ANTHROPIC_API_KEY"),
    model: str("COPILOT_MODEL", "claude-sonnet-5"),
    effort: effort as CopilotConfig["effort"],
    maxConcurrentStreams: int("COPILOT_MAX_CONCURRENT_STREAMS", 2),
    ucode: {
      baseUrl: str("UCODE_BASE_URL", "https://api.admin.u-code.io").replace(
        /\/+$/,
        "",
      ),
      projectId: str("UCODE_PROJECT_ID"),
      environmentId: str("UCODE_ENVIRONMENT_ID"),
      serviceApiKey: optional("UCODE_SERVICE_API_KEY"),
    },
    hrms: {
      employeeRoleId: optional("HRMS_EMPLOYEE_ROLE_ID"),
      // The constant the HRMS employee form hardcodes (Employees/Form/index.tsx).
      // user_base is an auth table, and a create the SPA's own form would make is
      // the only shape known to be accepted.
      clientTypeId: str(
        "HRMS_CLIENT_TYPE_ID",
        "1c435896-2f12-4b61-a684-62ad1d2307d1",
      ),
      reportsFunction: str("HRMS_REPORTS_FUNCTION", "udevs-hrms-reports"),
    },
    telegram: {
      botToken: optional("TELEGRAM_BOT_TOKEN"),
      webhookSecret: optional("TELEGRAM_WEBHOOK_SECRET"),
      hickvisionFunction: str(
        "HRMS_HICKVISION_FUNCTION",
        "udevs-hrms-hickvision",
      ),
      webUrl: optional("HRMS_WEB_URL")?.replace(/\/+$/, "") ?? null,
    },
  };
};

export const CONFIG = "COPILOT_CONFIG";
