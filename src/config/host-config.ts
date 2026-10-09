import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  type YAMLMap,
  stringify,
  type YAMLSeq,
} from 'yaml';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-file.js';
import { ConfigError, resolvePath } from './bootstrap-config.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * `config.yaml` holds what describes this installation and that a turn
 * must not change: where the data folder is, and which chats Pero serves.
 * It lives in the workspace's `.pero/`, where Claude's edits with `ask`
 * always ask, and is meant to be committed.
 */

/** The file's name inside the state directory. */
export const HOST_CONFIG_FILE = 'config.yaml';

/** The data folder of a workspace whose `config.yaml` names none. */
export const DEFAULT_DATA_FOLDER = 'data';

/** The system folder inside the data folder, unless `system` names one. */
export const SYSTEM_FOLDER = 'System';

/**
 * A Telegram chat ID: negative for a group, the user's ID for a direct
 * chat. Kept as a string, since it may exceed 2^53.
 */
export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,20}$/,
    'must be a Telegram chat ID, such as -1001234567890 or 123456789',
  );

/** Groups have negative Telegram IDs; people, positive ones. */
export function chatKindOf(chatKey: string): 'group' | 'private' {
  return chatKey.startsWith('-') ? 'group' : 'private';
}

/** A chat in `telegram.allowed-chats`. */
export interface HostAllowedChat {
  chatKey: string;
  /** The owner's own label; Pero doesn't use it to find the chat. */
  title: string | null;
}

/** What turns speech into text, or text into speech; `off` for nothing. */
export const SPEECH_ENGINES = ['local', 'elevenlabs', 'off'] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

/** `speech` in `config.yaml`: how Pero hears voice messages and speaks. */
export interface SpeechConfig {
  transcribe: {
    engine: SpeechEngine;
    /** The engine's model, a file for `local`; null for its default. */
    model: string | null;
    /** The spoken language, such as `en`; null to detect it. */
    language: string | null;
    /** Longer voice messages aren't transcribed. */
    maxMinutes: number;
    /** CPU time budget, separate from the recording's duration. */
    timeoutSeconds: number;
    convertTimeoutSeconds: number;
  };
  speak: {
    engine: SpeechEngine;
    /** The engine's voice, a file for `local`; null for its default. */
    voice: string | null;
    /** The engine's model; null for its default. */
    model: string | null;
  };
  /** The programs the `local` engine runs, by name or path. */
  programs: { ffmpeg: string; whisper: string; piper: string };
}

/** `speech` when `config.yaml` sets none of it. */
export const DEFAULT_SPEECH: SpeechConfig = {
  transcribe: {
    engine: 'local',
    model: null,
    language: null,
    maxMinutes: 60,
    timeoutSeconds: 3600,
    convertTimeoutSeconds: 300,
  },
  speak: { engine: 'local', voice: null, model: null },
  programs: { ffmpeg: 'ffmpeg', whisper: 'whisper-cli', piper: 'piper' },
};

/** File limits apply independently of Telegram's transport limits. */
export interface FilesConfig {
  maxMb: number;
  downloadTimeoutSeconds: number;
  uploadTimeoutSeconds: number;
  previews: boolean;
  telegramApiRoot: string | null;
  telegramLocalFileRoot: string | null;
}

export const DEFAULT_FILES: FilesConfig = {
  maxMb: 512,
  downloadTimeoutSeconds: 600,
  uploadTimeoutSeconds: 600,
  previews: true,
  telegramApiRoot: null,
  telegramLocalFileRoot: null,
};

/** `config.yaml` as Pero uses it. */
export interface HostConfig {
  /** `data` as written; null when the file doesn't set it. */
  data: string | null;
  /** `system` as written; null when the file doesn't set it. */
  system: string | null;
  allowedChats: HostAllowedChat[];
  speech: SpeechConfig;
  files: FilesConfig;
}

const EMPTY: HostConfig = {
  data: null,
  system: null,
  allowedChats: [],
  speech: DEFAULT_SPEECH,
  files: DEFAULT_FILES,
};

