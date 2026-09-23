import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  HttpException,
  Logger,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { Caller, CallerGuard } from "../auth/caller.guard";
import type { CallerContext } from "../ucode/ucode.types";
import { CopilotService } from "./copilot.service";
import { CopilotChatDto } from "./dto/copilot-chat.dto";
import { CopilotConfirmDto } from "./dto/copilot-confirm.dto";
import type {
  CopilotConversationDetail,
  CopilotConversationSummary,
  CopilotErrorCode,
  CopilotStreamEvent,
} from "./types/copilot.types";

@Controller("copilot")
@UseGuards(CallerGuard)
export class CopilotController {
  private readonly logger = new Logger(CopilotController.name);

  /**
   * HTTP status of an escaping exception to a stable, client-safe code. Anything
   * unlisted collapses to `internal` — the raw message is logged, never sent.
   */
  private static readonly STATUS_TO_CODE: Record<number, CopilotErrorCode> = {
    401: "forbidden",
    403: "forbidden",
    404: "not_found",
    429: "rate_limited",
  };

  private static readonly SAFE_MESSAGE: Record<CopilotErrorCode, string> = {
    forbidden: "You don't have access to do that.",
    permission_denied: "You don't have permission to do that.",
    not_found: "That couldn't be found.",
    rate_limited: "Too many requests. Wait a moment and try again.",
    invalid_action: "That action is no longer valid.",
    action_expired: "That action has expired. Please try again.",
    timeout: "The Copilot took too long to respond. Please try again.",
    unavailable: "The Copilot is unavailable. Please tell your administrator.",
    quota_exceeded:
      "The company's AI token allowance for this period is used up. Ask your administrator to add a token pack.",
    internal: "Something went wrong. Please try again.",
  };

  constructor(private readonly service: CopilotService) {}

  @Post("chat")
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async chat(
    @Body() dto: CopilotChatDto,
    @Caller() caller: CallerContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.service.isConfigured) {
      throw new ServiceUnavailableException("Copilot is not available");
    }
    await this.stream(res, this.service.streamChat(caller, dto));
  }

  @Post("confirm")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async confirm(
    @Body() dto: CopilotConfirmDto,
    @Caller() caller: CallerContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.service.isConfigured) {
      throw new ServiceUnavailableException("Copilot is not available");
    }
    await this.stream(res, this.service.streamConfirm(caller, dto));
  }

  /** Recent Conversations. Read-only, so it works even without an API key. */
  @Get("conversations")
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  listConversations(
    @Caller() caller: CallerContext,
  ): Promise<CopilotConversationSummary[]> {
    return this.service.listConversations(caller);
  }

  /** One Conversation, replayed. Read-only, so it works without an API key. */
  @Get("conversations/:id")
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  getConversation(
    @Param("id", ParseUUIDPipe) id: string,
    @Caller() caller: CallerContext,
  ): Promise<CopilotConversationDetail> {
    return this.service.getConversation(caller, id);
  }

  @Delete("conversations/:id")
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  deleteConversation(
    @Param("id", ParseUUIDPipe) id: string,
    @Caller() caller: CallerContext,
  ): Promise<void> {
    return this.service.deleteConversation(caller, id);
  }

  /**
   * Pumps an event generator out as SSE.
   *
   * `no-transform` and `X-Accel-Buffering: no` matter: without them a proxy will
   * happily buffer the whole stream and deliver it as one block at the end,
   * which looks exactly like the Copilot hanging.
   */
  private async stream(
    res: Response,
    generator: AsyncGenerator<CopilotStreamEvent>,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    const write = (event: CopilotStreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of generator) {
        if (closed) break;
        write(event);
      }
    } catch (e) {
      if (!closed) write(this.toErrorEvent(e));
    } finally {
      if (!closed) res.end();
    }
  }

  private toErrorEvent(
    e: unknown,
  ): Extract<CopilotStreamEvent, { type: "error" }> {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code = CopilotController.STATUS_TO_CODE[status];
      if (code) {
        this.logger.warn(`Copilot stream rejected: ${status} -> ${code} (${e.message})`);
        return {
          type: "error",
          code,
          message: CopilotController.SAFE_MESSAGE[code],
        };
      }
    }
    this.logger.error(
      "Copilot stream failed",
      e instanceof Error ? (e.stack ?? e.message) : String(e),
    );
    return {
      type: "error",
      code: "internal",
      message: CopilotController.SAFE_MESSAGE.internal,
    };
  }
}
