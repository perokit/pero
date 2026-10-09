import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileEvent {
  operation: 'download' | 'transcribe' | 'upload' | 'preview' | 'extract';
  name: string;
  bytes: number;
  elapsedMs: number;
  status: 'ok' | 'failed';
}

/** Metadata only, with bounded storage; never record tokens or file contents. */
const pending = new Map<string, Promise<void>>();

export async function recordFileEvent(
  workspace: string,
  event: FileEvent,
): Promise<void> {
  const task = (pending.get(workspace) ?? Promise.resolve()).then(() =>
    appendEvent(workspace, event),
  );
  pending.set(workspace, task);
  try {
    await task;
  } finally {
    if (pending.get(workspace) === task) pending.delete(workspace);
  }
}

async function appendEvent(workspace: string, event: FileEvent): Promise<void> {
  const folder = join(workspace, '.pero');
  const file = join(folder, 'file-events.jsonl');
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (((await stat(file).catch(() => null))?.size ?? 0) > 2 * 1024 * 1024) {
      await rename(file, join(folder, 'file-events.previous.jsonl'));
    }
    await appendFile(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostic storage must not break a transfer. */
  }
}
