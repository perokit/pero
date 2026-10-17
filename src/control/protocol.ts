import type { Socket } from 'node:net';
import { z } from 'zod';
import {
  PROVIDERS,
  providerDefaultsSchema,
} from '../config/provider-options.js';
import { telegramChatIdSchema } from '../config/host-config.js';
import { telegramBotTokenSchema } from '../config/settings-input.js';
import { topicNameSchema } from '../telegram/topic-input.js';
import { PERMISSION_MODES } from '../config/tool-policy.js';
import { VALUE_ORIGINS } from '../system-files/origins.js';
import { workflowReferenceSchema } from '../config/workflow-input.js';
import {
  CHAT_KINDS,
  INTEGRATION_KINDS,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  NOTIFICATION_STATUSES,
  RUN_STATUSES,
} from '../persistence/entities/sql.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * The control endpoint is a Unix socket in `run/`. Each connection carries
 * one request: the client writes one JSON line, the daemon answers with one
 * JSON line and closes the connection.
 */

/** Upper bound on one request or response line. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const COMPONENT_STATES = ['unconfigured', 'degraded', 'ok'] as const;

export type ComponentState = (typeof COMPONENT_STATES)[number];

export const componentStatusSchema = z.object({
  name: z.string(),
  state: z.enum(COMPONENT_STATES),
  /** What is missing or failing; null when there is nothing to say. */
  detail: z.string().nullable(),
  /** When the component entered its current state. */
  since: z.iso.datetime(),
  /**
   * Whether health depends on it; a provider no Channel note uses is listed but
   * not required. Older daemons send no flag and require everything.
   */
  required: z.boolean().default(true),
});

export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const statusResultSchema = z.object({
  pid: z.int().positive(),
  version: z.string(),
  workspace: z.string(),
  /** The state directory, `<workspace>/.pero`. */
  stateDir: z.string(),
  /** When the daemon became ready. */
  startedAt: z.iso.datetime(),
  uptimeMs: z.int().nonnegative(),
  /** `degraded` when any component is not `ok`. */
  health: z.enum(['ok', 'degraded']),
  components: z.array(componentStatusSchema),
});

export type StatusResult = z.infer<typeof statusResultSchema>;

/** Where the bot token comes from: the daemon's environment, or `.env`. */
export const TOKEN_SOURCES = ['environment', 'env-file'] as const;

export type TokenSource = (typeof TOKEN_SOURCES)[number];

/** Whether the bot token is set, and where it comes from; never the token. */
export const tokenViewSchema = z.object({
  set: z.boolean(),
  /**
   * The environment variable whenever it is set, otherwise `.env`; null
   * when neither has one.
   */
  source: z.enum(TOKEN_SOURCES).nullable(),
});

export type TokenView = z.infer<typeof tokenViewSchema>;

/** Installation settings as the CLI sees them; secrets only as set or not. */
export const settingsViewSchema = z.object({
  defaultProvider: z.enum(PROVIDERS),
  providerDefaults: providerDefaultsSchema,
  /** The owner's notes and files, which every turn's instructions name. */
  dataFolder: z.string(),
  historyCarryover: z.int(),
  /** Days of message history kept; null keeps all of it. */
  historyRetentionDays: z.int().nullable(),
  defaultPermissions: z.enum(PERMISSION_MODES),
  timezone: z.string(),
  maxConcurrentRuns: z.int(),
  telegramBotToken: tokenViewSchema,
  /**
   * Where the settings are: `Pero.md` and `config.yaml`, relative to the
   * workspace when inside it.
   */
  files: z.object({ pero: z.string(), config: z.string() }),
  /**
   * The properties `Pero.md` sets; the others are Pero's own defaults.
   * Null until the notes are read.
   */
  setInPero: z.array(z.string()).nullable(),
});

export type SettingsView = z.infer<typeof settingsViewSchema>;

export const backupResultSchema = z.object({
  /** Absolute path of the written archive. */
  file: z.string(),
  createdAt: z.iso.datetime(),
  bytes: z.int().nonnegative(),
  /** Whether it holds the data folder. */
  includesData: z.boolean(),
});

