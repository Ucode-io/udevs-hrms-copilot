import { Inject, Injectable } from "@nestjs/common";
import { CONFIG, type CopilotConfig } from "../config/configuration";

/**
 * Caps how many Copilot streams one person can keep open at once.
 *
 * The throttler bounds how often a stream can be *started*, which is a different
 * question: an agentic loop holds its connection for as long as it runs, so a
 * client that opens streams without closing them can pin several expensive
 * loops while never exceeding a per-minute request limit.
 *
 * State is per-process, which is the right granularity here — it protects one
 * box from one client, and the throttler is the cross-instance gate.
 */
@Injectable()
export class CopilotConcurrencyService {
  private readonly active = new Map<string, number>();
  private readonly max: number;

  constructor(@Inject(CONFIG) config: CopilotConfig) {
    this.max = config.maxConcurrentStreams;
  }

  /** Reserves a slot; false when the caller is already at the cap. */
  tryAcquire(userId: string): boolean {
    const current = this.active.get(userId) ?? 0;
    if (current >= this.max) return false;
    this.active.set(userId, current + 1);
    return true;
  }

  /** Releases a slot. Safe to call once per successful acquire. */
  release(userId: string): void {
    const current = this.active.get(userId) ?? 0;
    if (current <= 1) this.active.delete(userId);
    else this.active.set(userId, current - 1);
  }
}
