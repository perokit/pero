import { FILE_NOTE } from '../../agents/agent-request.js';
import { Logger } from '@nestjs/common';
import type {
  CodexOptions,
  Input,
  Thread,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeError,
  type RuntimeEvent,
  type RuntimeRequest,
} from '../agent-runtime.js';
import { type CodexFactory, CodexRuntime } from './codex-runtime.js';
import {
  completed,
  message,
  NOT_GIT_EXIT,
  started,
  THREAD,
} from './testing/codex-events.js';

const ENV = { PATH: '/usr/bin', HOME: '/home/owner' };

function request(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    input: 'Hello',
    instructions: '',
    providerOptions: { model: null, effort: null },
    workingDirectory: '/home/owner/vault',
    toolPolicy: { permissions: 'ask' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Call {
  options: CodexOptions;
  threadOptions: ThreadOptions;
  /** The thread resumed; undefined for a new one. */
  resumed?: string;
  input: Input;
  signal: AbortSignal;
}

/** A Codex client that plays `script` and records what it was called with. */
function fakeCodex(
  script: (
    signal: AbortSignal,
  ) => AsyncGenerator<ThreadEvent> = async function* () {
    yield started();
    yield message('Hi');
    yield completed();
  },
) {
  const calls: Call[] = [];
  const thread = (
    options: CodexOptions,
    threadOptions: ThreadOptions,
    resumed?: string,
  ) =>
    ({
      runStreamed: (input: Input, turn: { signal: AbortSignal }) => {
        calls.push({
          options,
          threadOptions,
          ...(resumed === undefined ? {} : { resumed }),
          input,
          signal: turn.signal,
        });
        return Promise.resolve({ events: script(turn.signal) });
      },
    }) as unknown as Thread;
  const codex: CodexFactory = (options) => ({
    startThread: (threadOptions = {}) => thread(options, threadOptions),
    resumeThread: (id, threadOptions = {}) =>
      thread(options, threadOptions, id),
  });
  return { codex, calls };
}

async function collect(
  events: AsyncIterable<RuntimeEvent>,
): Promise<RuntimeEvent[]> {
  const all: RuntimeEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function failure(events: AsyncIterable<RuntimeEvent>) {
  try {
    await collect(events);
  } catch (error) {
    return error as RuntimeError;
  }
  throw new Error('the turn did not fail');
}

describe('CodexRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a turn and reports its events', async () => {
    const { codex, calls } = fakeCodex();

    const events = await collect(
      new CodexRuntime(codex, ENV).execute(request()),
    );

    expect(events).toEqual([
      { type: 'session', providerSessionId: THREAD },
      { type: 'text', delta: 'Hi' },
      { type: 'result', text: 'Hi' },
    ]);
    expect(calls[0]!.input).toBe(`${FILE_NOTE}\n\nOwner message:\nHello`);
    expect(calls[0]!.resumed).toBeUndefined();
  });

  it('sends the images that came with the input after it, and no other file', async () => {
    const { codex, calls } = fakeCodex();

    await collect(
      new CodexRuntime(codex, ENV).execute(
        request({
          input: 'What are these?',
          attachments: [
            '/ws/.pero/attachments/1/a.jpg',
            '/ws/.pero/attachments/1/b-receipt.pdf',
            '/ws/.pero/attachments/1/c.png',
          ],
        }),
      ),
    );

    expect(calls[0]!.input).toEqual([
      { type: 'text', text: `${FILE_NOTE}\n\nOwner message:\nWhat are these?` },
      { type: 'local_image', path: '/ws/.pero/attachments/1/a.jpg' },
      { type: 'local_image', path: '/ws/.pero/attachments/1/c.png' },
    ]);
  });

  it('sends the input alone with files that are not images', async () => {
    const { codex, calls } = fakeCodex();

    await collect(
      new CodexRuntime(codex, ENV).execute(
        request({
          input: 'Sum it up',
          attachments: ['/ws/.pero/attachments/1/b-receipt.pdf'],
        }),
      ),
    );

    expect(calls[0]!.input).toBe(`${FILE_NOTE}\n\nOwner message:\nSum it up`);
  });

  it('works in the folder, leaving out unset options', async () => {
    const { codex, calls } = fakeCodex();

    await collect(new CodexRuntime(codex, ENV).execute(request()));

    const { options, threadOptions } = calls[0]!;
    expect(threadOptions).toMatchObject({
      workingDirectory: '/home/owner/vault',
      skipGitRepoCheck: false,
      approvalPolicy: 'never',
    });
    for (const option of ['model', 'modelReasoningEffort']) {
      expect(threadOptions).not.toHaveProperty(option);
    }
    expect(options.env).toEqual(ENV);
    expect(options.config).toMatchObject({ forced_login_method: 'chatgpt' });
    expect(options.config).not.toHaveProperty('developer_instructions');
  });

  it('passes the model, effort, instructions, and the thread to resume', async () => {
    const { codex, calls } = fakeCodex();

    await collect(
      new CodexRuntime(codex, ENV).execute(
        request({
          instructions: 'Be kind.\n\nBe brief.',
          providerOptions: { model: 'gpt-5.5', effort: 'xhigh' },
          providerSessionId: THREAD,
        }),
      ),
    );

    expect(calls[0]!.resumed).toBe(THREAD);
    expect(calls[0]!.threadOptions).toMatchObject({
      model: 'gpt-5.5',
      modelReasoningEffort: 'xhigh',
    });
    expect(calls[0]!.options.config).toMatchObject({
      developer_instructions: 'Be kind.\n\nBe brief.',
    });
  });

  it('refuses an effort level Codex does not have', async () => {
    const { codex, calls } = fakeCodex();

    const error = await failure(
      new CodexRuntime(codex, ENV).execute(
        request({
          // The Agent service never lets one through; the adapter checks too.
          providerOptions: { model: null, effort: 'turbo' as never },
        }),
      ),
    );

    expect(error).toMatchObject({ kind: 'failed' });
    expect(error.message).toMatch(/turbo/);
    expect(calls).toEqual([]);
  });

  it('skips the Git check only for an Agent that opts out', async () => {
    const { codex, calls } = fakeCodex();
    const runtime = new CodexRuntime(codex, ENV);

    await collect(runtime.execute(request({ skipGitRepoCheck: false })));
    await collect(runtime.execute(request({ skipGitRepoCheck: true })));

    expect(calls.map((call) => call.threadOptions.skipGitRepoCheck)).toEqual([
      false,
      true,
    ]);
  });

  it('explains a folder outside Git that the Agent may not use', async () => {
    const { codex } = fakeCodex(async function* () {
      yield* [];
      throw new Error(NOT_GIT_EXIT);
    });

    const error = await failure(
      new CodexRuntime(codex, ENV).execute(request()),
    );

    expect(error.kind).toBe('failed');
    expect(error.message).toMatch(/Git repository.*\/home\/owner\/vault/);
  });

  it('never passes on an API key, so Codex keeps using the sign-in', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { codex, calls } = fakeCodex();

    await collect(
      new CodexRuntime(codex, {
        ...ENV,
        OPENAI_API_KEY: 'sk-secret',
        CODEX_API_KEY: 'sk-other',
      }).execute(request()),
    );

    expect(calls[0]!.options.env).toEqual(ENV);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY and CODEX_API_KEY'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-secret');
  });

  describe('permissions', () => {
    it('runs a bypass Agent without the sandbox', async () => {
      const { codex, calls } = fakeCodex();

      await collect(
        new CodexRuntime(codex, ENV).execute(
          request({ toolPolicy: { permissions: 'bypass' } }),
        ),
      );

      expect(calls[0]!.threadOptions.sandboxMode).toBe('danger-full-access');
      expect(calls[0]!.threadOptions).not.toHaveProperty(
        'networkAccessEnabled',
      );
      expect(calls[0]!.options.config).not.toHaveProperty(
        'sandbox_workspace_write',
      );
    });

    it('sandboxes an ask Agent to its folder, without network access', async () => {
      const { codex, calls } = fakeCodex();

      await collect(new CodexRuntime(codex, ENV).execute(request()));

      expect(calls[0]!.threadOptions).toMatchObject({
        sandboxMode: 'workspace-write',
        networkAccessEnabled: false,
        approvalPolicy: 'never',
      });
      expect(calls[0]!.options.config).toMatchObject({
        sandbox_workspace_write: {
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true,
        },
      });
    });

    it('never asks the approver, since Codex cannot wait for an answer', async () => {
      const approve = vi.fn();
      const { codex } = fakeCodex();

      await collect(new CodexRuntime(codex, ENV).execute(request({ approve })));

      expect(approve).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('reports a missing Codex binary as a failed turn', async () => {
      const error = await failure(
        new CodexRuntime(() => {
          throw new Error('Unable to locate Codex CLI binaries.');
        }, ENV).execute(request()),
      );

      expect(error).toEqual(
        new RuntimeError('failed', 'Unable to locate Codex CLI binaries.'),
      );
    });

    it('fails a turn that ends before it completes', async () => {
      const { codex } = fakeCodex(async function* () {
        yield started();
        yield message('Hi');
      });

      const error = await failure(
        new CodexRuntime(codex, ENV).execute(request()),
      );

      expect(error).toEqual(
        new RuntimeError('failed', 'Codex stopped before finishing the turn'),
      );
    });

    it('refuses a turn aborted before it starts', async () => {
      const { codex, calls } = fakeCodex();
      const abort = new AbortController();
      abort.abort();

      const error = await failure(
        new CodexRuntime(codex, ENV).execute(request({ signal: abort.signal })),
      );

      expect(error.kind).toBe('cancelled');
      expect(calls).toEqual([]);
    });

    it('stops Codex and reports cancelled when the turn is aborted', async () => {
      const abort = new AbortController();
      const { codex, calls } = fakeCodex(async function* (signal) {
        yield started();
        yield message('Working');
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
        }
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      });

      const turn = collect(
        new CodexRuntime(codex, ENV).execute(request({ signal: abort.signal })),
      );
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      abort.abort();

      await expect(turn).rejects.toMatchObject({ kind: 'cancelled' });
      expect(calls[0]!.signal.aborted).toBe(true);
    });

    it('stops Codex when the caller stops reading', async () => {
      const { codex, calls } = fakeCodex(async function* () {
        yield started();
        yield message('Hi');
        yield completed();
      });

      for await (const event of new CodexRuntime(codex, ENV).execute(
        request(),
      )) {
        if (event.type === 'session') break;
      }

      expect(calls[0]!.signal.aborted).toBe(true);
    });

    it('leaves Codex alone once the turn has completed', async () => {
      const { codex, calls } = fakeCodex();

      await collect(new CodexRuntime(codex, ENV).execute(request()));

      expect(calls[0]!.signal.aborted).toBe(false);
    });
  });
});
