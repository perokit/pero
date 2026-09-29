import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const OWNER_ONLY = 0o700;

/** sun_path is 104 bytes on macOS and the BSDs and 108 on Linux, NUL included. */
export const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 107 : 103;

/**
 * `.pero/.gitignore` in a workspace: everything in `.pero/` is Pero's own
 * state except `config.yaml`, which is meant to be committed.
 */
export const STATE_GITIGNORE = [
  '# Written by Pero. Everything here is its state, except config.yaml.',
  '*',
  '!.gitignore',
  '!config.yaml',
  '',
].join('\n');

/**
 * Absolute paths inside a state directory: a workspace's `.pero/`, or a
 * legacy data directory.
 */
export interface DataDirLayout {
  root: string;
  /** The workspace holding `root`; null for a legacy data directory. */
  workspace: string | null;
  database: string;
  logs: string;
  logFile: string;
  /** Plain-text stdout and stderr of a daemon started by `pero run`. */
  daemonOutputFile: string;
  run: string;
  /**
   * Unix socket of the control endpoint; owner-only. It is in `run/` unless
   * that path is too long for a socket; see `controlSocketPath`.
   */
  controlSocket: string;
  /** Held by the running daemon; the file itself stays after it stops. */
  lockFile: string;
  /** The running daemon's pid, version, and socket; JSON. */
  metadataFile: string;
  /** The legacy `secrets/`; a workspace keeps its secrets in `envFile`. */
  secrets: string;
  /** `.pero/.gitignore`; null for a legacy data directory. */
  stateGitignore: string | null;
  /** The workspace's `.env`; null for a legacy data directory. */
  envFile: string | null;
  /** The workspace's own `.gitignore`; null for a legacy data directory. */
  workspaceGitignore: string | null;
}

export class DataDirError extends Error {
  override name = 'DataDirError';
}

/**
 * Returns the layout of `root` without touching the filesystem. `workspace`
 * is the folder holding it, or null for a legacy data directory.
 */
export function dataDirLayout(
  root: string,
  workspace: string | null = null,
): DataDirLayout {
  const logs = join(root, 'logs');
  const run = join(root, 'run');
  return {
    root,
    workspace,
    database: join(root, 'pero.sqlite'),
    logs,
    logFile: join(logs, 'pero.log'),
    daemonOutputFile: join(logs, 'daemon.out'),
    run,
    controlSocket: controlSocketPath(root),
    lockFile: join(run, 'pero.lock'),
    metadataFile: join(run, 'pero.json'),
    secrets: join(root, 'secrets'),
    stateGitignore: workspace === null ? null : join(root, '.gitignore'),
    envFile: workspace === null ? null : join(workspace, '.env'),
    workspaceGitignore:
      workspace === null ? null : join(workspace, '.gitignore'),
  };
}

/**
 * The control socket of state directory `root`: `run/pero.sock`, or, when
 * that path is too long for a Unix socket, `pero.sock` in a folder named
 * after a hash of `root` under `$XDG_RUNTIME_DIR` or the temp folder.
 */
export function controlSocketPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const socket = join(root, 'run', 'pero.sock');
  if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return socket;
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const base = env.XDG_RUNTIME_DIR?.trim() || tmpdir();
  return join(base, `pero-${hash}`, 'pero.sock');
}

/**
 * Creates the state directory and its subdirectories with owner-only
 * permissions. A root created here is made owner-only; an existing root is
 * left alone because the owner may have pointed Pero at a folder they manage.
 * Pero's own subdirectories are always reset to owner-only. In a workspace,
 * `.pero/.gitignore` is written when it is missing, and there is no
 * `secrets/`: the workspace's `.env` holds them.
 */
export function ensureDataDir(
  root: string,
  workspace: string | null = null,
): DataDirLayout {
  const layout = dataDirLayout(root, workspace);
  try {
    const created = mkdirSync(root, { recursive: true, mode: OWNER_ONLY });
    if (created !== undefined) chmodSync(root, OWNER_ONLY);
    const socketDir = dirname(layout.controlSocket);
    const dirs = [layout.logs, layout.run];
    if (workspace === null) dirs.push(layout.secrets);
    if (socketDir !== layout.run) dirs.push(socketDir);
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
      chmodSync(dir, OWNER_ONLY);
    }
    if (socketDir !== layout.run) checkOwnDirectory(socketDir);
    if (layout.stateGitignore !== null) {
      writeIfMissing(layout.stateGitignore, STATE_GITIGNORE);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DataDirError(`Cannot prepare data directory ${root}: ${reason}`, {
      cause: error,
    });
  }
  return layout;
}

/** `workspace /x`, or `data directory /x` for a legacy one; for messages. */
export function describeLocation(
  layout: Pick<DataDirLayout, 'root' | 'workspace'>,
): string {
  return layout.workspace === null
    ? `data directory ${layout.root}`
    : `workspace ${layout.workspace}`;
}

/** A socket folder in a shared place must belong to this user alone. */
function checkOwnDirectory(dir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (statSync(dir).uid !== uid) {
    throw new Error(`${dir} belongs to another user`);
  }
}

function writeIfMissing(path: string, text: string): void {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
