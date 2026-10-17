import { z } from 'zod';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  PROVIDERS,
  type Provider,
  type ProviderDefaults,
} from '../config/provider-options.js';
import {
  MAX_HISTORY_RETENTION_DAYS,
  timeZoneSchema,
} from '../config/settings-input.js';
import { INTEGRATION_KINDS } from '../persistence/entities/sql.js';
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../config/tool-policy.js';
import {
  cronSchema,
  MAX_HISTORY_HOURS,
  workflowMaxAttemptsSchema,
} from '../config/workflow-input.js';
import type { ParsedNote } from './note.js';
import { checkPropertyNames } from './properties.js';
import { DAYS, toCron } from './schedule.js';
import { fromZodIssues, type NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * The properties of `Pero.md`, Channel notes, and Workflow notes, as the
 * configuration reference describes them. A property left empty, as
 * Obsidian leaves one added without a value, counts as not set.
 */

export const DEFAULT_HISTORY_CARRYOVER = 50;

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/** The most Workflow runs `max-concurrent-runs` allows at once. */
export const MAX_CONCURRENT_RUNS_LIMIT = 10;

/** Any provider's effort level; a Channel's is checked against its provider. */
export const EFFORTS = [...new Set([...CLAUDE_EFFORTS, ...CODEX_EFFORTS])] as [
  string,
  ...string[],
];

/** Installation defaults, from `Pero.md` or, without one, Pero's own. */
export interface PeroNote {
  provider: Provider;
  /** Each provider's model and effort; null lets the provider choose. */
  providerDefaults: ProviderDefaults;
  permissions: PermissionMode;
  /** Null: the host's time zone. */
  timezone: string | null;
  historyCarryover: number;
  /** Null keeps all history. */
  historyRetentionDays: number | null;
  maxConcurrentRuns: number;
}

/** A Channel note's own settings; null takes the value from `Pero.md`. */
export interface ChannelNoteProperties {
  /**
   * The Channel it is for, as `<integration>:<address>`, such as
   * `telegram:-1001234567890:5`; null until Pero binds it.
   */
  channelId: string | null;
  provider: Provider | null;
  model: string | null;
  /** Any provider's level; not yet checked against the note's provider. */
  effort: string | null;
  permissions: PermissionMode | null;
  /** As written; null works in the workspace. */
  workingDirectory: string | null;
  skipGitRepoCheck: boolean;
  enabled: boolean;
  /** The body. */
  instructions: string | null;
}

/** A Channel note's name, `General`, `<chat title>/General`, or a Channel ID. */
export type ChannelRef = string | number;

/** Whose history a Workflow reads, unless it reads every Channel's. */
export interface HistoryChannels {
  /** The Channels its `channel` names; without one, `Default.md`'s. */
  current: boolean;
  /** Every Channel `Default.md` answers: General topics and direct chats. */
  default: boolean;
  /** Channels named as `channel` names them. */
  named: ChannelRef[];
}

export interface WorkflowNoteHistory {
  channels: 'all' | HistoryChannels;
  /** Null: since the previous successful run. */
  hours: number | null;
}

/** A Workflow note's settings. */
export interface WorkflowNote {
  /** Null: it runs only by hand. */
  schedule: { cron: string; timezone: string | null } | null;
  /** Where each run's answer is posted; the first gives its Channel note. */
  channels: ChannelRef[];
  /** Null: runs read no chat history. */
  history: WorkflowNoteHistory | null;
  maxAttempts: number;
  enabled: boolean;
  /**
   * The command each run runs first, through the shell; null runs none.
   * When it prints just `NO_DATA`, the run ends without a turn.
   */
  script: string | null;
  /** The body: what each run sends. */
  input: string;
}

export type NoteResult<T> =
  { ok: true; value: T } | { ok: false; errors: NoteError[] };

// Values, with messages that say what to write.

const bool = z.boolean({ error: 'must be true or false' });

const text = z
  .string({ error: 'must be text' })
  .trim()
  .min(1, 'must not be empty');

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: `must be ${listing(values)}` });
}

function wholeNumber(min: number, max?: number) {
  const message =
    max === undefined
      ? `must be a whole number, ${min} or more`
      : `must be a whole number from ${min} to ${max}`;
  const number = z.int({ error: message }).min(min, message);
  return max === undefined ? number : number.max(max, message);
}

/** One value or a list of them, as a list. */
function oneOrMore<T extends z.ZodType>(item: T, min = 0, message?: string) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z.array(item).min(min, message),
  );
}

const timeZone = z
  .string({ error: 'must be an IANA time zone such as Europe/Berlin' })
  .pipe(timeZoneSchema);

const CHANNEL_ID_EXPECTED = `must be <integration>:<address>, such as telegram:-1001234567890:5`;

