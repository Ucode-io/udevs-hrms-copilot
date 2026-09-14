import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { CONFIG, type CopilotConfig } from "./config/configuration";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  // An attached spreadsheet or PDF arrives base64 in the chat body, which the
  // 100kb express default rejects long before the 4 MB the Copilot allows.
  app.useBodyParser("json", { limit: "6mb" });
  const config = app.get<CopilotConfig>(CONFIG);

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    // The SPA opens the SSE stream with fetch(), so the auth header has to come
    // through. Project-Id must be listed too, and this one decides deploy
    // order: a header the preflight does not allow is not dropped, it fails the
    // whole request, so a panel that sends it against a service that does not
    // list it cannot reach the Copilot at all. This service ships first.
    allowedHeaders: ["Content-Type", "Authorization", "Project-Id"],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.listen(config.port, "0.0.0.0");
  new Logger("bootstrap").log(
    `HRMS Copilot listening on :${config.port} (model ${config.model}, effort ${config.effort})`,
  );
}

void bootstrap();
