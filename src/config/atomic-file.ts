import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * Replaces `path` with `text` in one step: the text goes to a temporary file
 * beside it, created with `mode`, which is synced and renamed over `path`.
 * Readers see the old file or the new one, never half of one.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  mode: number,
): void {
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
