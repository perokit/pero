import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceLayout } from '../config/workspace-layout.js';
import { findProgram, runProgram } from './run-program.js';
import {
  type AudioFile,
  type SpeechAudio,
  SpeechError,
  type Synthesizer,
  type Transcriber,
} from './speech-engine.js';

/** How long converting or recording a message may take. */
const CONVERT_TIMEOUT_MS = 60_000;
/** How long transcribing may take: whisper.cpp on a small CPU is slow. */
const TRANSCRIBE_TIMEOUT_MS = 60 * 60_000;

/** The programs the `local` engine runs, by name or path. */
export interface LocalPrograms {
  ffmpeg: string;
  whisper: string;
  piper: string;
}

/** What `pero speech configure` suggests for a program that is missing. */
export const INSTALL_HINTS: Record<keyof LocalPrograms, string> = {
  ffmpeg:
    'install ffmpeg with your package manager, such as apt install ffmpeg',
  whisper:
    'build whisper.cpp (https://github.com/ggml-org/whisper.cpp) and put whisper-cli on PATH, or brew install whisper-cpp',
  piper:
    'install Piper (https://github.com/OHF-Voice/piper1-gpl), such as pipx install piper-tts',
};

/**
 * `programs` as the `local` engine runs them in `workspace`: one named
 * without a path runs from `.pero/tools/bin/` when `pero speech configure`
 * installed it there, else from `PATH`.
 */
export function localPrograms(
  programs: LocalPrograms,
  workspace: string,
): LocalPrograms {
  const bin = join(workspaceLayout(workspace).tools, 'bin');
  const resolve = (program: string): string => {
    if (program.includes('/')) return program;
    return findProgram(program, bin) ?? program;
  };
  return {
    ffmpeg: resolve(programs.ffmpeg),
    whisper: resolve(programs.whisper),
    piper: resolve(programs.piper),
  };
}

/**
 * Why the `local` engine can't run `programs` with `files`, or null when
 * it can: the first program missing from `PATH`, or the first model file
 * that isn't there.
 */
export function localProblem(
  programs: readonly string[],
  files: readonly string[],
): string | null {
  for (const program of programs) {
    if (findProgram(program) === null) {
      return `${program} isn't installed; run pero speech`;
    }
  }
  for (const file of files) {
    if (!existsSync(file)) {
      return `${file} is missing; run pero speech`;
    }
  }
  return null;
}

/**
 * Transcribes with whisper.cpp, after ffmpeg converts the message to the
 * 16 kHz WAV it reads.
 */
export class LocalTranscriber implements Transcriber {
  constructor(
    private readonly programs: Pick<LocalPrograms, 'ffmpeg' | 'whisper'>,
    /** The whisper.cpp model file. */
    private readonly model: string,
    /** Such as `en`; null to detect the language. */
    private readonly language: string | null,
    private readonly timeoutMs: number = TRANSCRIBE_TIMEOUT_MS,
    private readonly convertTimeoutMs: number = 300_000,
    private readonly maxDurationS: number = 3600,
  ) {}

  async transcribe(file: AudioFile, signal: AbortSignal): Promise<string> {
    return withTempFolder(async (folder) => {
      const wav = join(folder, 'input.wav');
      await runProgram(
        this.programs.ffmpeg,
        [
          ...FFMPEG_QUIET,
          '-i',
          file.path,
          '-vn',
          '-t',
          String(this.maxDurationS + 1),
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        { signal, timeoutMs: this.convertTimeoutMs },
      );
      const seconds = await pcmDuration(wav);
      if (seconds !== null && seconds > this.maxDurationS) {
        throw new SpeechError(
          `it is longer than ${Math.round(this.maxDurationS / 60)} minutes`,
        );
      }
      const printed = await runProgram(
        this.programs.whisper,
        [
          '-m',
          this.model,
          '-f',
          wav,
          '-l',
          this.language ?? 'auto',
          '--no-timestamps',
          '--no-prints',
        ],
        { signal, timeoutMs: this.timeoutMs },
      );
      return whisperText(printed);
    });
  }
}

/** Read only the WAV header, not hours of PCM audio into memory. */
async function pcmDuration(path: string): Promise<number | null> {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    if (
      data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE'
    )
      return null;
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= bytesRead;) {
      const size = data.readUInt32LE(offset + 4);
      if (
        data.toString('ascii', offset, offset + 4) === 'fmt ' &&
        offset + 20 <= bytesRead
      )
        byteRate = data.readUInt32LE(offset + 16);
      if (
        data.toString('ascii', offset, offset + 4) === 'data' &&
        byteRate > 0
      ) {
        return Math.max(0, ((await file.stat()).size - offset - 8) / byteRate);
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  } finally {
    await file.close();
  }
}

/** Speaks with Piper, then has ffmpeg encode the WAV as OGG with Opus. */
export class LocalSynthesizer implements Synthesizer {
  constructor(
    private readonly programs: Pick<LocalPrograms, 'ffmpeg' | 'piper'>,
    /** The Piper voice's `.onnx` file. */
    private readonly voice: string,
  ) {}

  async synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio> {
    return withTempFolder(async (folder) => {
      const wav = join(folder, 'speech.wav');
      const ogg = join(folder, 'speech.ogg');
      await runProgram(
        this.programs.piper,
        ['-m', this.voice, '-f', wav],
        // Piper reads a line as one utterance; one line keeps one file.
        {
          input: text.replace(/\s+/g, ' ').trim(),
          signal,
          timeoutMs: CONVERT_TIMEOUT_MS,
        },
      );
      const durationS = wavDuration(await readFile(wav));
      await runProgram(
        this.programs.ffmpeg,
        [
          ...FFMPEG_QUIET,
          '-i',
          wav,
          '-c:a',
          'libopus',
          '-b:a',
          '32k',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-application',
          'voip',
          ogg,
        ],
        { signal, timeoutMs: CONVERT_TIMEOUT_MS },
      );
      return {
        audio: new Uint8Array(await readFile(ogg)),
        type: 'audio/ogg',
        durationS,
      };
    });
  }
}

const FFMPEG_QUIET = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];

/**
 * whisper.cpp's printed transcript as one text: its segments joined, and
 * markers such as `[BLANK_AUDIO]` or `(music)` for no words left out.
 */
export function whisperText(printed: string): string {
  return printed
    .split('\n')
    .map((line) =>
      line
        .replace(/\[[A-Z_ ]+\]/g, '')
        .replace(/^\s*\([^)]*\)\s*$/, '')
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' ');
}

/** A PCM WAV file's length in whole seconds; null when it isn't one. */
export function wavDuration(wav: Uint8Array): number | null {
  if (wav.length < 44) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let byteRate: number | null = null;
  // Chunks follow the header: `fmt ` carries the byte rate, `data` the sound.
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === 'fmt ' && offset + 16 <= wav.length) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (tag(offset) === 'data') {
      if (!byteRate) return null;
      // Piper streams its WAV, so the size may be a placeholder.
      const bytes = Math.min(size, wav.length - offset - 8);
      return Math.max(1, Math.round(bytes / byteRate));
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function withTempFolder<T>(
  use: (folder: string) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'pero-speech-'));
  try {
    return await use(folder);
  } catch (error) {
    if (error instanceof SpeechError) throw error;
    throw new SpeechError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
