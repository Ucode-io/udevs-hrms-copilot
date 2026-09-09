import { Global, Module } from "@nestjs/common";
import { CONFIG, loadConfig } from "../config/configuration";
import { UcodeClient } from "./ucode.client";
import { CallerService } from "../auth/caller.service";
import { CallerGuard } from "../auth/caller.guard";

/**
 * Config, the ucode client and Caller resolution are needed by every feature,
 * so they are provided once and globally rather than re-imported everywhere.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    UcodeClient,
    CallerService,
    CallerGuard,
  ],
  exports: [CONFIG, UcodeClient, CallerService, CallerGuard],
})
export class UcodeModule {}
