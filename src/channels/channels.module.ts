import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SpeechModule } from '../speech/speech.module.js';
import { SystemModule } from '../system/system.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { AgentChannelTurns } from './agent-channel-turns.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelOnboardingService } from './channel-onboarding.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelAttachments } from './channel-attachments.js';
import { ChannelSender } from './channel-sender.js';
import { FileDelivery } from './file-delivery.js';
import { ChannelViews } from './channel-views.service.js';
import { ChannelCommands } from './commands/channel-commands.service.js';
import { WorkflowCommands } from './commands/workflow-commands.js';
import { ChannelOnboarding, ChannelTurns } from './channel-stages.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { PairingRequests } from './pairing-requests.js';
import { UnansweredReplies } from './unanswered-replies.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  TOOL_APPROVAL_TIMEOUT_MS,
  ToolApprovals,
} from './tool-approvals.js';

/**
 * The Channel router, the chat allowlist, onboarding, the hand-off to
 * turns, Pero's own commands, and the Channel views; adapters connect to
 * it.
 */
@Module({
  imports: [
    AgentsModule,
    SystemModule,
    HistoryModule,
    SessionsModule,
    HealthModule,
    WorkflowsModule,
    SpeechModule,
  ],
  providers: [
    ChannelRouter,
    ChannelCommands,
    WorkflowCommands,
    ChannelSender,
    FileDelivery,
    ChannelAttachments,
    ChannelViews,
    AllowedChatsService,
    InboundUpdates,
    PairingRequests,
    ToolApprovals,
    UnansweredReplies,
    {
      provide: TOOL_APPROVAL_TIMEOUT_MS,
      useValue: DEFAULT_APPROVAL_TIMEOUT_MS,
    },
    { provide: ChannelTurns, useClass: AgentChannelTurns },
    { provide: ChannelOnboarding, useClass: ChannelOnboardingService },
  ],
  exports: [
    ChannelOnboarding,
    ChannelRouter,
    ChannelSender,
    ChannelViews,
    AllowedChatsService,
    PairingRequests,
  ],
})
export class ChannelsModule {}
