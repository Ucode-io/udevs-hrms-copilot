import { Module } from "@nestjs/common";
import { CopilotModule } from "../copilot/copilot.module";
import { TelegramApi } from "./telegram.api";
import { TelegramCallerService } from "./telegram-caller.service";
import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";

/**
 * The bot surface. Depends on CopilotModule rather than duplicating anything:
 * a question from Telegram runs the same loop, the same tools and the same
 * Conversation store as one from the panel.
 */
@Module({
  imports: [CopilotModule],
  controllers: [TelegramController],
  providers: [TelegramApi, TelegramCallerService, TelegramService],
})
export class TelegramModule {}
