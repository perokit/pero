import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ensureGitignoreLine,
  EnvFilePermissionError,
  readEnvFile,
  setEnvValue,
} from '../config/env-file.js';
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from '../config/secret-store.js';
import {
  TELEGRAM_TOKEN_ENV,
  telegramBotTokenSchema,
} from '../config/settings-input.js';
import type { TokenSource } from '../control/protocol.js';
import { ComponentHealth } from '../health/component-health.js';
import { CONNECTING_DETAIL } from './telegram-status.js';

export const TELEGRAM_OPTIONS = Symbol('TELEGRAM_OPTIONS');

/** File name of the stored bot token in `secrets/`. */
export const TELEGRAM_TOKEN_SECRET = 'telegram-bot-token';

export interface TelegramOptions {
  /** A legacy data directory's owner-only `secrets/`; unused with `envFile`. */
  secretsDir: string;
  /** A workspace's `.env`, which holds the token instead of `secrets/`. */
  envFile?: string | null;
  /** The workspace's `.gitignore`, made to list `.env` when it is written. */
  gitignore?: string | null;
  /** The daemon's environment, which may carry the token. */
  env: NodeJS.ProcessEnv;
  /** The Bot API server; Telegram's own unless set. */
  apiRoot?: string;
}

/**
 * The Telegram bot token: from the environment when it is set there,
 * otherwise from the workspace's `.env`, or from `secrets/` in a legacy data
 * directory. Never logged and never sent to the CLI. It
 * reports the Telegram component while there is no valid token; with one,
 * it reports connecting until the adapter says how the connection stands.
 */
@Injectable()
export class TelegramCredentials implements OnModuleInit {
  private readonly logger = new Logger('Telegram');
  private current: string | null = null;
  private currentSource: TokenSource | null = null;
  private readonly listeners = new Set<(token: string | null) => void>();

  constructor(
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
    private readonly health: ComponentHealth,
  ) {}

  onModuleInit(): void {
    this.resolve();
  }

  /** The token in use, or null when there is no valid one. */
  token(): string | null {
    return this.current;
  }

  /** Where the token comes from; null when neither place has one. */
  source(): TokenSource | null {
    return this.currentSource;
  }

  /**
   * Calls `listener` with the token in use each time it may have changed;
   * returns a function that stops the calls.
   */
  onChange(listener: (token: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stores `token`, or removes the stored one when null, and takes it into
   * use at once. A token in the environment still wins over the stored one.
   */
  set(token: string | null): void {
    const value = token === null ? null : telegramBotTokenSchema.parse(token);
    const { envFile, gitignore, secretsDir } = this.options;
    if (envFile) {
      setEnvValue(envFile, TELEGRAM_TOKEN_ENV, value);
      if (
        value !== null &&
        gitignore &&
        ensureGitignoreLine(gitignore, '.env')
      ) {
        this.logger.log(`Added .env to ${gitignore}`);
      }
    } else if (value === null) {
      deleteSecret(secretsDir, TELEGRAM_TOKEN_SECRET);
    } else {
      writeSecret(secretsDir, TELEGRAM_TOKEN_SECRET, value);
    }
    this.logger.log(
      value === null ? 'Stored bot token removed' : 'Bot token stored',
    );
    this.resolve();
    for (const listener of this.listeners) listener(this.current);
  }

  private resolve(): void {
    const fromEnv = this.options.env[TELEGRAM_TOKEN_ENV]?.trim();
    if (fromEnv) {
      this.currentSource = 'environment';
      const parsed = telegramBotTokenSchema.safeParse(fromEnv);
      this.current = parsed.success ? parsed.data : null;
      if (parsed.success) {
        this.health.report('telegram', 'degraded', CONNECTING_DETAIL);
      } else {
        this.health.report(
          'telegram',
          'degraded',
          `${TELEGRAM_TOKEN_ENV} is not a valid bot token`,
        );
      }
      return;
    }

    let stored: string | null;
    try {
      stored = this.stored();
    } catch (error) {
      // Refused rather than read, as ssh refuses a key others can read.
      if (!(error instanceof EnvFilePermissionError)) throw error;
      this.currentSource = 'env-file';
      this.current = null;
      this.health.report('telegram', 'degraded', error.message);
      return;
    }
    const parsed = stored ? telegramBotTokenSchema.safeParse(stored) : null;
    this.currentSource = stored
      ? this.options.envFile
        ? 'env-file'
        : 'secrets'
      : null;
    this.current = parsed?.success ? parsed.data : null;
    if (!parsed) {
      this.health.report('telegram', 'unconfigured', 'Bot token is not set');
    } else if (parsed.success) {
      this.health.report('telegram', 'degraded', CONNECTING_DETAIL);
    } else {
      this.health.report(
        'telegram',
        'degraded',
        'The stored bot token is not valid; set it again',
      );
    }
  }

  /** The token stored in `.env` or `secrets/`, trimmed; null when none is. */
  private stored(): string | null {
    const { envFile, secretsDir } = this.options;
    if (!envFile) return readSecret(secretsDir, TELEGRAM_TOKEN_SECRET);
    return readEnvFile(envFile)?.get(TELEGRAM_TOKEN_ENV)?.trim() || null;
  }
}
