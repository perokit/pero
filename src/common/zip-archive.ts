import { mkdtemp, rm } from 'node:fs/promises';
import { runProgram } from '../speech/run-program.js';

/** Extract ZIPs without executing their contents. Python 3 provides ZIP64 and CRC validation. */
export async function extractArchive(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ directory: string; files: number; bytes: number }> {
  const directory = await mkdtemp(`${path}.contents-`);
  try {
    const output = await runProgram(
      'python3',
      [
        '-c',
        ZIP_SCRIPT,
        path,
        directory,
        String(Math.min(2 * 1024 ** 3, maxBytes * 4)),
      ],
      { signal: signal ?? new AbortController().signal, timeoutMs: 300_000 },
    );
    const result = JSON.parse(output) as { files: number; bytes: number };
    return { directory, ...result };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const ZIP_SCRIPT = String.raw`import json, os, pathlib, stat, sys, zipfile
archive, destination, maximum = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])
if not destination.is_dir() or any(destination.iterdir()):
    raise ValueError("Extraction directory must be empty")
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) > 10000:
        raise ValueError("ZIP has more than 10000 entries")
    planned, total, seen = [], 0, set()
    for entry in entries:
        name = entry.filename
        parts = name.rstrip('/').split('/')
        mode = entry.external_attr >> 16
        if not name or '\\' in name or any(p in ('', '.', '..') or ':' in p or '\x00' in p for p in parts):
            raise ValueError("Unsafe ZIP path")
        if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError("ZIP links and special files are not supported")
        if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("Encrypted or unsupported ZIP entry")
        key = '/'.join(parts).casefold()
        if key in seen:
            raise ValueError("Duplicate ZIP path")
        seen.add(key)
        total += entry.file_size
        if total > maximum or entry.file_size > max(entry.compress_size, 1) * 1000:
            raise ValueError("ZIP exceeds unpacked size or compression ratio limit")
        planned.append((entry, destination.joinpath(*parts)))
    actual = 0
    for entry, target in planned:
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with source.open(entry) as incoming, target.open('xb') as outgoing:
            os.chmod(target, 0o600)
            while True:
                chunk = incoming.read(1024 * 1024)
                if not chunk:
                    break
                actual += len(chunk)
                if actual > maximum:
                    raise ValueError("ZIP exceeds actual unpacked byte limit")
                outgoing.write(chunk)
    print(json.dumps({'files': len(entries), 'bytes': actual}))
`;
