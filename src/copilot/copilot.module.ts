import { Module } from "@nestjs/common";
import { CopilotController } from "./copilot.controller";
import { CopilotService } from "./copilot.service";
import { CopilotConcurrencyService } from "./copilot-concurrency.service";
import { ConversationStore } from "./conversation.store";
import { TableCatalog } from "./prompt/catalog";
import { SystemPromptBuilder } from "./prompt/system-prompt";
import { CopilotToolRegistry } from "./tools/tool-registry.service";
import { CopilotDataTools } from "./tools/data.tools";
import { CopilotReportTools } from "./tools/report.tools";
import { CopilotMutationTools } from "./tools/mutation.tools";
import { CopilotNavigationTools } from "./tools/navigation.tools";
import { CopilotKnowledgeTools } from "./tools/knowledge.tools";

@Module({
  controllers: [CopilotController],
  providers: [
    CopilotService,
    CopilotConcurrencyService,
    ConversationStore,
    TableCatalog,
    SystemPromptBuilder,
    CopilotToolRegistry,
    CopilotDataTools,
    CopilotReportTools,
    CopilotMutationTools,
    CopilotNavigationTools,
    CopilotKnowledgeTools,
  ],
  // The Telegram surface runs the same loop against the same Conversations.
  exports: [CopilotService, ConversationStore],
})
export class CopilotModule {}
