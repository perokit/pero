import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recordFileEvent } from './file-events.js';

it('serializes concurrent rotation, preserving metadata and owner-only permissions', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pero-events-'));
  try {
    await mkdir(join(folder, '.pero'));
    const path = join(folder, '.pero/file-events.jsonl');
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
    await Promise.all(
      Array.from({ length: 12 }, (_, bytes) =>
        recordFileEvent(folder, {
          operation: 'download',
          name: 'input.zip',
          bytes,
          elapsedMs: 42,
          status: 'ok',
        }),
      ),
    );
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(12);
    expect(
      lines.map((line) => (JSON.parse(line) as { bytes: number }).bytes),
    ).toEqual(Array.from({ length: 12 }, (_, n) => n));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(folder, '.pero/file-events.previous.jsonl'))).size,
    ).toBe(2 * 1024 * 1024 + 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
