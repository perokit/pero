import { Injectable } from '@nestjs/common';
import { constants, createReadStream } from 'node:fs';
import { mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFileEvent } from '../common/file-events.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { runProgram } from '../speech/run-program.js';
import { localPrograms } from '../speech/local-engine.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  OutboundFile,
  SentMessage,
} from './channel-adapter.js';

/** Files are delivered from the approved working folder or the owner's vault. */
@Injectable()
export class FileDelivery {
  constructor(private readonly config: HostConfigService) {}

  async deliver(
    adapter: ChannelAdapter,
    address: ChannelAddress,
    reference: string,
    workingDirectory?: string,
  ): Promise<{ sent: SentMessage; text: string }> {
    if (adapter.sendFile === undefined)
      throw new Error('This integration cannot send files');
    const { workspace, dataFolder } = this.config.folders();
    const roots = [workingDirectory ?? workspace, dataFolder];
    const candidate = resolve(workingDirectory ?? workspace, reference);
    const path = await realpath(candidate);
    let permitted = false;
    for (const folder of roots) {
      const root = await realpath(folder).catch(() => null);
      if (root === null) continue;
      const inside = relative(root, path);
      if (
        inside !== '' &&
        !isAbsolute(inside) &&
        !inside
          .split(/[\\/]/)
          .some((part) => part === '..' || part.startsWith('.')) &&
        !/(?:^|[\\/])(?:credentials|auth|secrets)(?:[.\\/]|$)/i.test(inside)
      )
        permitted = true;
    }
    if (!permitted)
      throw new Error(
        'File is outside the approved working folder/vault, or is hidden/private',
      );
    // Pin the inode and reject a final-component symlink; uploads never reopen the agent's path.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const started = Date.now();
    const name = basename(path);
    let bytes = 0;
    let folder: string | undefined;
    let status: 'ok' | 'failed' = 'failed';
    try {
      folder = await mkdtemp(join(tmpdir(), 'pero-result-'));
      const info = await handle.stat();
      bytes = info.size;
      if (
        !info.isFile() ||
        bytes === 0 ||
        bytes > this.config.files().maxMb * 1024 * 1024
      )
        throw new Error(
          'Result is empty, not a regular file, or exceeds files.max-mb',
        );
      const ext = extname(name).toLowerCase();
      const kind = fileKind(ext);
      let first: SentMessage | undefined;
      let warning = '';
      if (
        this.config.files().previews &&
        ['.html', '.htm', '.svg'].includes(ext)
      ) {
        const previewStarted = Date.now();
        try {
          if (bytes > 8 * 1024 * 1024)
            throw new Error('Design source exceeds the 8 MiB preview limit');
          const source = join(folder, `source${ext}`);
          const { saveStream } = await import('../common/file-transfer.js');
          await saveStream(
            source,
            createReadStream(path, {
              fd: handle.fd,
              autoClose: false,
              start: 0,
              end: bytes - 1,
            }),
            8 * 1024 * 1024,
          );
          const preview = join(folder, 'preview.png');
          await runProgram(
            process.execPath,
            [
              fileURLToPath(new URL('./preview-worker.js', import.meta.url)),
              source,
              preview,
              path,
            ],
            { signal: new AbortController().signal, timeoutMs: 45_000 },
          );
          const size = (await stat(preview)).size;
          if (size > 10 * 1024 * 1024)
            throw new Error('Preview exceeds Telegram photo limit');
          first = await adapter.sendFile(address, {
            source: () => createReadStream(preview),
            name: `${name}.png`,
            size,
            kind: 'photo',
            caption: `Preview: ${name}`,
          });
          await recordFileEvent(workspace, {
            operation: 'preview',
            name,
            bytes: size,
            elapsedMs: Date.now() - previewStarted,
            status: 'ok',
          });
        } catch {
          warning =
            ' Preview unavailable; install Chromium with `npx playwright install chromium`, or provide a PNG/JPEG preview.';
          await recordFileEvent(workspace, {
            operation: 'preview',
            name,
            bytes,
            elapsedMs: Date.now() - previewStarted,
            status: 'failed',
          });
        }
      }
      if (['.wav', '.flac', '.aiff'].includes(ext)) {
        try {
          // Input is a snapshot of the already validated inode, not a newly resolved path.
          const source = join(folder, `audio${ext}`);
          const output = join(folder, 'preview.mp3');
          const { saveStream } = await import('../common/file-transfer.js');
          await saveStream(
            source,
            createReadStream(path, {
              fd: handle.fd,
              autoClose: false,
              start: 0,
              end: bytes - 1,
            }),
            bytes,
          );
          const ffmpeg = localPrograms(
            this.config.speech().programs,
            workspace,
          ).ffmpeg;
          await runProgram(
            ffmpeg,
            [
              '-nostdin',
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-i',
              source,
              '-vn',
              '-c:a',
              'libmp3lame',
              '-b:a',
              '128k',
              output,
            ],
            {
              signal: new AbortController().signal,
              timeoutMs:
                this.config.speech().transcribe.convertTimeoutSeconds * 1000,
            },
          );
          const size = (await stat(output)).size;
          if (size > this.config.files().maxMb * 1024 * 1024)
            throw new Error('Audio preview is too large');
          first ??= await adapter.sendFile(address, {
            source: () => createReadStream(output),
            name: `${name}.mp3`,
            size,
            kind: 'audio',
            caption: `Audio preview: ${name}`,
          });
        } catch {
          warning +=
            ' Audio preview unavailable; original attached as a document.';
        }
      }
      const sent = await adapter.sendFile(address, {
        source: () =>
          createReadStream(path, {
            fd: handle.fd,
            autoClose: false,
            start: 0,
            end: bytes - 1,
          }),
        name,
        size: bytes,
        kind,
        caption: name,
      });
      status = 'ok';
      return {
        sent: first ?? sent,
        text: `[File delivered: ${name}, ${bytes} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s]${warning}`,
      };
    } finally {
      await handle.close();
      if (folder !== undefined)
        await rm(folder, { recursive: true, force: true });
      await recordFileEvent(workspace, {
        operation: 'upload',
        name,
        bytes,
        elapsedMs: Date.now() - started,
        status,
      });
    }
  }
}

function fileKind(ext: string): OutboundFile['kind'] {
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'photo';
  if (['.mp3', '.m4a'].includes(ext)) return 'audio';
  if (['.ogg', '.opus'].includes(ext)) return 'voice';
  if (ext === '.mp4') return 'video';
  return 'document';
}
