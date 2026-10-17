import { resolvePath } from '../config/bootstrap-config.js';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  type Effort,
  type Provider,
} from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import type { Schedule } from '../scheduler/schedule.js';
import { parseNote, type ParsedNote } from './note.js';
import {
  isIgnoredPath,
  NOTE_FOLDERS,
  type NoteIdentity,
  noteIdentity,
  PERO_NOTE,
} from './note-files.js';
import type { NoteFile } from './scan.js';
import { slugify } from '../config/slug.js';
import {
  channelIdOf,
  type ChannelNoteProperties,
  type ChannelRef,
  listing,
  type NoteResult,
  type PeroNote,
  readChannelNote,
  readPeroNote,
  readTextNote,
  readWorkflowNote,
  type WorkflowNote,
  type WorkflowNoteHistory,
} from './schemas.js';
import type { NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** Installation defaults, with the time zone settled. */
export interface Defaults extends Omit<PeroNote, 'timezone'> {
  timezone: string;
}

/**
 * The settings a Channel's turns and Workflow runs use: its note with
 * `Pero.md`'s defaults applied, or the defaults alone while it has none.
 */
export interface ChannelNote {
  /** Its file title as a slug, such as `health`: what Pero calls it. */
  name: string;
  /** Its file title, such as `Health`; the Channel's title without a note. */
  title: string;
  /** Its path inside the system folder; null while it has no note. */
  file: string | null;
  /** The Channel it is bound to; null until Pero binds it. */
  channelId: string | null;
  provider: Provider;
  /** Null lets the provider choose. */
  model: string | null;
  /** One of `provider`'s levels; null lets the provider choose. */
  effort: Effort | null;
  permissions: PermissionMode;
  /** The folder its turns work in, absolute: its own, or the workspace. */
  workingDirectory: string;
  /** Lets Codex work in a folder that is not a Git repository. */
  skipGitRepoCheck: boolean;
  enabled: boolean;
  /** Its note's body; null for none. */
  instructions: string | null;
  /** What the note itself sets, to tell its values from the defaults. */
  note: ChannelNoteProperties;
}

/** A Workflow as it runs. */
export interface Workflow {
  name: string;
  /** Its note's title. */
  title: string;
  file: string;
  /**
   * The name of the Channel note whose settings and instructions its runs
   * use: its first `channel`'s, or `Default.md`'s. Null when the first
   * `channel` is a Channel ID and no lookup was given to find its note.
   */
  note: string | null;
  /** When it runs by itself; null: it runs only by hand. */
  schedule: Schedule | null;
  /** Where each run's answer is posted, as the note names them. */
  channels: readonly ChannelRef[];
  /** The Channel history each run reads; null reads none. */
  history: WorkflowNoteHistory | null;
  /**
   * The Channels `channels` and `history-channels` name, by ID, once a
   * lookup found them; null without one.
   */
  resolved: ResolvedChannels | null;
  /** How many times a run of it may start in all. */
  maxAttempts: number;
  enabled: boolean;
  /** The command each run runs before its turn; null runs none. */
  script: string | null;
  /** What each run sends. */
  input: string;
}

/**
 * A Workflow whose note and Channels a lookup found, as it is wherever
 * Pero runs with a database.
 */
export type ResolvedWorkflow = Workflow & {
  note: string;
  resolved: ResolvedChannels;
};

/** Whether `workflow`'s note and Channels were found. */
export function isResolved(workflow: Workflow): workflow is ResolvedWorkflow {
  return workflow.note !== null && workflow.resolved !== null;
}

/** The Channels a Workflow's references name, by ID. */
export interface ResolvedChannels {
  /** Where each run's answer is posted, in the order `channel` names them. */
  targets: readonly number[];
  /**
   * Whose history runs read: `all`, or the Channels `history-channels`
   * names, `current` and `default` included, by ID.
   */
  history: 'all' | readonly number[];
}

/** Every setting from the notes, with references between them resolved. */
export interface SystemSnapshot {
  defaults: Defaults;
  /** `Persona.md`'s text, which every turn's instructions start with. */
  persona: string | null;
  /** `Instructions.md`'s text, which follows the persona. */
  instructions: string | null;
  /**
   * The properties the `Pero.md` in use sets, to tell its values from
   * Pero's own defaults.
   */
  peroProperties: ReadonlySet<string>;
  /** The Channel notes that loaded, by name. */
  channelNotes: ReadonlyMap<string, ChannelNote>;
  /** Channel IDs and the name of the note bound to each. */
  boundChannels: ReadonlyMap<string, string>;
  /**
   * Names of Channel notes left out, for errors or a name another note
   * has too, that no `channel-id` binds, with their files.
   */
  unloadedNames: ReadonlyMap<string, readonly string[]>;
  /**
   * Channel IDs that only notes left out are bound to, with their files:
   * that Channel is answered by none until they load.
   */
  unloadedChannels: ReadonlyMap<string, readonly string[]>;
  workflows: ReadonlyMap<string, Workflow>;
  /** Sorted by file. */
  errors: readonly NoteError[];
}

/** A Channel a reference in a Workflow names. */
export interface ResolvedChannel {
  id: number;
  /** `<integration>:<address>`, as a note's `channel-id` names it. */
  channelId: string;
  /** A General topic, a group without topics, or a direct chat. */
  primary: boolean;
  /** Its title; `General` for a primary Channel. */
  title: string;
}

export type TopicResolution =
  | { kind: 'ok'; channel: ResolvedChannel }
  /** Nothing matches. */
  | { kind: 'none' }
  /** Several match; `matches` names each as `<chat title>/General`. */
  | { kind: 'ambiguous'; matches: readonly string[] };

/** Finds the Channels Workflow references name, among those Pero has seen. */
export interface TopicLookup {
  /** A Channel ID, or `General` or `<chat title>/General`. */
  resolve(ref: ChannelRef): TopicResolution;
  /** The Channel with `channelId`, `<integration>:<address>`; null if unseen. */
  byChannelId(channelId: string): ResolvedChannel | null;
  /** The topics whose title, as a slug, is `name`. */
  topicsNamed(name: string): readonly ResolvedChannel[];
  /** Every primary Channel, which `Default.md` answers. */
  primaryChannels(): readonly ResolvedChannel[];
}

export interface SnapshotContext {
  /**
   * Absolute; where turns work unless their note says otherwise, and
   * where relative `working-directory` paths start from.
   */
  workspace: string;
  homeDir: string;
  /** For `Pero.md` without a `timezone`. */
  hostTimeZone: string;
  /** Without one, as in CI, Channel references are checked for syntax only. */
  topics?: TopicLookup;
}

/** The name of `Channels/Default.md`, which answers every primary Channel. */
export const DEFAULT_NOTE = 'default';

/** `Default.md`'s path in the system folder. */
export const DEFAULT_NOTE_FILE = `${NOTE_FOLDERS.channel}/Default.md`;

/** A Channel's ID as notes name it: `<integration>:<address>`. */
export function channelIdFor(kind: string, externalKey: string): string {
  return `${kind}:${externalKey}`;
}

/** The topic title that means a group's General topic. */
export const GENERAL_TOPIC = 'General';

const EFFORTS_BY_PROVIDER: Readonly<Record<Provider, readonly string[]>> = {
  claude: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
};

/** A note read as its kind; a note that didn't parse has no `note`. */
interface Read<T> {
  file: string;
  identity: NoteIdentity;
  note: ParsedNote | null;
  result: NoteResult<T>;
}

/** A note read as its kind, before references to other notes resolve. */
export type NoteRead =
  | { kind: 'pero'; read: Read<PeroNote> }
  | { kind: 'persona'; read: Read<string | null> }
  | { kind: 'instructions'; read: Read<string | null> }
  | { kind: 'channel'; read: Read<ChannelNoteProperties> }
  | { kind: 'workflow'; read: Read<WorkflowNote> };

/** A note for `buildSnapshot`. */
export interface SnapshotNote extends NoteFile {
  /**
   * An earlier version of the note that read without errors, used in its
   * place while `text` has errors; they are still reported.
   */
  fallback?: string;
}

/**
 * `text` read as the note at `file`, on its own: its identity, properties,
 * and values. `errors` lists every problem found without looking at other
 * notes; `note` is null when the file isn't a note Pero knows.
 */
export function readNote(
  file: string,
  text: string,
): { note: NoteRead | null; errors: NoteError[] } {
  const identified = noteIdentity(file);
  if (!identified.ok) return { note: null, errors: [identified.error] };
  const { identity } = identified;
  const parsed = parseNote(file, text);
  const note = parsed.ok ? parsed.note : null;
  const reading = <T>(
    reader: (file: string, note: ParsedNote) => NoteResult<T>,
  ): Read<T> => ({
    file,
    identity,
    note,
    result: parsed.ok ? reader(file, parsed.note) : parsed,
  });
  let read: NoteRead;
  switch (identity.kind) {
    case 'pero':
      read = { kind: 'pero', read: reading(readPeroNote) };
      break;
    case 'persona':
      read = { kind: 'persona', read: reading(readTextNote) };
      break;
    case 'instructions':
      read = { kind: 'instructions', read: reading(readTextNote) };
      break;
    case 'channel':
      read = { kind: 'channel', read: reading(readChannelNote) };
      if (
        identity.name === DEFAULT_NOTE &&
        read.read.result.ok &&
        read.read.result.value.channelId !== null
      ) {
        read.read.result = {
          ok: false,
          errors: [
            {
              file,
              property: 'channel-id',
              message:
                'must not be set: Default.md answers every General topic and direct chat',
            },
          ],
        };
      }
      break;
    case 'workflow':
      read = { kind: 'workflow', read: reading(readWorkflowNote) };
      break;
  }
  return {
    note: read,
    errors: read.read.result.ok ? [] : read.read.result.errors,
  };
}

/**
 * The snapshot `notes`, the system folder's notes, describe. A note that
 * doesn't parse or validate is left out along with only the notes that
 * depend on it, and every problem is listed in `errors` with its file and
 * property. A broken `Pero.md` leaves the defaults, not the Channel
 * notes, out.
 */
export function buildSnapshot(
  notes: readonly SnapshotNote[],
  context: SnapshotContext,
): SystemSnapshot {
  const errors: NoteError[] = [];
  const channelReads: Read<ChannelNoteProperties>[] = [];
  const workflowReads: Read<WorkflowNote>[] = [];
  let pero: Read<PeroNote> | null = null;
  let persona: string | null = null;
  let instructions: string | null = null;

  for (const { file, text, fallback } of notes) {
    if (isIgnoredPath(file)) continue;
    let { note, errors: found } = readNote(file, text);
    errors.push(...found);
    if (found.length > 0 && fallback !== undefined) {
      const previous = readNote(file, fallback);
      if (previous.errors.length === 0) note = previous.note;
    }
    switch (note?.kind) {
      case 'pero':
        pero = note.read;
        break;
      case 'persona':
        if (note.read.result.ok) persona = note.read.result.value;
        break;
      case 'instructions':
        if (note.read.result.ok) instructions = note.read.result.value;
        break;
      case 'channel':
        channelReads.push(note.read);
        break;
      case 'workflow':
        workflowReads.push(note.read);
        break;
    }
  }

  const peroNote = pero?.result.ok ? pero.result.value : defaultPeroNote();
  const peroProperties = new Set(
    pero?.result.ok
      ? Object.entries(pero.note?.properties ?? {})
          .filter(([, value]) => value !== null)
          .map(([key]) => key)
      : [],
  );
  const { timezone, ...peroDefaults } = peroNote;
  const defaults: Defaults = {
    ...peroDefaults,
    timezone: timezone ?? context.hostTimeZone,
  };

  // Channel notes.
  const loaded: ChannelNote[] = [];
  for (const read of withUniqueNames(channelReads, errors, new Set())) {
    if (!read.result.ok) continue;
    const note = defineChannelNote(read, read.result.value, defaults, context);
    if ('error' in note) {
      errors.push({ file: read.file, ...note.error });
      continue;
    }
    loaded.push(note);
  }
  const channelNotes = new Map<string, ChannelNote>();
  const boundChannels = new Map<string, string>();
  for (const [channelId, bound] of groupBy(
    loaded.filter((note) => note.channelId !== null),
    (note) => note.channelId!,
  )) {
    if (bound.length === 1) {
      boundChannels.set(channelId, bound[0]!.name);
      continue;
    }
    for (const note of bound) {
      const others = bound
        .filter((other) => other !== note)
        .map((other) => other.file!);
      errors.push({
        file: note.file!,
        property: 'channel-id',
        message: `${channelId} is also the channel-id of ${listing(others)}; keep it in only one of them`,
      });
    }
  }
  for (const note of loaded) {
    if (note.channelId !== null && !boundChannels.has(note.channelId)) continue;
    channelNotes.set(note.name, note);
  }

  // Notes left out: whom a Channel would have been answered by.
  const unloadedNames = new Map<string, string[]>();
  const unloadedChannels = new Map<string, string[]>();
  for (const read of channelReads) {
    if (channelNotes.get(read.identity.name)?.file === read.file) continue;
    const channelId = channelIdOf(read.note?.properties['channel-id']);
    if (channelId !== null && boundChannels.has(channelId)) continue;
    const add = (map: Map<string, string[]>, key: string) => {
      const files = map.get(key) ?? [];
      if (!files.includes(read.file)) files.push(read.file);
      map.set(key, files);
    };
    if (channelId !== null) add(unloadedChannels, channelId);
    else if (!channelNotes.has(read.identity.name)) {
      add(unloadedNames, read.identity.name);
    }
  }

  // Workflows.
  const resolver = new WorkflowResolver(
    channelNotes,
    boundChannels,
    unloadedNames,
    unloadedChannels,
    context.topics,
  );
  const workflows = new Map<string, Workflow>();
  for (const read of withUniqueNames(workflowReads, errors, new Set())) {
    if (!read.result.ok) continue;
    const workflow = resolver.define(read, read.result.value, defaults);
    if (Array.isArray(workflow)) {
      errors.push(...workflow);
      continue;
    }
    workflows.set(workflow.name, workflow);
  }

  return Object.freeze({
    defaults: Object.freeze(defaults),
    persona,
    instructions,
    peroProperties,
    channelNotes,
    boundChannels,
    unloadedNames,
    unloadedChannels,
    workflows,
    // Stable, so each file's errors keep the order they were found in.
    errors: Object.freeze(errors.sort((a, b) => compare(a.file, b.file))),
  });
}

function defaultPeroNote(): PeroNote {
  const result = readPeroNote(PERO_NOTE, { properties: {}, body: null });
  if (!result.ok) throw new Error('Pero.md defaults do not validate');
  return result.value;
}

/**
 * `reads` without the notes whose name another note of their kind also
 * has; each of those gets an error naming the others, and the name goes
 * in `duplicated`.
 */
function withUniqueNames<T>(
  reads: readonly Read<T>[],
  errors: NoteError[],
  duplicated: Set<string>,
): Read<T>[] {
  const unique: Read<T>[] = [];
  for (const [name, named] of groupBy(reads, (read) => read.identity.name)) {
    if (named.length === 1) {
      unique.push(named[0]!);
      continue;
    }
    duplicated.add(name);
    for (const read of named) {
      const others = named
        .filter((other) => other !== read)
        .map((other) => other.file);
      errors.push({
        file: read.file,
        property: null,
        message: `has the same name, ${name}, as ${listing(others)}; rename one of them`,
      });
    }
  }
  return unique;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** The Channel note `read` describes, or why it can't be used. */
function defineChannelNote(
  read: Read<ChannelNoteProperties>,
  note: ChannelNoteProperties,
  defaults: Defaults,
  context: Pick<SnapshotContext, 'workspace' | 'homeDir'>,
): ChannelNote | { error: Omit<NoteError, 'file'> } {
  const provider = note.provider ?? defaults.provider;
  const efforts = EFFORTS_BY_PROVIDER[provider];
  if (note.effort !== null && !efforts.includes(note.effort)) {
    return {
      error: {
        property: 'effort',
        message: `must be ${listing(efforts)} for ${provider}`,
      },
    };
  }
  const own = defaults.providerDefaults[provider];
  return {
    name: read.identity.name,
    title: read.identity.title,
    file: read.file,
    channelId: note.channelId,
    provider,
    model: note.model ?? own.model,
    // Checked above against the provider.
    effort: (note.effort as Effort | null) ?? own.effort,
    permissions: note.permissions ?? defaults.permissions,
    workingDirectory:
      note.workingDirectory === null
        ? context.workspace
        : resolvePath(
            note.workingDirectory,
            context.workspace,
            context.homeDir,
          ),
    skipGitRepoCheck: note.skipGitRepoCheck,
    enabled: note.enabled,
    instructions: note.instructions,
    note,
  };
}

/** What a note without properties sets: nothing. */
const UNSET: ChannelNoteProperties = Object.freeze({
  channelId: null,
  provider: null,
  model: null,
  effort: null,
  permissions: null,
  workingDirectory: null,
  skipGitRepoCheck: false,
  enabled: true,
  instructions: null,
});

/**
 * The settings of a Channel titled `title` that has no note yet, named
 * `name`: `Pero.md`'s defaults, working in the workspace, with no
 * instructions of its own.
 */
export function defaultsNote(
  name: string,
  title: string,
  defaults: Defaults,
  workspace: string,
): ChannelNote {
  const own = defaults.providerDefaults[defaults.provider];
  return {
    name,
    title,
    file: null,
    channelId: null,
    provider: defaults.provider,
    model: own.model,
    effort: own.effort,
    permissions: defaults.permissions,
    workingDirectory: workspace,
    skipGitRepoCheck: false,
    enabled: true,
    instructions: null,
    note: UNSET,
  };
}

/** A Channel, as matching it to its note sees it. */
export interface NoteQuery {
  /** `<integration>:<address>`. */
  channelId: string;
  /** A General topic, a group without topics, or a direct chat. */
  primary: boolean;
  /** The topic's title; null while Pero hasn't seen it. */
  title: string | null;
}

/** Which note a Channel uses. */
export type NoteMatch =
  /** Its own note, or `Default.md` for a primary Channel. */
  | { kind: 'note'; note: ChannelNote }
  /** A note with its title and no `channel-id` yet: Pero binds it. */
  | { kind: 'bindable'; note: ChannelNote }
  /** Only notes left out for errors, in `files`, are for it. */
  | { kind: 'unloaded'; files: readonly string[] }
  /** A topic whose title Pero hasn't seen, so no note can match it yet. */
  | { kind: 'untitled' }
  /** No note: Pero writes one; `name` is the note's or the title's name. */
  | { kind: 'none'; name: string | null };

/**
 * The note Channel `query` uses in `snapshot`: `Default.md` for a primary
 * Channel; otherwise the note bound to it by `channel-id`, or else an
 * unbound note whose name is its title's.
 */
export function noteFor(
  snapshot: Pick<
    SystemSnapshot,
    'channelNotes' | 'boundChannels' | 'unloadedNames' | 'unloadedChannels'
  >,
  query: NoteQuery,
): NoteMatch {
  if (query.primary) {
    const note = snapshot.channelNotes.get(DEFAULT_NOTE);
    if (note !== undefined) return { kind: 'note', note };
    const files = snapshot.unloadedNames.get(DEFAULT_NOTE);
    if (files !== undefined) return { kind: 'unloaded', files };
    return { kind: 'none', name: DEFAULT_NOTE };
  }
  const bound = snapshot.boundChannels.get(query.channelId);
  if (bound !== undefined) {
    return { kind: 'note', note: snapshot.channelNotes.get(bound)! };
  }
  const left = snapshot.unloadedChannels.get(query.channelId);
  if (left !== undefined) return { kind: 'unloaded', files: left };
  const title = query.title?.trim() ?? '';
  if (title === '') return { kind: 'untitled' };
  const name = slugify(title);
  if (name === null || name === DEFAULT_NOTE) return { kind: 'none', name };
  const named = snapshot.channelNotes.get(name);
  if (named !== undefined && named.channelId === null) {
    return { kind: 'bindable', note: named };
  }
  const files = snapshot.unloadedNames.get(name);
  if (named === undefined && files !== undefined) {
    return { kind: 'unloaded', files };
  }
  return { kind: 'none', name };
}

/** Resolves what Workflow notes refer to: Channel notes and Channels. */
class WorkflowResolver {
  constructor(
    private readonly notes: ReadonlyMap<string, ChannelNote>,
    private readonly boundChannels: ReadonlyMap<string, string>,
    private readonly unloadedNames: ReadonlyMap<string, readonly string[]>,
    private readonly unloadedChannels: ReadonlyMap<string, readonly string[]>,
    private readonly topics: TopicLookup | undefined,
  ) {}

  /** The Workflow `read` describes, or the errors that leave it out. */
  define(
    read: Read<WorkflowNote>,
    note: WorkflowNote,
    defaults: Defaults,
  ): Workflow | NoteError[] {
    const errors: NoteError[] = [];
    const error = (property: string, message: string) =>
      errors.push({ file: read.file, property, message });

    const channels = note.channels.map((ref) => this.check(ref));
    for (const problem of channels) {
      if (typeof problem === 'string') error('channel', problem);
    }
    const historyChannels = note.history?.channels;
    const history =
      historyChannels === undefined || historyChannels === 'all'
        ? 'all'
        : historyChannels.named.map((ref) => this.check(ref));
    if (history !== 'all') {
      for (const problem of history) {
        if (typeof problem === 'string') error('history-channels', problem);
      }
    }
    if (errors.length > 0) return errors;

    const refs = channels as ResolvedRef[];
    const first = refs[0];
    const noteName = first === undefined ? DEFAULT_NOTE : this.noteOf(first);
    if (typeof noteName === 'object' && noteName !== null) {
      error(
        'channel',
        `the note for "${String(note.channels[0])}", ${brokenNotes(noteName.files)}`,
      );
      return errors;
    }
    const ids = (resolved: readonly ResolvedRef[]) =>
      unique(
        resolved.flatMap((ref) =>
          ref.channel === undefined ? [] : [ref.channel.id],
        ),
      );
    const historyIds = (topics: TopicLookup): number[] => {
      if (historyChannels === undefined || historyChannels === 'all') return [];
      // A Workflow without `channel` runs with Default.md, so its own
      // Channels are Default.md's.
      const current = historyChannels.current && refs.length > 0;
      const primary =
        historyChannels.default ||
        (historyChannels.current && refs.length === 0);
      return unique([
        ...ids(history as ResolvedRef[]),
        ...(current ? ids(refs) : []),
        ...(primary ? topics.primaryChannels().map(({ id }) => id) : []),
      ]).sort((a, b) => a - b);
    };

    return {
      name: read.identity.name,
      title: read.identity.title,
      file: read.file,
      note: noteName,
      schedule:
        note.schedule === null
          ? null
          : {
              cron: note.schedule.cron,
              timezone: note.schedule.timezone ?? defaults.timezone,
            },
      channels: note.channels,
      history: note.history,
      resolved:
        this.topics === undefined
          ? null
          : {
              targets: ids(refs),
              history: history === 'all' ? 'all' : historyIds(this.topics),
            },
      maxAttempts: note.maxAttempts,
      enabled: note.enabled,
      script: note.script,
      input: note.input,
    };
  }

  /** What `ref` names, or why it names nothing. */
  private check(ref: ChannelRef): ResolvedRef | string {
    if (typeof ref === 'number' || isGeneral(ref)) {
      if (this.topics === undefined) {
        return typeof ref === 'number' ? { kind: 'id' } : { kind: 'general' };
      }
      const found = this.topics.resolve(ref);
      switch (found.kind) {
        case 'ok':
          return typeof ref === 'number'
            ? { kind: 'id', channel: found.channel }
            : { kind: 'general', channel: found.channel };
        case 'none':
          return typeof ref === 'number'
            ? `no Channel has the ID ${ref}`
            : `no General topic${ref.includes('/') ? ` in "${ref.slice(0, ref.indexOf('/')).trim()}"` : ''} Pero has seen yet; write something there first`;
        case 'ambiguous':
          return `"${ref}" matches ${found.matches.length} General topics: ${found.matches.join(', ')}; write <chat title>/General`;
      }
    }
    const name = slugify(ref);
    const note = name === null ? undefined : this.notes.get(name);
    if (name === DEFAULT_NOTE) {
      return `"${ref}" answers every General topic and direct chat; write General, <chat title>/General, or a Channel ID`;
    }
    if (note === undefined) {
      const files = name === null ? undefined : this.unloadedNames.get(name);
      if (files !== undefined) return brokenNotes(files);
      const names = [...this.notes.values()]
        .filter((other) => other.name !== DEFAULT_NOTE)
        .map((other) => other.title)
        .sort(compare);
      return `no Channel note named "${ref}"; Channel notes: ${names.join(', ') || 'none yet'}`;
    }
    if (this.topics === undefined) return { kind: 'note', note: note.name };
    if (note.channelId === null) {
      // The topic the note binds to once someone writes there.
      const topics = this.topics
        .topicsNamed(note.name)
        .filter((topic) => !this.boundChannels.has(topic.channelId));
      if (topics.length === 1) {
        return { kind: 'note', note: note.name, channel: topics[0]! };
      }
      return topics.length === 0
        ? `Pero hasn't seen a topic titled "${note.title}" for ${note.file}; write something there first`
        : `${topics.length} topics are titled "${note.title}"; write something in the one ${note.file} is for, and Pero binds the note to it`;
    }
    const channel = this.topics.byChannelId(note.channelId);
    if (channel === null) {
      return `Pero hasn't seen the Channel ${note.channelId} of ${note.file}; write something there first`;
    }
    return { kind: 'note', note: note.name, channel };
  }

  /**
   * The name of the note `ref`'s Channel uses: `Default.md` in a primary
   * Channel; null for a Channel ID while there is no lookup.
   */
  private noteOf(
    ref: ResolvedRef,
  ): string | null | { files: readonly string[] } {
    switch (ref.kind) {
      case 'note':
        return ref.note;
      case 'general':
        return DEFAULT_NOTE;
      case 'id': {
        const channel = ref.channel;
        if (channel === undefined) return null;
        const match = noteFor(
          {
            channelNotes: this.notes,
            boundChannels: this.boundChannels,
            unloadedNames: this.unloadedNames,
            unloadedChannels: this.unloadedChannels,
          },
          {
            channelId: channel.channelId,
            primary: channel.primary,
            title: channel.title,
          },
        );
        switch (match.kind) {
          case 'note':
          case 'bindable':
            return match.note.name;
          case 'unloaded':
            return { files: match.files };
          case 'untitled':
            return `channel-${channel.id}`;
          case 'none':
            return match.name ?? `channel-${channel.id}`;
        }
      }
    }
  }
}

/** Whether `ref` names a group's General topic: `General`, `<chat>/General`. */
function isGeneral(ref: string): boolean {
  const slash = ref.lastIndexOf('/');
  const title = slash === -1 ? ref : ref.slice(slash + 1);
  return title.trim().toLowerCase() === GENERAL_TOPIC.toLowerCase();
}

type ResolvedRef =
  | { kind: 'note'; note: string; channel?: ResolvedChannel }
  | { kind: 'general'; channel?: ResolvedChannel }
  | { kind: 'id'; channel?: ResolvedChannel };

/** `the note a has errors`, or `the notes a and b have errors`. */
function brokenNotes(files: readonly string[]): string {
  const and =
    files.length <= 2
      ? files.join(' and ')
      : `${files.slice(0, -1).join(', ')}, and ${files.at(-1)}`;
  return files.length === 1
    ? `the note ${and} has errors`
    : `the notes ${and} have errors`;
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
