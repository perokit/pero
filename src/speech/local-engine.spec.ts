import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalSynthesizer,
  LocalTranscriber,
  localProblem,
  wavDuration,
  whisperText,
} from './local-engine.js';
import { SpeechError } from './speech-engine.js';

/** A PCM WAV header for `bytes` of sound at `byteRate`, then the sound. */
function wav(bytes: number, byteRate = 32_000): Uint8Array {
  const data = new Uint8Array(44 + bytes);
  const view = new DataView(data.buffer);
  const text = (offset: number, value: string) =>
    data.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint32(28, byteRate, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  return data;
}

describe('whisperText', () => {
  it('joins the segments and leaves out markers for no words', () => {
    expect(
      whisperText(
        '\n [BLANK_AUDIO]\n Remind me to call Ana\n tomorrow at ten.\n (music)\n',
      ),
    ).toBe('Remind me to call Ana tomorrow at ten.');
    expect(whisperText(' [BLANK_AUDIO]\n')).toBe('');
  });
});

describe('wavDuration', () => {
  it('reads the length from the header', () => {
    expect(wavDuration(wav(96_000))).toBe(3);
    expect(wavDuration(wav(100))).toBe(1);
  });

  it('takes the sound there is when the size is a placeholder', () => {
    const streamed = wav(64_000);
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDuration(streamed)).toBe(2);
  });

  it('is null for anything else', () => {
    expect(wavDuration(new Uint8Array(10))).toBeNull();
    expect(wavDuration(new TextEncoder().encode('x'.repeat(64)))).toBeNull();
  });
});

describe('the local engine', () => {
  let folder: string;

  /** A program in `folder` that runs `script` with sh. */
  function program(name: string, script: string): string {
    const path = join(folder, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** An ffmpeg that copies its input to its last argument. */
  function ffmpeg(): string {
    return program(
      'ffmpeg',
      [
        'echo "$@" >> "$(dirname "$0")/ffmpeg.args"',
        'while [ "$1" != "-i" ]; do shift; done',
        'input="$2"',
        'for last; do :; done',
        'cp "$input" "$last"',
      ].join('\n'),
    );
  }

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pero-local-engine-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('transcribes with whisper.cpp after converting to WAV', async () => {
    const whisper = program(
      'whisper-cli',
      'echo "$@" > "$(dirname "$0")/whisper.args"\necho " Hello there."',
    );
    const voice = join(folder, 'voice.ogg');
    writeFileSync(voice, 'ogg');
    const transcriber = new LocalTranscriber(
      { ffmpeg: ffmpeg(), whisper },
      '/models/ggml-base.bin',
      null,
    );

    await expect(
      transcriber.transcribe(
        { path: voice, type: 'audio/ogg' },
        new AbortController().signal,
      ),
    ).resolves.toBe('Hello there.');
    expect(readFileSync(join(folder, 'ffmpeg.args'), 'utf8')).toContain(
      `-i ${voice} -vn -t 3601 -ar 16000 -ac 1 -c:a pcm_s16le`,
    );
    expect(readFileSync(join(folder, 'whisper.args'), 'utf8')).toMatch(
      /^-m \/models\/ggml-base\.bin -f \S+input\.wav -l auto --no-timestamps --no-prints$/m,
    );
  });

  it('uses a configurable processing budget and can cancel a long Whisper run', async () => {
    const voice = join(folder, 'voice.ogg');
    writeFileSync(voice, 'ogg');
    const slow = program('whisper-cli', 'exec sleep 3');
    const limited = new LocalTranscriber(
      { ffmpeg: ffmpeg(), whisper: slow },
      '/model.bin',
      null,
      30,
    );
    await expect(
      limited.transcribe(
        { path: voice, type: 'audio/ogg' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('took longer than 0.03 s');
    const controller = new AbortController();
    const pending = new LocalTranscriber(
      { ffmpeg: ffmpeg(), whisper: slow },
      '/model.bin',
      null,
      10000,
    ).transcribe({ path: voice, type: 'audio/ogg' }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow('was stopped');
  });

  it('checks actual WAV duration when the sender did not supply it', async () => {
    const voice = join(folder, 'voice.wav');
    writeFileSync(voice, wav(96000));
    const whisper = program('whisper-cli', 'echo unexpected');
    const transcriber = new LocalTranscriber(
      { ffmpeg: ffmpeg(), whisper },
      '/model.bin',
      null,
      1000,
      1000,
      2,
    );
    await expect(
      transcriber.transcribe(
        { path: voice, type: 'audio/wav' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('longer than');
  });

  it('speaks with Piper, then encodes OGG with Opus', async () => {
    const header = Buffer.from(wav(64_000)).toString('base64');
    const piper = program(
      'piper',
      [
        'cat > "$(dirname "$0")/piper.input"',
        `echo ${header} | base64 -d > "$4"`,
      ].join('\n'),
    );
    const synthesizer = new LocalSynthesizer(
      { ffmpeg: ffmpeg(), piper },
      '/models/voice.onnx',
    );

    const speech = await synthesizer.synthesize(
      'Good morning.\n\nTwo meetings.',
      new AbortController().signal,
    );

    expect(speech.type).toBe('audio/ogg');
    expect(speech.durationS).toBe(2);
    expect(speech.audio.length).toBe(44 + 64_000);
    expect(readFileSync(join(folder, 'piper.input'), 'utf8')).toBe(
      'Good morning. Two meetings.',
    );
    expect(readFileSync(join(folder, 'ffmpeg.args'), 'utf8')).toContain(
      '-c:a libopus -b:a 32k -ac 1 -ar 48000 -application voip',
    );
  });

  it('names a program that fails, or is missing', async () => {
    const whisper = program(
      'whisper-cli',
      [
        `echo "error: model file not found 'm'" >&2`,
        'echo "usage: whisper-cli [options]" >&2',
        'exit 2',
      ].join('\n'),
    );
    const voice = join(folder, 'voice.ogg');
    writeFileSync(voice, 'ogg');
    const file = { path: voice, type: 'audio/ogg' };
    const signal = new AbortController().signal;

    await expect(
      new LocalTranscriber({ ffmpeg: ffmpeg(), whisper }, 'm', 'en').transcribe(
        file,
        signal,
      ),
    ).rejects.toThrow(
      new SpeechError("whisper-cli failed: error: model file not found 'm'"),
    );
    await expect(
      new LocalTranscriber(
        { ffmpeg: join(folder, 'nope', 'ffmpeg'), whisper },
        'm',
        'en',
      ).transcribe(file, signal),
    ).rejects.toThrow(new SpeechError("ffmpeg isn't installed"));
  });

  it('says what is missing before it runs', () => {
    const tool = program('tool', 'true');
    const model = join(folder, 'model.bin');

    expect(localProblem([tool], [model])).toBe(
      `${model} is missing; run pero speech`,
    );
    expect(localProblem(['pero-no-such-program'], [])).toBe(
      "pero-no-such-program isn't installed; run pero speech",
    );
    writeFileSync(model, '');
    expect(localProblem([tool], [model])).toBeNull();
  });
});
