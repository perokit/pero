import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProgram } from '../speech/run-program.js';
import { extractArchive } from './zip-archive.js';

const python = findProgram('python3');
describe.skipIf(python === null)('ZIP intake', () => {
  async function archiveTest(
    name: string,
    mode: string,
    check: (file: string, root: string) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'pero-zip-test-'));
    const file = join(root, 'input.zip');
    try {
      execFileSync(python!, [
        '-c',
        `import sys, zipfile, stat
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
 i=zipfile.ZipInfo(sys.argv[2]);i.compress_type=zipfile.ZIP_DEFLATED
 if sys.argv[3]=='link':i.external_attr=(stat.S_IFLNK|0o777)<<16
 z.writestr(i, b'x'*100000 if sys.argv[3]=='large' else b'hello')`,
        file,
        name,
        mode,
      ]);
      await check(file, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  it('extracts nested Unicode files and reports actual bytes', async () => {
    await archiveTest('notes/Заметка.txt', 'file', async (file) => {
      const result = await extractArchive(file, 1024);
      expect(result.files).toBe(1);
      expect(result.bytes).toBe(5);
      expect(
        await readFile(join(result.directory, 'notes/Заметка.txt'), 'utf8'),
      ).toBe('hello');
    });
  });
  for (const [name, mode] of [
    ['../outside.txt', 'file'],
    ['/absolute.txt', 'file'],
    ['folder\\outside.txt', 'file'],
    ['link', 'link'],
    ['large.txt', 'large'],
  ]) {
    it(`rejects unsafe/oversized entry ${name} and removes partial extraction`, async () => {
      await archiveTest(name!, mode!, async (file, root) => {
        await expect(extractArchive(file, 1024)).rejects.toThrow();
        expect(await readdir(root)).toEqual(['input.zip']);
      });
    });
  }
  it('cancels extraction and removes its working folder', async () => {
    await archiveTest('file.txt', 'file', async (file, root) => {
      await expect(
        extractArchive(file, 1024, AbortSignal.abort()),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual(['input.zip']);
    });
  });
});
