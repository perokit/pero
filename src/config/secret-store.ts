import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * Secrets are single files in the data directory's owner-only `secrets/`,
 * one value per file, each readable and writable by the owner only.
 */

/** The stored value of secret `name`, or null when it is not stored. */
export function readSecret(dir: string, name: string): string | null {
  try {
    return readFileSync(join(dir, name), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Stores `value` as secret `name`. The file is replaced atomically and is
 * owner-only from the moment it exists.
 */
export function writeSecret(dir: string, name: string, value: string): void {
  writeFileAtomic(join(dir, name), `${value}\n`, 0o600);
}

/** Removes secret `name`; nothing happens when it is not stored. */
export function deleteSecret(dir: string, name: string): void {
  rmSync(join(dir, name), { force: true });
}