/** A Channel's unique ID, `<integration>:<address>`. */
const channelId = z
  .string({ error: CHANNEL_ID_EXPECTED })
  .trim()
  .refine((value) => {
    const colon = value.indexOf(':');
    return (
      colon > 0 &&
      (INTEGRATION_KINDS as readonly string[]).includes(
        value.slice(0, colon),
      ) &&
      value.length > colon + 1 &&
      !/\s/.test(value)
    );
  }, CHANNEL_ID_EXPECTED);

/**
 * The Channel ID `value`, a `channel-id` property as YAML gives it, names;
 * null when it names none, as for a value of the wrong type.
 */
export function channelIdOf(value: unknown): string | null {
  const read = channelId.safeParse(value);
  return read.success ? read.data : null;
}

const CHANNEL_EXPECTED = 'must be a Channel note name or a Channel ID';

const channelRef = z.union([z.int().positive(CHANNEL_EXPECTED), text], {
  error: CHANNEL_EXPECTED,
});

/** Words `history-channels` takes besides Channels, in any case. */
const HISTORY_CHANNEL_KEYWORDS = ['all', 'current', 'default'] as const;

type HistoryChannelKeyword = (typeof HISTORY_CHANNEL_KEYWORDS)[number];

const HISTORY_CHANNEL_EXPECTED =
  'must be all, current, default, a Channel note name, or a Channel ID';

const historyChannelRef = z
  .union([z.int().positive(HISTORY_CHANNEL_EXPECTED), text], {
    error: HISTORY_CHANNEL_EXPECTED,
  })
  .transform((ref): ChannelRef | { keyword: HistoryChannelKeyword } => {
    const word = typeof ref === 'string' ? ref.toLowerCase() : null;
    return (HISTORY_CHANNEL_KEYWORDS as readonly (string | null)[]).includes(
      word,
    )
      ? { keyword: word as HistoryChannelKeyword }
      : ref;
  });

/** What `history-channels` names; it reads the Workflow's own by default. */
const historyChannels = oneOrMore(
  historyChannelRef,
  1,
  'must name at least one Channel; leave it out to read the current ones',
).transform((refs, ctx): 'all' | HistoryChannels => {
  const keywords = new Set(
    refs.flatMap((ref) => (typeof ref === 'object' ? [ref.keyword] : [])),
  );
  if (keywords.has('all')) {
    if (refs.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'all reads every Channel; leave the others out',
      });
      return z.NEVER;
    }
    return 'all';
  }
  return {
    current: keywords.has('current'),
    default: keywords.has('default'),
    named: refs.filter((ref) => typeof ref !== 'object'),
  };
});

/** What a Workflow reads without `history-channels`. */
const CURRENT_CHANNELS: HistoryChannels = {
  current: true,
  default: false,
  named: [],
};

const DAY_EXPECTED =
  'must be a weekday such as sunday, or daily, weekdays, or weekends';

const day = z
  .string({ error: DAY_EXPECTED })
  .trim()
  .toLowerCase()
  .transform((value, ctx) => {
    const days = DAYS[value];
    if (days === undefined) {
      ctx.addIssue({ code: 'custom', message: DAY_EXPECTED });
      return z.NEVER;
    }
    return days;
  });

// Every property, each optional; defaults are applied after checking.

const peroProperties = z
  .object({
    provider: oneOf(PROVIDERS),
    'claude-model': text,
    'codex-model': text,
    'claude-effort': oneOf(CLAUDE_EFFORTS),
    'codex-effort': oneOf(CODEX_EFFORTS),
    permissions: oneOf(PERMISSION_MODES),
    timezone: timeZone,
    'history-carryover': wholeNumber(0),
    'history-retention-days': wholeNumber(1, MAX_HISTORY_RETENTION_DAYS),
    'max-concurrent-runs': wholeNumber(1, MAX_CONCURRENT_RUNS_LIMIT),
  })
  .partial();

const channelProperties = z
  .object({
    'channel-id': channelId,
    provider: oneOf(PROVIDERS),
    model: text,
    effort: oneOf(EFFORTS),
    permissions: oneOf(PERMISSION_MODES),
    'working-directory': text.refine(
      (path) => !path.includes('\0'),
      'must not contain a NUL byte',
    ),
    'skip-git-repo-check': bool,
    enabled: bool,
  })
  .partial();

const workflowProperties = z
  .object({
    day: oneOrMore(day).transform((days) => days.flat()),
    hour: oneOrMore(wholeNumber(0, 23)),
    minute: wholeNumber(0, 59),
    cron: z.string({ error: 'must be a cron expression' }).pipe(cronSchema),
    timezone: timeZone,
    channel: oneOrMore(channelRef),
    history: bool,
    'history-channels': historyChannels,
    'history-hours': wholeNumber(1, MAX_HISTORY_HOURS),
    'max-attempts': workflowMaxAttemptsSchema,
    enabled: bool,
    script: text,
  })
  .partial();

/** Every property each kind of note takes, by name. */
export const NOTE_PROPERTIES = {
  pero: peroProperties.keyof().options,
  channel: channelProperties.keyof().options,
  workflow: workflowProperties.keyof().options,
} as const;

