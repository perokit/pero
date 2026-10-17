import { z } from 'zod';
import {
  type AgentRequest,
  agentRequest,
  type InstructionDefaults,
} from '../agents/agent-request.js';
import {
  PROVIDERS,
  providerOptionsSchema,
} from '../config/provider-options.js';
import { toolPolicySchema } from '../config/tool-policy.js';
import type { ChannelNote } from '../system-files/snapshot.js';

/**
 * The window of Channel history a run reads, fixed when the executor
 * claims it, and what it reads there. A retry reads the same window; the
 * Workflow's next run starts after `untilId`. Messages are bounded by ID,
 * since `created_at` has whole seconds.
 */
export const historyWindowSchema = z.object({
  channels: z.union([z.literal('all'), z.array(z.int())]),
  /** The last message of the previous window; null for a first window. */
  afterId: z.int().nullable(),
  /** Where a first or fixed window starts; null after an earlier window. */
  since: z.iso.datetime().nullable(),
  /** The latest message when the run was claimed. */
  untilId: z.int(),
});

export type HistoryWindowSnapshot = z.infer<typeof historyWindowSchema>;

/** A history window with how many of its messages the input carried. */
export const historyReadSchema = historyWindowSchema.extend({
  /** How many messages the window holds. */
  count: z.int().nonnegative(),
  /** How many of the oldest the input left out to fit its budget. */
  dropped: z.int().nonnegative(),
});

export type HistoryRead = z.infer<typeof historyReadSchema>;

/**
 * What a Workflow Run executes with, captured when the executor claims it:
 * the Channel note's resolved settings and the input. The run uses this
 * copy, so later edits to the note or the Workflow leave it alone.
 */
export const executionSnapshotSchema = z.object({
  /** The name of the Channel note it runs with. */
  agentName: z.string(),
  provider: z.enum(PROVIDERS),
  providerOptions: providerOptionsSchema,
  /** The effective folder, already resolved. */
  workingDirectory: z.string(),
  /** Shared and own instructions, already composed. */
  instructions: z.string(),
  toolPolicy: toolPolicySchema,
  /** Lets Codex work in a folder that is not a Git repository. */
  skipGitRepoCheck: z.boolean(),
  /**
   * What the run sends, with any history already rendered, and once it
   * has run, its script's output too.
   */
  input: z.string(),
  /** The Channel history the input carries; absent when it reads none. */
  history: historyReadSchema.optional(),
  /** The command the run runs before its turn; absent when none. */
  script: z.string().optional(),
});

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

/**
 * The snapshot of `agent`'s settings, the Channel note a run uses, with
 * the shared instructions composed in, and of `input`, its `history`, and
 * the `script` that runs first.
 */
export function executionSnapshot(
  agent: ChannelNote,
  defaults: InstructionDefaults,
  input: string,
  history?: HistoryRead,
  script?: string | null,
): ExecutionSnapshot {
  return {
    agentName: agent.name,
    provider: agent.provider,
    ...agentRequest(agent, defaults),
    input,
    ...(history === undefined ? {} : { history }),
    ...(script === undefined || script === null ? {} : { script }),
  };
}

/** The note's part of a runtime request, as `snapshot` captured it. */
export function snapshotRequest(snapshot: ExecutionSnapshot): AgentRequest {
  return {
    instructions: snapshot.instructions,
    providerOptions: snapshot.providerOptions,
    workingDirectory: snapshot.workingDirectory,
    skipGitRepoCheck: snapshot.skipGitRepoCheck,
    toolPolicy: snapshot.toolPolicy,
  };
}