const folder = z
  .string({ error: 'must be a folder path' })
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), 'must not contain a NUL byte');

// YAML integers arrive as bigints, so large IDs keep every digit.
const chatId = z
  .union([z.bigint(), z.string()], {
    error: 'must be a Telegram chat ID, such as -1001234567890 or 123456789',
  })
  .transform(String)
  .pipe(telegramChatIdSchema);

const engine = z.enum(SPEECH_ENGINES, {
  error: `must be one of ${SPEECH_ENGINES.join(', ')}`,
});

const setting = z
  .string({ error: 'must be text' })
  .trim()
  .min(1, 'must not be empty');

const seconds = z
  .union([z.bigint(), z.number()])
  .transform(Number)
  .pipe(z.number().int().min(1).max(86400));
const apiRoot = setting.refine((value) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, 'must be an HTTP(S) API root without credentials, query or fragment');

const speech = z.strictObject({
  transcribe: z
    .strictObject({
      engine: engine.nullish(),
      model: setting.nullish(),
      language: setting.nullish(),
      'max-minutes': z
        .union([z.bigint(), z.number()], { error: 'must be a number' })
        .transform(Number)
        .pipe(
          z
            .number()
            .positive('must be more than 0')
            .max(240, 'must be at most 240'),
        )
        .nullish(),
      'timeout-seconds': seconds.nullish(),
      'convert-timeout-seconds': seconds.nullish(),
    })
    .nullish(),
  speak: z
    .strictObject({
      engine: engine.nullish(),
      voice: setting.nullish(),
      model: setting.nullish(),
    })
    .nullish(),
  programs: z
    .strictObject({
      ffmpeg: setting.nullish(),
      whisper: setting.nullish(),
      piper: setting.nullish(),
    })
    .nullish(),
});

const schema = z.strictObject({
  data: folder.nullish(),
  system: folder.nullish(),
  telegram: z
    .strictObject({
      'allowed-chats': z
        .array(
          z.strictObject({
            id: chatId,
            title: z.string({ error: 'must be text' }).nullish(),
          }),
          { error: 'must be a list of chats, each with an id' },
        )
        .nullish()
        .superRefine((chats, ctx) => {
          const seen = new Set<string>();
          chats?.forEach((chat, index) => {
            if (seen.has(chat.id)) {
              ctx.addIssue({
                code: 'custom',
                path: [index, 'id'],
                message: `${chat.id} is listed twice`,
              });
            }
            seen.add(chat.id);
          });
        }),
    })
    .nullish(),
  speech: speech.nullish(),
  files: z
    .strictObject({
      'max-mb': z
        .union([z.bigint(), z.number()])
        .transform(Number)
        .pipe(z.number().int().min(1).max(2000))
        .nullish(),
      'download-timeout-seconds': seconds.nullish(),
      'upload-timeout-seconds': seconds.nullish(),
      previews: z.boolean().nullish(),
      'telegram-api-root': apiRoot.nullish(),
      'telegram-local-file-root': folder.nullish(),
    })
    .nullish(),
});

const PARSE_OPTIONS = {
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  intAsBigInt: true,
  prettyErrors: false,
} as const;

/**
 * Parses `text`, the `config.yaml` at `file`. Throws a `ConfigError`
 * naming the file, the line, the key, and what is wrong.
 */
export function parseHostConfig(file: string, text: string): HostConfig {
  return check(file, parse(text)).config;
}

/** The `config.yaml` at `path`; null when there is none. */
export function readHostConfig(path: string): HostConfig | null {
  const text = readText(path);
  return text === null ? null : parseHostConfig(path, text);
}

/**
 * Changes the `config.yaml` at `path` with `edit`, keeping its comments,
 * ordering, and everything `edit` leaves alone, and returns the new
 * contents. The file is read again right before the change, so edits made
 * by hand meanwhile are kept, and replaced in one step. A missing file
 * starts from `template`. An invalid file is not changed: that throws.
 */
