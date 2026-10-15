import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { SpeechError } from './speech-engine.js';

/** How much of a program's output is kept. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The path `program` runs from: itself when it names a path, else the
 * first match on `PATH`; null when there is none.
 */
export function findProgram(
  program: string,
  path: string = process.env.PATH ?? '',
): string | null {
  if (program.includes('/')) {
    const full = isAbsolute(program) ? program : resolve(program);
    return executable(full) ? full : null;
  }
  for (const folder of path.split(delimiter)) {
    if (folder === '') continue;
    const full = join(folder, program);
    if (executable(full)) return full;
  }
  return null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RunOptions {
  /** Written to the program's standard input. */
  input?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Runs `program` with `args`, never through a shell, and resolves to what
 * it printed. Throws a `SpeechError` when it is missing, fails, or takes
 * longer than `timeoutMs`, naming the program and its last error line.
 */
export function runProgram(
  program: string,
  args: readonly string[],
  { input, signal, timeoutMs }: RunOptions,
): Promise<string> {
  const name = program.split('/').at(-1) ?? program;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).length <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new SpeechError(`${name} isn't installed`));
      } else if (error.name === 'AbortError') {
        // ffmpeg and preview workers may have descendants; stop the whole group.
        if (child.pid !== undefined && process.platform !== 'win32') {
          const pid = child.pid;
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* Already gone. */
          }
          setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* Already gone. */
            }
          }, 5000).unref();
        }
        reject(
          new SpeechError(
            signal.aborted
              ? `${name} was stopped`
              : `${name} took longer than ${timeoutMs / 1000} s`,
          ),
        );
      } else {
        reject(new SpeechError(`${name} failed: ${error.message}`));
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      if (code === null) return; // Killed; `error` has said why.
      const lines = Buffer.concat(stderr)
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      // A program may print its usage after the error, as whisper-cli does.
      const last =
        lines.findLast((line) => /\berror\b/i.test(line)) ?? lines.at(-1);
      reject(
        new SpeechError(
          `${name} failed${last === undefined ? ` (exit ${code})` : `: ${last}`}`,
        ),
      );
    });
    // A program that never reads its input must not fail the run.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}
