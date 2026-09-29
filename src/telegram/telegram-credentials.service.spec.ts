import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecret, writeSecret } from '../config/secret-store.js';
import { ComponentHealth } from '../health/component-health.js';
import {
  TELEGRAM_TOKEN_SECRET,
  TelegramCredentials,
} from './telegram-credentials.service.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OTHER = '987654321:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-xy';

describe('TelegramCredentials', () => {
  let tmp: string;
  let secretsDir: string;
  let health: ComponentHealth;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-telegram-'));
    secretsDir = join(tmp, 'secrets');
    mkdirSync(secretsDir, { mode: 0o700 });
    health = new ComponentHealth();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function create(env: NodeJS.ProcessEnv = {}) {
    const credentials = new TelegramCredentials({ secretsDir, env }, health);
    credentials.onModuleInit();
    return credentials;
  }

  const telegram = () => health.list().find((c) => c.name === 'telegram');

  it('is unconfigured without a token', () => {
    const credentials = create();

    expect(credentials.token()).toBeNull();
    expect(credentials.source()).toBeNull();
    expect(telegram()).toMatchObject({
      state: 'unconfigured',
      detail: 'Bot token is not set',
    });
  });

  it('stores a token owner-only and uses it at once', () => {
    const credentials = create();

    credentials.set(TOKEN);

    expect(credentials.token()).toBe(TOKEN);
    expect(credentials.source()).toBe('secrets');
    // The adapter reports the connection from here on.
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: 'Connecting to Telegram',
    });
    expect(readSecret(secretsDir, TELEGRAM_TOKEN_SECRET)).toBe(TOKEN);
    expect(statSync(join(secretsDir, TELEGRAM_TOKEN_SECRET)).mode & 0o777).toBe(
      0o600,
    );
  });

  it('reads a stored token on start and forgets it once removed', () => {
    create().set(TOKEN);
    const credentials = create();
    expect(credentials.token()).toBe(TOKEN);

    credentials.set(null);

    expect(credentials.token()).toBeNull();
    expect(telegram()).toMatchObject({ state: 'unconfigured' });
    expect(readSecret(secretsDir, TELEGRAM_TOKEN_SECRET)).toBeNull();
  });

  it('prefers the environment over the stored token', () => {
    create().set(OTHER);

    const credentials = create({ PERO_TELEGRAM_BOT_TOKEN: TOKEN });

    expect(credentials.token()).toBe(TOKEN);
    expect(credentials.source()).toBe('environment');
    expect(telegram()?.detail).toBe('Connecting to Telegram');

    // Stored, but the environment still wins.
    credentials.set(OTHER);
    expect(credentials.token()).toBe(TOKEN);
    expect(readSecret(secretsDir, TELEGRAM_TOKEN_SECRET)).toBe(OTHER);
  });

  it('reports an invalid token in the environment as degraded', () => {
    const credentials = create({ PERO_TELEGRAM_BOT_TOKEN: 'nope' });

    expect(credentials.token()).toBeNull();
    expect(credentials.source()).toBe('environment');
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: 'PERO_TELEGRAM_BOT_TOKEN is not a valid bot token',
    });
  });

  it('reports a damaged stored token as degraded', () => {
    writeFileSync(join(secretsDir, TELEGRAM_TOKEN_SECRET), 'garbage\n');

    const credentials = create();

    expect(credentials.token()).toBeNull();
    expect(telegram()?.state).toBe('degraded');
  });

  it('tells listeners about each change', () => {
    const credentials = create();
    const seen: (string | null)[] = [];
    const stop = credentials.onChange((token) => seen.push(token));

    credentials.set(TOKEN);
    credentials.set(null);
    stop();
    credentials.set(OTHER);

    expect(seen).toEqual([TOKEN, null]);
  });

  it('refuses an invalid token without storing it', () => {
    const credentials = create();

    expect(() => credentials.set('nope')).toThrow();
    expect(readSecret(secretsDir, TELEGRAM_TOKEN_SECRET)).toBeNull();
  });

  describe('in a workspace', () => {
    let envFile: string;
    let gitignore: string;

    beforeEach(() => {
      envFile = join(tmp, '.env');
      gitignore = join(tmp, '.gitignore');
    });

    function inWorkspace(env: NodeJS.ProcessEnv = {}) {
      const credentials = new TelegramCredentials(
        { secretsDir, envFile, gitignore, env },
        health,
      );
      credentials.onModuleInit();
      return credentials;
    }

    it('stores the token in .env, owner-only, and lists .env in .gitignore', () => {
      writeFileSync(envFile, '# Secrets\nOTHER=1\n', { mode: 0o600 });
      writeFileSync(gitignore, 'node_modules/\n');
      const credentials = inWorkspace();

      credentials.set(TOKEN);
      credentials.set(OTHER);

      expect(credentials.token()).toBe(OTHER);
      expect(credentials.source()).toBe('env-file');
      expect(readFileSync(envFile, 'utf8')).toBe(
        `# Secrets\nOTHER=1\nPERO_TELEGRAM_BOT_TOKEN=${OTHER}\n`,
      );
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(gitignore, 'utf8')).toBe('node_modules/\n.env\n');
      expect(readSecret(secretsDir, TELEGRAM_TOKEN_SECRET)).toBeNull();

      credentials.set(null);
      expect(readFileSync(envFile, 'utf8')).toBe('# Secrets\nOTHER=1\n');
      expect(credentials.token()).toBeNull();
    });

    it('reads .env on start, never the legacy secrets/', () => {
      writeSecret(secretsDir, TELEGRAM_TOKEN_SECRET, OTHER);
      expect(inWorkspace().token()).toBeNull();

      writeFileSync(envFile, `PERO_TELEGRAM_BOT_TOKEN="${TOKEN}"\n`, {
        mode: 0o600,
      });
      expect(inWorkspace().token()).toBe(TOKEN);
    });

    it('lets the environment win over .env', () => {
      writeFileSync(envFile, `PERO_TELEGRAM_BOT_TOKEN=${OTHER}\n`, {
        mode: 0o600,
      });
      const credentials = inWorkspace({ PERO_TELEGRAM_BOT_TOKEN: TOKEN });

      expect(credentials.token()).toBe(TOKEN);
      expect(credentials.source()).toBe('environment');
    });

    it('refuses a .env others can read, until it is owner-only again', () => {
      writeFileSync(envFile, `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
      chmodSync(envFile, 0o644);

      const credentials = inWorkspace();

      expect(credentials.token()).toBeNull();
      expect(credentials.source()).toBe('env-file');
      expect(telegram()).toMatchObject({
        state: 'degraded',
        detail: `${envFile} is readable by other users; run chmod 600 ${envFile}`,
      });

      // Storing it again writes the file owner-only.
      credentials.set(TOKEN);
      expect(credentials.token()).toBe(TOKEN);
    });
  });
});