export function editHostConfig(
  path: string,
  edit: (document: Document) => void,
  template: () => string = () => defaultHostConfig(),
): HostConfig {
  const text = readText(path);
  const { document } = check(path, parse(text ?? template()));
  edit(document);
  const updated = document.toString();
  const { config } = check(path, parse(updated));
  writeFileAtomic(path, updated, text === null ? 0o644 : modeOf(path));
  return config;
}

/**
 * Adds chat `chatKey` to the allowed chats, with `title` as its label.
 * A chat already there keeps its entry, gaining a label if it had none.
 * False when nothing changed.
 */
export function allowChat(
  document: Document,
  chatKey: string,
  title: string | null,
): boolean {
  const chats = allowedChatsNode(document);
  const existing = chats.items.find(
    (item) => isMap(item) && idOf(item) === chatKey,
  ) as YAMLMap | undefined;
  if (existing) {
    if (title === null || existing.has('title')) return false;
    existing.set('title', title);
    return true;
  }
  chats.flow = false;
  const entry = document.createNode(
    title === null ? { id: BigInt(chatKey) } : { id: BigInt(chatKey), title },
  );
  chats.add(entry);
  return true;
}

/** Removes chat `chatKey` from the allowed chats; false when it wasn't there. */
/** The two directions of speech. */
export type SpeechDirection = 'transcribe' | 'speak';

/**
 * Sets `direction`'s engine in `speech`, creating the maps it needs. When
 * the engine changes, its `model` and `voice` go, since they name another
 * engine's files or voices. A `voice` given is set; null removes it.
 * True when anything changed.
 */
