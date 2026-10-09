import { Logger } from '@nestjs/common';
import {
  Codex,
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type ThreadOptions,
} from '@openai/codex-sdk';
import { FILE_NOTE } from '../../agents/agent-request.js';
import { imageTypeOf } from '../../common/images.js';
import { CODEX_EFFORTS } from '../../config/provider-options.js';
import {
  type AgentRuntime,
  RuntimeError,
  type RuntimeEvent,
  type RuntimeRequest,
} from '../agent-runtime.js';
import {
  classifyCodexFailure,
  newTurnState,
  normalizeCodexEvent,
} from './codex-events.js';

/** Creates the SDK client for a turn; `new Codex`, or a fake in tests. */
export type CodexFactory = (
  options: CodexOptions,
) => Pick<Codex, 'startThread' | 'resumeThread'>;

/**
 * Variables that would make Codex bill an API account instead of the
 * owner's ChatGPT sign-in. Pero never passes them on.
 */
const API_BILLING_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

/**
 * Runs Agents on Codex through the Codex SDK, signed in with the owner's
 * ChatGPT subscription. Agents work like the Codex CLI in their folder:
 * the owner's `~/.codex/config.toml` and the folder's `AGENTS.md` apply,
 * and the Agent's instructions are added as developer instructions.
 *
 * Codex runs each turn non-interactively, so it cannot ask the owner about
 * a tool and the request's approver is never called. An `ask` Agent runs
 * in Codex's sandbox instead: it may read anywhere and write only in its
 * folder, without network access; a `bypass` Agent runs unsandboxed.
 */
export class CodexRuntime implements AgentRuntime {
  readonly kind = 'codex' as const;
  private readonly logger = new Logger('Codex');
  private readonly env: Record<string, string>;

  constructor(
    private readonly codex: CodexFactory = (options) => new Codex(options),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const dropped = API_BILLING_ENV.filter((name) => env[name] !== undefined);
    if (dropped.length > 0) {
      this.logger.warn(
        `Ignoring ${dropped.join(' and ')}: Pero uses Codex with the ChatGPT ` +
          `sign-in of the account running Pero`,
      );
    }
    this.env = Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !API_BILLING_ENV.includes(entry[0]),
      ),
    );
  }

  async *execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    if (request.signal.aborted) {
      throw new RuntimeError('cancelled', 'The turn was aborted');
    }
    // Its own controller, so the process also stops when the caller stops
    // reading early.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    const state = newTurnState(request.providerSessionId);
    try {
      // Inside the try: it throws when the Codex binary is missing.
      const codex = this.codex(this.options(request));
      const thread =
        request.providerSessionId === undefined
          ? codex.startThread(threadOptions(request))
          : codex.resumeThread(
              request.providerSessionId,
              threadOptions(request),
            );
      const { events } = await thread.runStreamed(codexInput(request), {
        signal: abort.signal,
      });
      for await (const event of events) {
        yield* normalizeCodexEvent(event, state);
      }
      if (!state.finished) {
        throw new RuntimeError(
          'failed',
          'Codex stopped before finishing the turn',
        );
      }
    } catch (error) {
      throw classifyCodexFailure(error, {
        aborted: request.signal.aborted,
        workingDirectory: request.workingDirectory,
      });
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (!state.finished) abort.abort();
    }
  }

  /** The client options for one turn of `request`. */
  private options(request: RuntimeRequest): CodexOptions {
    return {
      env: this.env,
      config: {
        // A stored API-key login must not switch the owner's billing either.
        forced_login_method: 'chatgpt',
        ...(request.instructions === ''
          ? {}
          : { developer_instructions: request.instructions }),
        ...(request.toolPolicy.permissions === 'ask'
          ? {
              // Only the Agent's folder, not the shared temporary folders.
              sandbox_workspace_write: {
                exclude_slash_tmp: true,
                exclude_tmpdir_env_var: true,
              },
            }
          : {}),
      },
    };
  }
}

/** The thread options for one turn of `request`. */
function threadOptions(request: RuntimeRequest): ThreadOptions {
  const { model, effort } = request.providerOptions;
  return {
    workingDirectory: request.workingDirectory,
    skipGitRepoCheck: request.skipGitRepoCheck ?? false,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { modelReasoningEffort: codexEffort(effort) }),
    // No one can answer mid-turn; the sandbox decides instead.
    approvalPolicy: 'never',
    ...(request.toolPolicy.permissions === 'bypass'
      ? { sandboxMode: 'danger-full-access' }
      : { sandboxMode: 'workspace-write', networkAccessEnabled: false }),
  };
}

/** `effort`, which the Agent service has checked against Codex's levels. */
function codexEffort(effort: string): ModelReasoningEffort {
  if (!(CODEX_EFFORTS as readonly string[]).includes(effort)) {
    throw new RuntimeError('failed', `Codex has no effort level ${effort}`);
  }
  return effort as ModelReasoningEffort;
}

/**
 * The turn's input, followed by the images sent with it, if any; Codex
 * takes no other file, so it reads those from where the input names them.
 */
function codexInput(request: RuntimeRequest): Input {
  const images = (request.attachments ?? []).filter(
    (path) => imageTypeOf(path) !== null,
  );
  // Repeat the host handoff on every turn so resumed threads do not retain an obsolete delivery model.
  const input = `${FILE_NOTE}\n\nOwner message:\n${request.input}`;
  if (images.length === 0) return input;
  return [
    { type: 'text', text: input },
    ...images.map((path) => ({ type: 'local_image' as const, path })),
  ];
}
