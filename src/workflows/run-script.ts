import { type ChildProcess, spawn } from 'node:child_process';

/**
 * The whole output of a Workflow's script that has found nothing to do:
 * its run completes without a turn and notifies no one.
 */
export const NO_DATA = 'NO_DATA';

/** Where a Workflow's input takes its script's output. */
export const SCRIPT_PLACEHOLDER = '{{script}}';

/** How long a Workflow's script may run before it fails the run. */
export const SCRIPT_TIMEOUT_MS = 5 * 60_000;

/** The most script output a run's input carries. */
export const SCRIPT_INPUT_BUDGET = 50_000;

/** How much of a script's output is kept. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** How long a stopped script has to exit before it is killed. */
const KILL_AFTER_MS = 5000;

const OPENING = '[Script output]';
const CLOSING = '[End of script output]';
const EMPTY = '[The script printed nothing]';

/** Why a Workflow's script gave no output to use. */
export class ScriptError extends Error {
  override name = 'ScriptError';

  constructor(
    message: string,
    /** True when its signal stopped it, rather than it failing. */
    readonly aborted = false,
  ) {
    super(message);
  }
}

export interface ScriptOptions {
  /** The folder it runs in. */
  cwd: string;
  /** Added to Pero's own environment. */
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Runs `command` through the shell, as the owner wrote it in a Workflow
 * note, and resolves to what it printed. Throws a `ScriptError` when it
 * cannot start, exits with an error, takes longer than `timeoutMs`, or
 * `signal` stops it; stopping it stops everything it started too.
 */
export function runScript(
  command: string,
  { cwd, env, signal, timeoutMs }: ScriptOptions,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new ScriptError('script was stopped', true));
      return;
    }
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so stopping it reaches what it started.
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });

    /** Why it was stopped, once it was. */
    let stopped: ScriptError | null = null;
    const stop = (reason: ScriptError) => {
      if (stopped !== null) return;
      stopped = reason;
      kill(child);
    };
    const onAbort = () => stop(new ScriptError('script was stopped', true));
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () =>
        stop(new ScriptError(`script took longer than ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      settle();
      reject(
        stopped ?? new ScriptError(`script could not start: ${error.message}`),
      );
    });
    child.on('close', (code) => {
      settle();
      if (stopped !== null) {
        reject(stopped);
      } else if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'));
      } else {
        const last = Buffer.concat(stderr)
          .toString('utf8')
          .split('\n')
          .map((line) => line.trim())
          .findLast((line) => line !== '');
        reject(
          new ScriptError(
            `script failed${last === undefined ? ` (exit ${code})` : `: ${last}`}`,
          ),
        );
      }
    });
  });
}

/** Stops `child` and its process group, killing them if they linger. */
function kill(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill();
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* Already gone. */
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS).unref();
}

/** Whether `output`, a script's, says it found nothing to do. */
export function isNoData(output: string): boolean {
  return output.trim() === NO_DATA;
}

/**
 * `template` with a script's `output` in place of `{{script}}`, or after
 * the input when there is none. Output past `budget` characters is left
 * out, and the input says how much.
 */
export function renderScriptInput(
  template: string,
  output: string,
  budget = SCRIPT_INPUT_BUDGET,
): string {
  const text = output.trimEnd();
  const kept = text.length > budget ? text.slice(0, budget) : text;
  const left = text.length - kept.length;
  const block =
    text === ''
      ? EMPTY
      : [
          OPENING,
          kept,
          ...(left === 0 ? [] : [`[${left} more characters left out to fit]`]),
          CLOSING,
        ].join('\n');
  return template.includes(SCRIPT_PLACEHOLDER)
    ? template.replaceAll(SCRIPT_PLACEHOLDER, () => block)
    : `${template}\n\n${block}`;
}