export function setSpeech(
  document: Document,
  direction: SpeechDirection,
  engine: SpeechEngine,
  voice?: string | null,
): boolean {
  const path = ['speech', direction];
  for (let depth = 1; depth <= path.length; depth++) {
    const at = path.slice(0, depth);
    // `speech:` with nothing after it is a null, not a map.
    if (!isMap(document.getIn(at, true))) {
      const map = document.createNode({}) as YAMLMap;
      map.flow = false;
      document.setIn(at, map);
    }
  }
  // A `speech` added to a file of its own sits apart from what is above.
  const items = isMap(document.contents) ? document.contents.items : [];
  const top = items.find(
    (pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === 'speech',
  );
  if (top !== undefined && top !== items[0]) {
    const key = isScalar(top.key) ? top.key : new Scalar('speech');
    key.spaceBefore = true;
    top.key = key;
  }
  let changed = false;
  if (document.getIn([...path, 'engine']) !== engine) {
    document.setIn([...path, 'engine'], engine);
    for (const key of ['model', 'voice']) document.deleteIn([...path, key]);
    changed = true;
  }
  if (voice !== undefined && document.getIn([...path, 'voice']) !== voice) {
    if (voice === null) document.deleteIn([...path, 'voice']);
    else document.setIn([...path, 'voice'], voice);
    changed = true;
  }
  return changed;
}

export function denyChat(document: Document, chatKey: string): boolean {
  const chats = document.getIn(['telegram', 'allowed-chats'], true);
  if (!isSeq(chats)) return false;
  const before = chats.items.length;
  chats.items = chats.items.filter(
    (item) => !(isMap(item) && idOf(item) === chatKey),
  );
  // An empty block list would print as a lone `[]` on the next line.
  if (chats.items.length === 0) chats.flow = true;
  return chats.items.length !== before;
}

/**
 * Follows chat `from` to its new ID `to`, as when a group turns on topics:
 * its entry gets the new ID, or goes when `to` is already allowed. False
 * when `from` wasn't allowed.
 */
export function moveChatId(
  document: Document,
  from: string,
  to: string,
): boolean {
  const chats = document.getIn(['telegram', 'allowed-chats'], true);
  if (!isSeq(chats)) return false;
  const entry = chats.items.find(
    (item) => isMap(item) && idOf(item) === from,
  ) as YAMLMap | undefined;
  if (!entry) return false;
  if (chats.items.some((item) => isMap(item) && idOf(item) === to)) {
    return denyChat(document, from);
  }
  const id = entry.get('id', true);
  if (isScalar(id)) id.value = BigInt(to);
  else entry.set('id', BigInt(to));
  return true;
}

/**
 * The commented `config.yaml` a new workspace starts with, its data folder
 * `data`, relative to the workspace.
 */
export function defaultHostConfig(data: string = DEFAULT_DATA_FOLDER): string {
  return [
    "# Pero's host settings: where the data folder is and which chats Pero",
    '# serves. Commit this file; the bot token belongs in .env, never here.',
    '',
    '# Data folder: the vault Pero keeps notes in. Relative to the workspace.',
    '# Changing it takes a restart.',
    `data: ${yamlScalar(data)}`,
    '',
    '# System folder. Relative to the workspace. Default: <data>/System',
    `# system: ${yamlScalar(`${data}/${SYSTEM_FOLDER}`)}`,
    '',
    'telegram:',
    '  # The chats Pero serves. Anyone who can post in an allowed group',
    '  # reaches Pero. Add one with pero telegram allow <chat-id>,',
    '  # or here:',
    '  #   - id: -1001234567890   # a group; negative',
    "  #     title: Home          # for you; Pero doesn't use it",
    '  #   - id: 123456789        # a direct chat: your user ID',
    '  allowed-chats: []',
    '',
    '# Voice messages: how Pero transcribes the ones you send and records',
    '# its own. Each engine is local (whisper.cpp, Piper, and ffmpeg on',
    '# this machine), elevenlabs, or off. pero speech configure sets them',
    '# up and changes them.',
    'speech:',
    '  transcribe:',
    '    engine: local',
    '  speak:',
    '    engine: local',
    '',
  ].join('\n');
}

/** `value` as a one-line YAML string, quoted when it must be. */
function yamlScalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

/**
 * The data folder `config` names, as an absolute path. A relative path is
 * taken from `workspace`. Without `data`, it is the workspace's `data/`.
 */
export function resolveDataFolder(
  config: Pick<HostConfig, 'data'>,
  workspace: string,
  home: string = homedir(),
): string {
  return resolvePath(config.data ?? DEFAULT_DATA_FOLDER, workspace, home);
}

/**
 * The system folder of `workspace` as an absolute path: the one
 * `config` names, relative to the workspace, or else `<data>/System`.
 */
export function resolveSystemFolder(
  config: Pick<HostConfig, 'data' | 'system'>,
  workspace: string,
  home: string = homedir(),
): string {
  if (config.system !== null) {
    return resolvePath(config.system, workspace, home);
  }
  return join(resolveDataFolder(config, workspace, home), SYSTEM_FOLDER);
}

/** `config.yaml` in state directory `stateDir`. */
export function hostConfigPath(stateDir: string): string {
  return join(stateDir, HOST_CONFIG_FILE);
}

interface Parsed {
  document: Document;
  lineCounter: LineCounter;
}

function parse(text: string): Parsed {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  return { document, lineCounter };
}

function check(
  file: string,
  { document, lineCounter }: Parsed,
): { document: Document; config: HostConfig } {
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    const lines = problems.map((problem) => {
      const { line } = lineCounter.linePos(problem.pos[0]);
      const message = problem.message.split('\n')[0]!.replace(/[.:]$/, '');
      return `  line ${line}: ${message}`;
    });
    throw new ConfigError(`Invalid ${file}:\n${lines.join('\n')}`);
  }

  const value: unknown = document.toJS() ?? {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `Invalid ${file}:\n  must be "key: value" lines, such as data: data`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues.flatMap((issue) => {
      const keys =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key])
          : [issue.path];
      return keys.map((path) => {
        const line = lineOf(document, lineCounter, path);
        const where = line === null ? '' : `line ${line}: `;
        const message =
          issue.code === 'unrecognized_keys' ? 'unknown key' : issue.message;
        return `  ${where}${keyPath(path)}: ${message}`;
      });
    });
    throw new ConfigError(`Invalid ${file}:\n${lines.join('\n')}`);
  }

  const { data, system, telegram, speech, files } = parsed.data;
  return {
    document,
    config: {
      ...EMPTY,
      data: data ?? null,
      system: system ?? null,
      allowedChats: (telegram?.['allowed-chats'] ?? []).map((chat) => ({
        chatKey: chat.id,
        title: chat.title ?? null,
      })),
      speech: speechConfig(speech),
      files: {
        maxMb: files?.['max-mb'] ?? DEFAULT_FILES.maxMb,
        downloadTimeoutSeconds:
          files?.['download-timeout-seconds'] ??
          DEFAULT_FILES.downloadTimeoutSeconds,
        uploadTimeoutSeconds:
          files?.['upload-timeout-seconds'] ??
          DEFAULT_FILES.uploadTimeoutSeconds,
        previews: files?.previews ?? DEFAULT_FILES.previews,
        telegramApiRoot:
          files?.['telegram-api-root']?.replace(/\/$/, '') ?? null,
        telegramLocalFileRoot: files?.['telegram-local-file-root'] ?? null,
      },
    },
  };
}

