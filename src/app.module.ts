import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { UcodeModule } from "./ucode/ucode.module";
import { CopilotModule } from "./copilot/copilot.module";
import { TelegramModule } from "./telegram/telegram.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    // Bounds how often a stream can be *started*. How many stay open at once is
    // a different question, handled by CopilotConcurrencyService.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 60 }]),
    UcodeModule,
    CopilotModule,
    TelegramModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