export type BackupResult = z.infer<typeof backupResultSchema>;

export { telegramChatIdSchema };

export const BOT_MEMBERSHIPS = [
  'administrator',
  'member',
  'left',
  'unknown',
] as const;

/** A chat Pero serves, with the bot's standing there as last checked. */
export const allowedChatSchema = z.object({
  chatId: z.string(),
  kind: z.enum(CHAT_KINDS),
  title: z.string().nullable(),
  /** The bot's membership in a group; null for a direct chat or unchecked. */
  bot: z.enum(BOT_MEMBERSHIPS).nullable(),
  /** Whether a group has topics; null for a direct chat or unknown. */
  topics: z.boolean().nullable(),
  /** Why the bot cannot see every message there; null when it can. */
  problem: z.string().nullable(),
  /**
   * Why the group is unsafe to serve: it is public, so anyone can join
   * and talk to Pero. Null when it is not, or from an older daemon.
   */
  danger: z.string().nullable().default(null),
  /** When a daemon from before `config.yaml` recorded the allowing. */
  allowedAt: z.iso.datetime().optional(),
});

export type AllowedChatView = z.infer<typeof allowedChatSchema>;

/** A chat that is not allowed and has tried to reach Pero. */
export const pairingRequestSchema = z.object({
  chatId: z.string(),
  kind: z.enum(CHAT_KINDS),
  title: z.string().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});

export type PairingRequestView = z.infer<typeof pairingRequestSchema>;

export const telegramChatsSchema = z.object({
  /** The bot's username while connected; null otherwise. */
  bot: z.string().nullable(),
  /** Oldest first. */
  allowed: z.array(allowedChatSchema),
  /** Chats that asked to pair since the daemon started, latest first. */
  pairing: z.array(pairingRequestSchema),
});

export type TelegramChats = z.infer<typeof telegramChatsSchema>;

/** The settings a Channel's turns use, from its note, as the CLI sees them. */
export const channelNoteSchema = z.object({
  /** Its file title as a slug; for a Channel without a note, its title's. */
  name: z.string(),
  title: z.string(),
  /** The note, relative to the workspace when inside it; null for none yet. */
  file: z.string().nullable(),
  /** The Channel it is bound to by `channel-id`; null for none yet. */
  channelId: z.string().nullable(),
  provider: z.enum(PROVIDERS),
  /** Null: the provider's default. */
  model: z.string().nullable(),
  /** Null: the provider's default. */
  effort: z.string().nullable(),
  /** The note's own folder; null when it follows the default. */
  workingDirectory: z.string().nullable(),
  /** The folder its turns run in. */
  effectiveWorkingDirectory: z.string(),
  /** The note's own instructions; null means none. */
  instructions: z.string().nullable(),
  permissions: z.enum(PERMISSION_MODES),
  /** Codex only: whether it may work in a folder outside a Git repository. */
  skipGitRepoCheck: z.boolean(),
  enabled: z.boolean(),
  /** Where its values come from: the note, `Pero.md`, or Pero's defaults. */
  origins: z.object({
    provider: z.enum(VALUE_ORIGINS),
    model: z.enum(VALUE_ORIGINS),
    effort: z.enum(VALUE_ORIGINS),
    permissions: z.enum(VALUE_ORIGINS),
    workingDirectory: z.enum(['note', 'workspace']),
  }),
  /** Its note's errors, while its last good version stays in use. */
  errors: z.array(
    z.object({ property: z.string().nullable(), message: z.string() }),
  ),
});

export type ChannelNoteView = z.infer<typeof channelNoteSchema>;

/**
 * What a Channel's next turn does: `new` starts its first
 * Session; `resume` continues the active one; `restart` keeps the active
 * Session, whose first turn never reached the provider, and starts the
 * provider session again; `fresh` closes it for a new one, because the
 * provider or folder changed.
 */
export const NEXT_TURN_KINDS = ['new', 'resume', 'restart', 'fresh'] as const;