/** `Pero.md`'s settings, with Pero's defaults for those it leaves out. */
export function readPeroNote(
  file: string,
  note: ParsedNote,
): NoteResult<PeroNote> {
  const result = readProperties(file, note, peroProperties);
  if (note.body !== null) {
    const error = {
      file,
      property: null,
      message:
        'holds settings only: move its text to Instructions.md or ' +
        'Persona.md, which every Channel shares',
    };
    return {
      ok: false,
      errors: result.ok ? [error] : [...result.errors, error],
    };
  }
  if (!result.ok) return result;
  const p = result.value;
  return {
    ok: true,
    value: {
      provider: p.provider ?? 'claude',
      providerDefaults: {
        claude: {
          model: p['claude-model'] ?? null,
          effort: p['claude-effort'] ?? null,
        },
        codex: {
          model: p['codex-model'] ?? null,
          effort: p['codex-effort'] ?? null,
        },
      },
      permissions: p.permissions ?? 'ask',
      timezone: p.timezone ?? null,
      historyCarryover: p['history-carryover'] ?? DEFAULT_HISTORY_CARRYOVER,
      historyRetentionDays: p['history-retention-days'] ?? null,
      maxConcurrentRuns:
        p['max-concurrent-runs'] ?? DEFAULT_MAX_CONCURRENT_RUNS,
    },
  };
}

/** A Channel note's own settings. */
export function readChannelNote(
  file: string,
  note: ParsedNote,
): NoteResult<ChannelNoteProperties> {
  const result = readProperties(file, note, channelProperties);
  if (!result.ok) return result;
  const p = result.value;
  return {
    ok: true,
    value: {
      channelId: p['channel-id'] ?? null,
      provider: p.provider ?? null,
      model: p.model ?? null,
      effort: p.effort ?? null,
      permissions: p.permissions ?? null,
      workingDirectory: p['working-directory'] ?? null,
      skipGitRepoCheck: p['skip-git-repo-check'] ?? false,
      enabled: p.enabled ?? true,
      instructions: note.body,
    },
  };
}

/**
 * A Workflow note's settings. `day`, `hour`, and `minute` become a cron
 * expression.
 */
export function readWorkflowNote(
  file: string,
  note: ParsedNote,
): NoteResult<WorkflowNote> {
  const result = readProperties(file, note, workflowProperties);
  const errors = result.ok ? [] : result.errors;
  if (note.body === null) {
    errors.push({
      file,
      property: null,
      message: 'the note has no text: write what each run asks',
    });
  }
  if (!result.ok) return { ok: false, errors };

  const p = result.value;
  const error = (property: string, message: string) =>
    errors.push({ file, property, message });
  const timed =
    p.day !== undefined || p.hour !== undefined || p.minute !== undefined;
  if (p.cron !== undefined && timed) {
    error('cron', 'replaces day, hour, and minute; use one or the other');
  } else if (timed && p.hour === undefined) {
    error('hour', 'must be set when day or minute is');
  }
  if (errors.length > 0 || note.body === null) return { ok: false, errors };

  const cron =
    p.cron ??
    (p.hour === undefined
      ? null
      : toCron({
          days: p.day ?? DAYS.daily!,
          hours: p.hour,
          minute: p.minute ?? 0,
        }));
  return {
    ok: true,
    value: {
      schedule: cron === null ? null : { cron, timezone: p.timezone ?? null },
      channels: p.channel ?? [],
      history: p.history
        ? {
            channels: p['history-channels'] ?? CURRENT_CHANNELS,
            hours: p['history-hours'] ?? null,
          }
        : null,
      maxAttempts: p['max-attempts'] ?? 1,
      enabled: p.enabled ?? true,
      script: p.script ?? null,
      input: note.body,
    },
  };
}

/**
 * `Persona.md` or `Instructions.md`: text only, so any property but
 * Obsidian's own is an error. Its body; null for none.
 */
export function readTextNote(
  file: string,
  note: ParsedNote,
): NoteResult<string | null> {
  const result = readProperties(file, note, z.object({}));
  return result.ok ? { ok: true, value: note.body } : result;
}

/**
 * `note`'s properties checked against `schema`: every unknown property
 * and every invalid value is reported, not just the first.
 */
function readProperties<S extends z.ZodObject>(
  file: string,
  note: ParsedNote,
  schema: S,
): NoteResult<z.output<S>> {
  const set = Object.fromEntries(
    Object.entries(note.properties).filter(([, value]) => value !== null),
  );
  const { properties, errors } = checkPropertyNames(
    file,
    set,
    Object.keys(schema.shape),
  );
  const parsed = schema.safeParse(properties);
  if (!parsed.success) {
    errors.push(...fromZodIssues(file, parsed.error.issues, properties));
  }
  return parsed.success && errors.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, errors };
}

/** `a or b`, `a, b, or c`. */
export function listing(values: readonly string[]): string {
  if (values.length <= 2) return values.join(' or ');
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}
