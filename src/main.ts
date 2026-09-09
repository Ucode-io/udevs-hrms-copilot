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
    // The SPA opens the SSE stream with fetch(), so it needs the auth header
    // through and nothing else special.
    allowedHeaders: ["Content-Type", "Authorization"],
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
