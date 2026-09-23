import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { TelegramService } from "./telegram.service";

/** Telegram echoes the secret given to setWebhook on every delivery. */
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

@Controller("telegram")
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    @Inject(CONFIG) private readonly config: CopilotConfig,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Telegram's delivery endpoint.
   *
   * Answers 200 immediately and does the work after: Telegram treats a slow or
   * failed webhook as undelivered and sends the same update again, and one
   * question here can legitimately take five minutes. Answering first is what
   * stops a hard question from being asked three times over.
   *
   * Exempt from the throttler — it is per-IP, and every update in the system
   * arrives from the same handful of Telegram addresses, so the limit would be
   * shared by the entire company. The per-person limit that does apply lives in
   * CopilotConcurrencyService.
   */
  @Post("webhook")
  @HttpCode(200)
  @SkipThrottle()
  webhook(@Body() update: unknown, @Req() req: Request): { ok: true } {
    const expected = this.config.telegram.webhookSecret;
    if (!expected) {
      throw new ServiceUnavailableException("Telegram webhook is not configured.");
    }
    if (req.headers[SECRET_HEADER] !== expected) {
      // The URL is public by nature; this header is the whole of the proof that
      // an update came from Telegram and not from someone who guessed it.
      this.logger.warn("telegram webhook: bad secret token, update rejected");
      throw new ForbiddenException();
    }

    void this.telegram.handleUpdate(update);
    return { ok: true };
  }
}
