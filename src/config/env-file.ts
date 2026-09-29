import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * A workspace's `.env` holds Pero's secrets as `KEY=value` lines, the format
 * a systemd `EnvironmentFile=` reads too. It must be owner-only and is never
 * committed.
 */

/** `.env` is readable by group or others, so Pero refuses to read it. */
export class EnvFilePermissionError extends Error {
  override name = 'EnvFilePermissionError';

  constructor(readonly path: string) {
    super(`${path} is readable by other users; run chmod 600 ${path}`);
  }
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * The variables in `text`: one `KEY=value` per line, optionally after
 * `export`. Blank lines and lines starting with `#` are skipped; a value in
 * single or double quotes loses them. A later line wins over an earlier one.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE.exec(line);
    if (match) values.set(match[1]!, unquote(match[2]!.trim()));
  }
  return values;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
  }
  return value;
}

/**
 * The variables in the `.env` file at `path`; null when there is none.
 * Throws `EnvFilePermissionError` when group or others may read it.
 */
export function readEnvFile(path: string): Map<string, string> | null {
  let text: string;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new EnvFilePermissionError(path);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseEnvFile(text);
}

/**
 * Sets `key` to `value` in the `.env` file at `path`, creating it, or
 * removes the key when `value` is null. Every other line, comments
 * included, is kept as it was. The file is replaced atomically and is
 * owner-only.
 */
export function setEnvValue(
  path: string,
  key: string,
  value: string | null,
): void {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const entry = value === null ? null : `${key}=${quote(value)}`;
  const kept: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (LINE.exec(line)?.[1] !== key) {
      kept.push(line);
    } else if (entry !== null && !placed) {
      kept.push(entry);
      placed = true;
    }
  }
  if (entry !== null && !placed) kept.push(entry);
  if (value === null && kept.length === lines.length) return;
  writeFileAtomic(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 0o600);
}

function quote(value: string): string {
  if (/^[\w@%+=:,./-]*$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Adds `entry` as a line of the `.gitignore` at `path`, creating the file,
 * unless a line already says exactly that. True when it was added.
 */
export function ensureGitignoreLine(path: string, entry: string): boolean {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return false;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${entry}\n`);
  return true;
}

/**
 * What is wrong with how Git treats `.env` in `workspace`: it is tracked,
 * or it exists and would not be ignored. Null when all is well, when the
 * workspace is not in a Git repository, or when Git is not installed.
 */
export async function gitEnvFileProblem(
  workspace: string,
): Promise<string | null> {
  const git = (...args: string[]) =>
    new Promise<number | null>((resolve) => {
      execFile('git', ['-C', workspace, ...args], (error) => {
        if (error === null) resolve(0);
        else resolve(typeof error.code === 'number' ? error.code : null);
      });
    });
  if ((await git('rev-parse', '--is-inside-work-tree')) !== 0) return null;
  if ((await git('ls-files', '--error-unmatch', '--', '.env')) === 0) {
    return '.env is tracked by Git, so the bot token is in its history — run git rm --cached .env, add .env to .gitignore, and replace the token with @BotFather /revoke';
  }
  let exists = true;
  try {
    statSync(join(workspace, '.env'));
  } catch {
    exists = false;
  }
  if (exists && (await git('check-ignore', '-q', '--', '.env')) === 1) {
    return '.env is not ignored by Git, so a commit could include the bot token — add .env to .gitignore';
  }
  return null;
}