export const nextTurnSchema = z.object({
  kind: z.enum(NEXT_TURN_KINDS),
  /** For `fresh`: what changed since the Session began. */
  reason: z.enum(['provider', 'folder']).nullable(),
  /** For `fresh`: the provider or folder the Session began with. */
  from: z.string().nullable(),
  /** The active Session; null when there is none. */
  sessionId: z.int().nullable(),
  /** Whether the turn starts with the Channel's recent messages. */
  carriesOver: z.boolean(),
});

export type NextTurn = z.infer<typeof nextTurnSchema>;

/** A Channel as `pero channels ls` lists it. */
export const channelViewSchema = z.object({
  id: z.int(),
  integrationKind: z.enum(INTEGRATION_KINDS),
  /** The integration's address, such as `<chat_id>:<topic_id>`. */
  key: z.string(),
  title: z.string().nullable(),
  /**
   * The note Pero answers there with, relative to the workspace when
   * inside it, matched on each message; null while it has none.
   */
  note: z.string().nullable(),
  /** Why Pero doesn't answer there now; null when it does. */
  unanswered: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type ChannelView = z.infer<typeof channelViewSchema>;

/** A Channel note no Channel Pero has seen uses yet. */
export const unusedNoteSchema = z.object({
  file: z.string(),
  /** Its `channel-id`; null until Pero binds it. */
  channelId: z.string().nullable(),
});

export type UnusedNoteView = z.infer<typeof unusedNoteSchema>;

export const channelDetailsSchema = channelViewSchema.extend({
  /** The settings its turns use; null when Pero doesn't answer there. */
  settings: channelNoteSchema.nullable(),
  /** Why its folder cannot be used now; null when it can. */
  folderProblem: z.string().nullable(),
  /**
   * What the next turn does with its Session; null when Pero doesn't
   * answer there.
   */
  nextTurn: nextTurnSchema.nullable(),
  /** How many messages its history holds. */
  messages: z.int().nonnegative(),
  /** When the latest of them was sent; null when there is none. */
  lastMessageAt: z.iso.datetime().nullable(),
});

export type ChannelDetails = z.infer<typeof channelDetailsSchema>;

/** One message of a Channel's history. */
export const historyMessageSchema = z.object({
  id: z.int(),
  createdAt: z.iso.datetime(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  origin: z.enum(MESSAGE_ORIGINS),
  /** The Channel note its turn ran with; null for other messages. */
  agent: z.string().nullable(),
  /** The Workflow whose Notification it delivered; null for other messages. */
  workflow: z.string().nullable(),
  /** The integration's ID for who wrote it; null for what Pero sent. */
  senderId: z.string().nullable(),
  text: z.string(),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

/** The most messages `channels.history` returns at once. */
export const MAX_HISTORY_MESSAGES = 500;

export const DEFAULT_HISTORY_MESSAGES = 20;

const channelIdSchema = z.int().positive();

/** A Channel a Workflow names: where it posts, or whose history it reads. */
export const workflowChannelSchema = z.object({
  /** The Channel's ID. */
  id: z.int(),
  integrationKind: z.enum(INTEGRATION_KINDS),
  /** Its address, as `pero channels ls` shows it. */
  key: z.string(),
  title: z.string().nullable(),
});

export type WorkflowChannelView = z.infer<typeof workflowChannelSchema>;

/** A Channel a Notification goes to. */
export const notificationTargetSchema = workflowChannelSchema;

export type NotificationTargetView = WorkflowChannelView;

/** The schedule a Workflow runs on by itself, with where it stands. */
export const workflowScheduleSchema = z.object({
  cron: z.string(),
  /** The IANA time zone it follows. */
  timezone: z.string(),
  /** When it is next due; null until Pero schedules it, or if it never is. */
  nextRunAt: z.iso.datetime().nullable(),
  /** When it last queued a run; null if it never has. */
  lastRunAt: z.iso.datetime().nullable(),
});

export type WorkflowScheduleView = z.infer<typeof workflowScheduleSchema>;

/** A Workflow as `pero workflows ls` and `show` show it. */
export const workflowViewSchema = z.object({
  name: z.string(),
  title: z.string(),
  /** Its note, relative to the workspace when inside it. */
  file: z.string(),
  /** The name of the Channel note its runs use. */
  note: z.string(),
  /** Whether that note is enabled; a run with a disabled one is held. */
  noteEnabled: z.boolean(),
  /** The input each run sends. */
  inputTemplate: z.string(),
  /** False stops it running by itself; it still runs by hand. */
  enabled: z.boolean(),
  /** How many times a run may start in all. */
  maxAttempts: z.int(),
  /** The command each run runs before its turn; null when none. */
  script: z.string().nullable(),
  /** When it runs by itself; null when it runs only by hand. */
  schedule: workflowScheduleSchema.nullable(),
  /** Where each run's answer is posted, by ID. */
  channels: z.array(workflowChannelSchema),
  /** The Channel history its runs read; null when they read none. */
  history: z
    .object({
      channels: z.union([z.literal('all'), z.array(workflowChannelSchema)]),
      /** A fixed window in hours; null reads since the previous run. */
      hours: z.int().nullable(),
    })
    .nullable(),
  /** Its note's errors, for which its last good version is in use. */
  errors: z.array(
    z.object({ property: z.string().nullable(), message: z.string() }),
  ),
});

export type WorkflowView = z.infer<typeof workflowViewSchema>;

/** Statuses a Workflow Run does not leave. */
export const FINISHED_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies readonly (typeof RUN_STATUSES)[number][];

/** One execution of a Workflow. */
export const runViewSchema = z.object({
  id: z.int(),
  /** The name of the Workflow it runs. */
  workflow: z.string(),
  triggerKey: z.string(),
  status: z.enum(RUN_STATUSES),
  attempt: z.int(),
  /** Later times of its schedule that came due and were coalesced into it. */
  skippedCount: z.int(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** What Pero answered; null until it completes. */
  result: z.string().nullable(),
  /** Why it did not complete; null otherwise. */
  error: z.string().nullable(),
});

export type RunView = z.infer<typeof runViewSchema>;

const runIdSchema = z.int().positive();

/** The most runs or Notifications a list returns at once. */
export const MAX_LISTED = 500;

export const DEFAULT_LISTED = 20;

const listLimitSchema = z.int().min(1).max(MAX_LISTED).default(DEFAULT_LISTED);

/** A durable message a finished run leaves for a Channel. */
export const notificationViewSchema = z.object({
  id: z.int(),
  /** The run that left it. */
  runId: z.int(),
  /** The name of that run's Workflow. */
  workflow: z.string(),
  /** Where it goes. */
  channel: notificationTargetSchema,
  status: z.enum(NOTIFICATION_STATUSES),
  /** Delivery attempts made so far. */
  attempt: z.int(),
  /** Attempts it gets before it is `failed`. */
  maxAttempts: z.int(),
  /** When a pending one is tried next; null otherwise. */
  nextAttemptAt: z.iso.datetime().nullable(),
  /** Why the latest attempt failed; null once delivered or before trying. */
  lastError: z.string().nullable(),
  /** The delivered message's ID in its integration; null until then. */
  providerMessageId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationDetailsSchema = notificationViewSchema.extend({
  /** The message it delivers; null when its payload holds none. */
  text: z.string().nullable(),
  /**
   * Whether its Channel's chat is allowed now; null while the Channel's
   * integration is not connected, so it cannot tell.
   */
  chatAllowed: z.boolean().nullable(),
  /**
   * Why its Channel's integration is not ready, as `pero status` shows it;
   * null while it is.
   */
  integrationProblem: z.string().nullable(),
  /** Whether an attempt to deliver it is under way. */
  delivering: z.boolean(),
});

export type NotificationDetails = z.infer<typeof notificationDetailsSchema>;

/** A run with what it read and whom it told. */
export const runDetailsSchema = runViewSchema.extend({
  /** The run that retries it; null when none does. */
  retriedBy: z.int().nullable(),
  /** The Channel history it read; null when it read none, or not yet. */
  history: z
    .object({
      channels: z.union([z.literal('all'), z.array(z.int())]),
      /** How many messages its window held. */
      count: z.int(),
      /** How many of the oldest its input left out to fit its budget. */
      dropped: z.int(),
    })
    .nullable(),
  /** Oldest first. */
  notifications: z.array(notificationViewSchema),
});

export type RunDetails = z.infer<typeof runDetailsSchema>;

const notificationIdSchema = z.int().positive();

/** What `pero check` found in the workspace; see `WorkspaceCheck`. */
export const workspaceCheckSchema = z.object({
  systemFolder: z.string().nullable(),
  channels: z.int().nonnegative(),
  workflows: z.int().nonnegative(),
  topicsChecked: z.boolean(),
  problems: z.array(
    z.object({
      file: z.string(),
      property: z.string().nullable(),
      message: z.string(),
    }),
  ),
});

const noParams = z.strictObject({});

// Results are plain objects, not strict ones: a newer daemon may add fields
// that an older CLI does not know yet.
/** Every operation with its parameter and result schemas. */
export const CONTROL_OPERATIONS = {
  status: { params: noParams, result: statusResultSchema },
  shutdown: { params: noParams, result: z.object({}) },
  /** `pero check`, with topic titles checked against the topics seen. */
  check: { params: noParams, result: workspaceCheckSchema },
  'settings.get': { params: noParams, result: settingsViewSchema },
  /** Checks each provider's sign-in again, then reports status. */
  'providers.check': { params: noParams, result: statusResultSchema },
  /** Allowed Telegram chats and the chats that recently asked to pair. */
  'telegram.chats': { params: noParams, result: telegramChatsSchema },
  'telegram.topic': {
    params: z.strictObject({
      chatId: telegramChatIdSchema,
      name: topicNameSchema,
    }),
    result: z.object({
      topicId: z.string(),
      title: z.string(),
      url: z.string().nullable(),
    }),
  },
  /**
   * Says the owner waits in a terminal to allow the next chat that asks to
   * pair; for a few seconds after, such a chat is told to confirm there.
   */
  'telegram.watchPairing': { params: noParams, result: z.object({}) },
  'telegram.allow': {
    params: z.strictObject({ chatId: telegramChatIdSchema }),
    result: z.object({
      chat: allowedChatSchema,
      alreadyAllowed: z.boolean(),
    }),
  },
  /** Keeps the chat's Channels and notes for when it is allowed again. */
  'telegram.deny': {
    params: z.strictObject({ chatId: telegramChatIdSchema }),
    result: z.object({ chat: allowedChatSchema }),
  },
  /** Stores the bot token in `.env` and takes it into use at once. */
  'telegram.token': {
    params: z.strictObject({ token: telegramBotTokenSchema }),
    result: tokenViewSchema,
  },
  /** Every Channel, by ID, and the Channel notes none of them uses. */
  'channels.list': {
    params: noParams,
    result: z.object({
      channels: z.array(channelViewSchema),
      unusedNotes: z.array(unusedNoteSchema).default([]),
    }),
  },
  'channels.get': {
    params: z.strictObject({ id: channelIdSchema }),
    result: channelDetailsSchema,
  },
  /** The Channel's latest messages, oldest first. */
  'channels.history': {
    params: z.strictObject({
      id: channelIdSchema,
      limit: z
        .int()
        .min(1)
        .max(MAX_HISTORY_MESSAGES)
        .default(DEFAULT_HISTORY_MESSAGES),
    }),
    result: z.object({
      channel: channelViewSchema,
      messages: z.array(historyMessageSchema),
    }),
  },
  /** Every Workflow, by name. */
  'workflows.list': {
    params: noParams,
    result: z.object({ workflows: z.array(workflowViewSchema) }),
  },
  'workflows.get': {
    params: z.strictObject({ name: workflowReferenceSchema }),
    result: workflowViewSchema,
  },
  /**
   * Queues a run of a Workflow, scheduled or not; the executor
   * starts it once a slot is free.
   */
  'workflows.run': {
    params: z.strictObject({ name: workflowReferenceSchema }),
    result: runViewSchema,
  },
  /** The latest runs, newest first. */
  'runs.list': {
    params: z.strictObject({
      workflow: workflowReferenceSchema.optional(),
      status: z.enum(RUN_STATUSES).optional(),
      limit: listLimitSchema,
    }),
    result: z.object({ runs: z.array(runViewSchema) }),
  },
  'runs.get': {
    params: z.strictObject({ id: runIdSchema }),
    result: runDetailsSchema,
  },
  /**
   * Queues a failed, interrupted, or cancelled run again as a new run that
   * reads the same history window, whatever its Workflow's attempts allow.
   * `alsoReadBy` names a run completed since that read some of those
   * messages too; null when none did.
   */
  'runs.retry': {
    params: z.strictObject({ id: runIdSchema }),
    result: z.object({
      run: runViewSchema,
      alsoReadBy: z.int().nullable(),
    }),
  },
  /**
   * Cancels a pending run at once, or aborts a running one, which is
   * returned still `running` until its turn stops.
   */
  'runs.cancel': {
    params: z.strictObject({ id: runIdSchema }),
    result: runViewSchema,
  },
  /** The latest Notifications, newest first. */
  'notifications.list': {
    params: z.strictObject({
      status: z.enum(NOTIFICATION_STATUSES).optional(),
      workflow: workflowReferenceSchema.optional(),
      channel: channelIdSchema.optional(),
      run: runIdSchema.optional(),
      limit: listLimitSchema,
    }),
    result: z.object({ notifications: z.array(notificationViewSchema) }),
  },
  'notifications.get': {
    params: z.strictObject({ id: notificationIdSchema }),
    result: notificationDetailsSchema,
  },
  /**
   * Makes a pending Notification due now, or gives a failed one a fresh
   * set of attempts starting now; a delivered one is refused.
   */
  'notifications.retry': {
    params: z.strictObject({ id: notificationIdSchema }),
    result: notificationDetailsSchema,
  },
  /**
   * Writes a backup of the workspace to an absolute path, with the
   * data folder when `includeData` is set.
   */
  'backup.create': {
    params: z.strictObject({
      file: z.string().min(1),
      includeData: z.boolean().optional(),
    }),
    result: backupResultSchema,
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type ControlOperation = keyof typeof CONTROL_OPERATIONS;

export type ControlParams<Op extends ControlOperation> = z.input<
  (typeof CONTROL_OPERATIONS)[Op]['params']
>;

/** An operation's parameters once validated, with defaults filled in. */
export type ParsedControlParams<Op extends ControlOperation> = z.output<
  (typeof CONTROL_OPERATIONS)[Op]['params']
>;

export type ControlResult<Op extends ControlOperation> = z.output<
  (typeof CONTROL_OPERATIONS)[Op]['result']
>;

export function isControlOperation(op: string): op is ControlOperation {
  return Object.hasOwn(CONTROL_OPERATIONS, op);
}

export const controlRequestSchema = z.object({
  op: z.string(),
  params: z.unknown().optional(),
});

export type ControlRequest = z.infer<typeof controlRequestSchema>;

/**
 * Codes the daemon answers with. The client also raises `timeout`,
 * `connection`, `invalid_response`, and `too_large`.
 */
export const CONTROL_ERROR_CODES = [
  'invalid_request',
  'unknown_operation',
  'invalid_input',
  'not_found',
  'conflict',
  'internal',
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

// The error code stays a plain string so an older CLI can still report a
// code that a newer daemon added.
export const controlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type ControlResponse = z.infer<typeof controlResponseSchema>;

/** A control request that failed for a reason other than its input. */
export class ControlError extends Error {
  override name = 'ControlError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Resolves with the first line `socket` receives, without its newline.
 * Rejects with a `too_large` `ControlError` past `maxBytes`, and when the
 * connection ends or fails first. Anything after the line is ignored.
 */
export function readLine(
  socket: Socket,
  maxBytes = MAX_MESSAGE_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > maxBytes) {
        cleanup();
        reject(
          new ControlError('too_large', `Message exceeds ${maxBytes} bytes`),
        );
        return;
      }
      chunks.push(part);
      if (newline !== -1) {
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(
        new ControlError(
          'connection',
          'Connection closed before a complete message',
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}
