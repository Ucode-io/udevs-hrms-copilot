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
    projectId: string;
    environmentId: string;
    /** Used ONLY for the copilot's own bookkeeping collections. */
    serviceApiKey: string | null;
  };
  billing: {
    /** Shared with the billing FaaS; lets it trust usage records only from this service. */
    serviceSecret: string | null;
    quotaCacheMs: number;
  };
  hrms: {
    employeeRoleId: string | null;
    /** Stamped on every employee the SPA's own form creates. */
    clientTypeId: string;
    reportsFunction: string;
    /** Billing cloud function (AI quota + usage). */
    billingFunction: string;
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
    corsOrigins: str("CORS_ORIGINS", "http://localhost:5199")
      .split(",")
      .map((o) => o.trim())
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
    billing: {
      serviceSecret: optional("BILLING_SERVICE_SECRET"),
      quotaCacheMs: int("BILLING_QUOTA_CACHE_MS", 30_000),
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
      billingFunction: str("HRMS_BILLING_FUNCTION", "udevs-hrms-billing"),
    },
  };
};

export const CONFIG = "COPILOT_CONFIG";
