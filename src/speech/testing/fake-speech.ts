import { readFile } from 'node:fs/promises';
import type { AudioFile, SpeechAudio } from '../speech-engine.js';
import { SpeechError } from '../speech-engine.js';
import type { SpeechService } from '../speech.service.js';

/**
 * Speech for tests, in place of `SpeechService`: it "transcribes" a file
 * as its own text and "records" text as its bytes. `transcribeFails` and
 * `speakFails` make either fail with that reason; `spoken` records what
 * was recorded.
 */
export class FakeSpeech implements Pick<
  SpeechService,
  | 'maxDurationS'
  | 'transcribeProblem'
  | 'speakProblem'
  | 'canSpeak'
  | 'transcribe'
  | 'speak'
> {
  transcribeFails: string | null = null;
  speakFails: string | null = null;
  maxS = 600;
  readonly transcribed: AudioFile[] = [];
  readonly spoken: string[] = [];

  maxDurationS(): number {
    return this.maxS;
  }

  transcribeProblem(): string | null {
    return this.transcribeFails;
  }

  speakProblem(): string | null {
    return this.speakFails;
  }

  canSpeak(): boolean {
    return this.speakFails === null;
  }

  async transcribe(file: AudioFile, _signal?: AbortSignal): Promise<string> {
    if (this.transcribeFails !== null) {
      throw new SpeechError(this.transcribeFails);
    }
    this.transcribed.push(file);
    return (await readFile(file.path, 'utf8')).trim();
  }

  speak(text: string): Promise<SpeechAudio> {
    if (this.speakFails !== null) {
      return Promise.reject(new SpeechError(this.speakFails));
    }
    this.spoken.push(text);
    return Promise.resolve({
      audio: new TextEncoder().encode(text),
      type: 'audio/ogg',
      durationS: 1,
    });
  }
}
