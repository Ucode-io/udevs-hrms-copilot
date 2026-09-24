import { randomUUID } from "crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { UcodeClient } from "../ucode/ucode.client";
import type { CallerContext } from "../ucode/ucode.types";
import type { CopilotStreamEvent } from "./types/copilot.types";

/** What the billing FaaS says about a company's AI allowance this period. */
/**
 * The billing limit is denominated in dollars of model cost, not tokens: input,
 * output, cache write and cache read tokens differ in price by up to 50x, so a
 * token count says nothing about what a month actually cost.
 */
export interface BillingQuota {
  allowed: boolean;
  reason: "quota_exceeded" | "read_only" | "ai_disabled" | null;
  limitUsd: number | null;
  spentUsd: number;
  purchasedUsd: number;
  remainingUsd: number | null;
}

/** Fail-open default: billing being down must never take the Copilot down. */
const OPEN: BillingQuota = {
  allowed: true,
  reason: null,
  limitUsd: null,
  spentUsd: 0,
  purchasedUsd: 0,
  remainingUsd: null,
};

const QUOTA_CHECK = "billing_ai_quota_check";
const USAGE_RECORD = "billing_ai_usage_record";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The gateway nests the method result a few envelopes deep; find the quota. */
const toQuota = (raw: unknown, depth = 0): BillingQuota | null => {
  if (depth > 5 || !isRecord(raw)) return null;
  if (typeof raw.allowed === "boolean") {
    const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
    return {
      allowed: raw.allowed,
      reason: (raw.reason as BillingQuota["reason"]) ?? null,
      limitUsd: raw.limit_usd == null ? null : n(raw.limit_usd),
      spentUsd: n(raw.spent_usd),
      purchasedUsd: n(raw.purchased_usd),
      remainingUsd: raw.remaining_usd == null ? null : n(raw.remaining_usd),
    };
  }
  for (const key of ["result", "data", "response"]) {
    const found = toQuota(raw[key], depth + 1);
    if (found) return found;
  }
  return null;
};

export interface UsageMeter {
  observe(event: CopilotStreamEvent): void;
  flush(): void;
}

/**
 * Per-company AI token quota, enforced by the billing FaaS (udevs-hrms-billing).
 *
 * `check` runs before a stream starts and is cached briefly per company; the
 * FaaS stays the source of truth (this pod is single-replica but restarts on
 * every deploy). `meter` sums the `usage` events of one user turn and reports
 * them once in `finally`, so aborted streams are billed too. Both fail open:
 * a billing outage is logged, never surfaced to the person asking a question.
 */
@Injectable()
export class BillingQuotaService {
  private readonly logger = new Logger(BillingQuotaService.name);
  private readonly cache = new Map<string, { until: number; quota: BillingQuota }>();

  constructor(
    @Inject(CONFIG) private readonly config: CopilotConfig,
    private readonly ucode: UcodeClient,
  ) {}

  async check(caller: CallerContext): Promise<BillingQuota> {
    const cached = this.cache.get(caller.companiesId);
    if (cached && cached.until > Date.now()) return cached.quota;
    try {
      const raw = await this.ucode.invokeFunction(
        caller,
        this.config.hrms.billingFunction,
        QUOTA_CHECK,
        {},
      );
      const quota = toQuota(raw) ?? OPEN;
      this.cache.set(caller.companiesId, {
        until: Date.now() + this.config.billing.quotaCacheMs,
        quota,
      });
      return quota;
    } catch (e) {
      this.logger.warn(`Billing quota check failed, allowing: ${(e as Error).message}`);
      return OPEN;
    }
  }

  /** The SSE error a refused turn ends with. */
  refusal(quota: BillingQuota): CopilotStreamEvent {
    if (quota.reason === "read_only") {
      return {
        type: "error",
        code: "forbidden",
        message:
          "Подписка компании не оплачена — Копилот недоступен до оплаты. Обратитесь к администратору.",
      };
    }
    if (quota.reason === "ai_disabled") {
      return {
        type: "error",
        code: "forbidden",
        message: "Копилот не входит в тариф компании. Обратитесь к администратору.",
      };
    }
    return {
      type: "error",
      code: "quota_exceeded",
      message:
        "Лимит AI на этот месяц исчерпан. Обратитесь к администратору компании.",
    };
  }

  meter(caller: CallerContext, route: string | null): UsageMeter {
    let conversationId: string | null = null;
    let input = 0;
    let output = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let flushed = false;

    return {
      observe: (event) => {
        if (event.type === "message_start") conversationId = event.conversationId;
        if (event.type === "usage") {
          // The loop reports running totals, so the last event wins.
          input = event.inputTokens;
          output = event.outputTokens;
          cacheCreation = event.cacheCreationTokens ?? 0;
          cacheRead = event.cacheReadTokens ?? 0;
        }
      },
      flush: () => {
        if (flushed) return;
        flushed = true;
        const total = input + output + cacheCreation + cacheRead;
        const secret = this.config.billing.serviceSecret;
        if (total <= 0 || !secret) return;
        this.cache.delete(caller.companiesId);
        void this.ucode
          .invokeFunction(caller, this.config.hrms.billingFunction, USAGE_RECORD, {
            user_base_id: caller.userId,
            conversation_id: conversationId,
            route,
            model: this.config.model,
            usage: { input, output, cache_creation: cacheCreation, cache_read: cacheRead },
            request_id: randomUUID(),
            service_secret: secret,
          })
          .catch((e: Error) =>
            this.logger.warn(`Billing usage record failed (${total} tokens): ${e.message}`),
          );
      },
    };
  }
}