/** `speech` as parsed, with a default for each setting left out. */
function speechConfig(
  parsed: z.infer<typeof speech> | null | undefined,
): SpeechConfig {
  const { transcribe, speak, programs } = DEFAULT_SPEECH;
  return {
    transcribe: {
      engine: parsed?.transcribe?.engine ?? transcribe.engine,
      model: parsed?.transcribe?.model ?? transcribe.model,
      language: parsed?.transcribe?.language ?? transcribe.language,
      maxMinutes: parsed?.transcribe?.['max-minutes'] ?? transcribe.maxMinutes,
      timeoutSeconds:
        parsed?.transcribe?.['timeout-seconds'] ?? transcribe.timeoutSeconds,
      convertTimeoutSeconds:
        parsed?.transcribe?.['convert-timeout-seconds'] ??
        transcribe.convertTimeoutSeconds,
    },
    speak: {
      engine: parsed?.speak?.engine ?? speak.engine,
      voice: parsed?.speak?.voice ?? speak.voice,
      model: parsed?.speak?.model ?? speak.model,
    },
    programs: {
      ffmpeg: parsed?.programs?.ffmpeg ?? programs.ffmpeg,
      whisper: parsed?.programs?.whisper ?? programs.whisper,
      piper: parsed?.programs?.piper ?? programs.piper,
    },
  };
}

/** `telegram.allowed-chats (item 2).id`, counting items from 1. */
function keyPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === 'number'
        ? ` (item ${key + 1})`
        : `${index === 0 ? '' : '.'}${String(key)}`,
    )
    .join('')
    .replace(/\. \(/g, ' (');
}

/** The line of the node at `path`, counting from 1; null when unknown. */
function lineOf(
  document: Document,
  lineCounter: LineCounter,
  path: readonly PropertyKey[],
): number | null {
  for (let length = path.length; length > 0; length--) {
    const node = document.getIn(path.slice(0, length) as unknown[], true) as
      { range?: [number, number, number] } | undefined;
    const start = node?.range?.[0];
    if (start !== undefined) return lineCounter.linePos(start).line;
  }
  return null;
}

/** The allowed-chats list, created as a block list when missing. */
function allowedChatsNode(document: Document): YAMLSeq {
  if (!isMap(document.get('telegram', true))) {
    document.set('telegram', document.createNode({}));
  }
  const telegram = document.get('telegram', true) as YAMLMap;
  const existing: unknown = telegram.get('allowed-chats', true);
  if (isSeq(existing)) return existing;
  const chats = document.createNode([]) as YAMLSeq;
  telegram.set('allowed-chats', chats);
  return chats;
}

function idOf(entry: YAMLMap): string | null {
  const id: unknown = entry.get('id');
  return typeof id === 'bigint' || typeof id === 'string' ? String(id) : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}
