import { type DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentsModule } from './agents/agents.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import type { DataDirLayout } from './config/data-dir.js';
import { resolveDaemonEnv } from './config/daemon-env.js';
import { ControlModule } from './control/control.module.js';
import { HealthModule } from './health/health.module.js';
import { HistoryRetentionModule } from './history/history-retention.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { RuntimeOptionsModule } from './runtimes/runtimes.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { TriggersModule } from './triggers/triggers.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

export interface AppOptions {
  layout: DataDirLayout;
  /**
   * Where settings such as the Telegram bot token may come from; by default
   * the process's own environment.
   */
  env?: NodeJS.ProcessEnv;
}

/** Full daemon module graph. The CLI never imports this module. */
@Module({})
export class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    const env = options.env ?? process.env;
    // Invalid values fail startup, before anything opens.
    const daemonEnv = resolveDaemonEnv(env);
    return {
      module: AppModule,
      imports: [
        HealthModule,
        RuntimeOptionsModule.forRoot(
          daemonEnv.fakeRuntime ? { fake: daemonEnv.fakeRuntime } : {},
        ),
        PersistenceModule.forRoot({ database: options.layout.database }),
        SettingsModule,
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
        TriggersModule,
        ScheduleModule.forRoot(),
        SchedulerModule,
        NotificationsModule,
        HistoryRetentionModule,
        TelegramModule.forRoot({
          secretsDir: options.layout.secrets,
          envFile: options.layout.envFile,
          gitignore: options.layout.workspaceGitignore,
          env,
          ...(daemonEnv.telegramApiRoot
            ? { apiRoot: daemonEnv.telegramApiRoot }
            : {}),
        }),
        ProvidersModule,
        ControlModule.forRoot({ layout: options.layout }),
      ],
    };
  }
}
