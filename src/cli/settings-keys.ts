import { resolvePath } from '../config/bootstrap-config.js';
import type { Provider } from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import {
  type SettingsChange,
  TELEGRAM_TOKEN_ENV,
} from '../config/settings-input.js';
import type { SettingsView } from '../control/protocol.js';
import { CliError } from './errors.js';

/** Where relative folders and `~` resolve from. */
export interface PathContext {
  cwd: string;
  home: string;
}

/** One setting as `pero settings` names, changes, and shows it. */
export interface SettingsKey {
  name: string;
  /** A secret is never taken as an argument and never shown. */
  secret?: boolean;
  /** The change that sets `value`. */
  set(value: string, context: PathContext): SettingsChange;
  /** The change that clears it; a string explains why it cannot be. */
  unset: SettingsChange | string;
  show(view: SettingsView): string;
  /** Printed after a change: what it does and does not affect. */
  note?: string | ((view: SettingsView) => string | null);
}

const PROVIDER_DEFAULT = '(provider default)';

/** How much of the shared instructions `show` prints. */
const INSTRUCTIONS_PREVIEW = 60;

/** `value` as a count; a `CliError` names setting `name` otherwise. */
function wholeNumber(name: string, value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError(`${name} must be a whole number, not "${value}"`);
  }
  return Number(value);
}

/** `1 day` or `30 days`. */
function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

function providerOption(
  provider: Provider,
  option: 'model' | 'effort',
): SettingsKey {
  return {
    name: `${provider}.${option}`,
    set: (value) => ({ providerDefaults: { [provider]: { [option]: value } } }),
    unset: { providerDefaults: { [provider]: { [option]: null } } },
    show: (view) => view.providerDefaults[provider][option] ?? PROVIDER_DEFAULT,
  };
}

/** Every setting, in the order `pero settings show` lists them. */
export const SETTINGS_KEYS: readonly SettingsKey[] = [
  {
    name: 'default-provider',
    set: (value) => ({ defaultProvider: value as Provider }),
    unset: 'default-provider cannot be unset; choose claude or codex',
    show: (view) => view.defaultProvider,
  },
  providerOption('claude', 'model'),
  providerOption('claude', 'effort'),
  providerOption('codex', 'model'),
  providerOption('codex', 'effort'),
  {
    name: 'default-working-directory',
    set: (value, { cwd, home }) => ({
      defaultWorkingDirectory: resolvePath(value, cwd, home),
    }),
    unset:
      'default-working-directory cannot be unset; set another folder instead',
    show: (view) => view.defaultWorkingDirectory ?? '(not set)',
  },
  {
    name: 'shared-instructions',
    set: (value) => ({ sharedInstructions: value }),
    unset: { sharedInstructions: null },
    show: (view) => preview(view.sharedInstructions),
  },
  {
    name: 'main-agent',
    set: (value) => ({ mainAgent: value }),
    unset: { mainAgent: null },
    show: (view) => view.mainAgent ?? '(not set: main)',
    note:
      'It answers General topics and direct chats onboarded from now on; ' +
      'existing Channels keep their Agent.',
  },
  {
    name: 'history-carryover',
    set: (value) => ({
      historyCarryover: wholeNumber('history-carryover', value),
    }),
    unset: 'history-carryover cannot be unset; set 0 to turn it off',
    show: (view) =>
      view.historyCarryover === 0 ? '0 (off)' : String(view.historyCarryover),
  },
  {
    name: 'history-retention-days',
    set: (value) => ({
      historyRetentionDays: wholeNumber('history-retention-days', value),
    }),
    unset: { historyRetentionDays: null },
    show: (view) =>
      view.historyRetentionDays === null
        ? '(not set: keep all)'
        : days(view.historyRetentionDays),
    note: (view) =>
      view.historyRetentionDays === null
        ? 'All message history is kept from now on.'
        : `Messages older than ${days(view.historyRetentionDays)} are deleted within the hour, and every hour after; runs and Notifications keep their text.`,
  },
  {
    name: 'default-permissions',
    set: (value) => ({ defaultPermissions: value as PermissionMode }),
    unset: 'default-permissions cannot be unset; choose ask or bypass',
    show: (view) => view.defaultPermissions,
  },
  {
    name: 'timezone',
    set: (value) => ({ timezone: value }),
    unset: 'timezone cannot be unset; set an IANA time zone instead',
    show: (view) => view.timezone,
  },
  {
    name: 'max-concurrent-runs',
    set: (value) => ({
      maxConcurrentRuns: wholeNumber('max-concurrent-runs', value),
    }),
    unset: 'max-concurrent-runs cannot be unset; set a number instead',
    show: (view) => String(view.maxConcurrentRuns),
  },
  {
    name: 'telegram-bot-token',
    secret: true,
    set: (value) => ({ telegramBotToken: value }),
    unset: { telegramBotToken: null },
    show: ({ telegramBotToken: { set, source } }) => {
      const from =
        source === 'environment'
          ? TELEGRAM_TOKEN_ENV
          : source === 'env-file'
            ? '.env'
            : source;
      if (set) return `set (${from})`;
      return from ? `not valid (${from})` : 'not set';
    },
  },
];

/** The key named `name`; a `CliError` lists the valid names otherwise. */
export function findSettingsKey(name: string): SettingsKey {
  const key = SETTINGS_KEYS.find((candidate) => candidate.name === name);
  if (!key) {
    throw new CliError(
      `Unknown setting "${name}". Settings: ${SETTINGS_KEYS.map((k) => k.name).join(', ')}`,
    );
  }
  return key;
}

/**
 * The daemon names fields as it stores them (`defaultProvider: …`); a
 * message about one setting names it as the owner typed it.
 */
export function renameField(message: string, key: SettingsKey): string {
  return message.replace(/^[\w.]+: /, `${key.name}: `);
}

/** The first line of `text`, shortened, and how many lines it has. */
export function preview(text: string | null): string {
  if (text === null) return '(none)';
  const lines = text.split('\n');
  const first = lines[0]!.trim();
  const shown =
    first.length > INSTRUCTIONS_PREVIEW
      ? `${first.slice(0, INSTRUCTIONS_PREVIEW - 1)}…`
      : first;
  return lines.length > 1 ? `${shown} (${lines.length} lines)` : shown;
}
