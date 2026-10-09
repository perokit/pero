import {
  Inject,
  Injectable,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SpeechConfig } from '../config/host-config.js';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import {
  ElevenLabsSynthesizer,
  ElevenLabsTranscriber,
} from './elevenlabs-engine.js';
import {
  LocalSynthesizer,
  LocalTranscriber,
  localPrograms,
} from './local-engine.js';
import {
  type AudioFile,
  type SpeechAudio,
  SpeechError,
  type Synthesizer,
  type Transcriber,
} from './speech-engine.js';
import {
  ELEVENLABS_DEFAULTS,
  piperVoicePath,
  whisperModelPath,
} from './speech-models.js';
import {
  elevenLabsKey,
  speakProblem,
  transcribeProblem,
} from './speech-readiness.js';

export const SPEECH_OPTIONS = Symbol('SPEECH_OPTIONS');

export interface SpeechOptions {
  /** Where `ELEVENLABS_API_KEY` may come from before `.env`. */
  env?: NodeJS.ProcessEnv;
  /** ElevenLabs' API server; its own unless set. */
  elevenLabsApiRoot?: string;
}

/** How often the `speech` component is checked again. */
export const SPEECH_TICK_MS = 60_000;

/**
 * The longest text recorded as one voice message: ElevenLabs' limit for
 * one request, and some four minutes of speech.
 */
export const MAX_VOICE_CHARACTERS = 4_000;

/**
 * Speech as `config.yaml`'s `speech` sets it: transcribing the voice
 * messages people send, and recording the ones Pero sends. Each use reads
 * the settings afresh, so an edit applies from the next message. The
 * `speech` component of `pero status` says whether each works; it is
 * optional, so Pero is healthy without it.
 */
@Injectable()
export class SpeechService implements OnModuleInit {
  private readonly env: NodeJS.ProcessEnv;
  private readonly apiRoot: string | undefined;

  constructor(
    private readonly hostConfig: HostConfigService,
    private readonly health: ComponentHealth,
    @Optional() @Inject(SPEECH_OPTIONS) options: SpeechOptions | null = null,
  ) {
    this.env = options?.env ?? process.env;
    this.apiRoot = options?.elevenLabsApiRoot;
  }

  onModuleInit(): void {
    this.reportHealth();
  }

  @Interval('speech', SPEECH_TICK_MS)
  onInterval(): void {
    this.reportHealth();
  }

  /** The longest voice message transcribed, in seconds. */
  maxDurationS(): number {
    return Math.round(this.config().transcribe.maxMinutes * 60);
  }

  /** Why voice messages can't be transcribed now; null when they can. */
  transcribeProblem(): string | null {
    return transcribeProblem(this.config(), this.workspace(), this.key());
  }

  /** Why Pero can't record voice messages now; null when it can. */
  speakProblem(): string | null {
    return speakProblem(this.config(), this.workspace(), this.key());
  }

  /** Whether Pero can record voice messages now. */
  canSpeak(): boolean {
    return this.speakProblem() === null;
  }

  /**
   * The words spoken in `file`. Throws a `SpeechError` saying why when
   * they can't be had.
   */
  async transcribe(
    file: AudioFile,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    const problem = this.transcribeProblem();
    if (problem !== null) throw new SpeechError(problem);
    return this.transcriber().transcribe(file, signal);
  }

  /** `text`, recorded. Throws a `SpeechError` saying why it can't be. */
  async speak(
    text: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SpeechAudio> {
    const problem = this.speakProblem();
    if (problem !== null) throw new SpeechError(problem);
    if (text.length > MAX_VOICE_CHARACTERS) {
      throw new SpeechError(
        `it is longer than ${MAX_VOICE_CHARACTERS.toLocaleString('en-US')} characters`,
      );
    }
    return this.synthesizer().synthesize(text, signal);
  }

  private transcriber(): Transcriber {
    const speech = this.config();
    const { engine, model, language } = speech.transcribe;
    if (engine === 'elevenlabs') {
      return new ElevenLabsTranscriber({
        key: () => this.key(),
        model: model ?? ELEVENLABS_DEFAULTS.transcribeModel,
        language,
        ...(this.apiRoot === undefined ? {} : { apiRoot: this.apiRoot }),
      });
    }
    return new LocalTranscriber(
      localPrograms(speech.programs, this.workspace()),
      whisperModelPath(speech, this.workspace()),
      language,
      speech.transcribe.timeoutSeconds * 1000,
      speech.transcribe.convertTimeoutSeconds * 1000,
      speech.transcribe.maxMinutes * 60,
    );
  }

  private synthesizer(): Synthesizer {
    const speech = this.config();
    const { engine, voice, model } = speech.speak;
    if (engine === 'elevenlabs') {
      return new ElevenLabsSynthesizer({
        key: () => this.key(),
        voice: voice ?? ELEVENLABS_DEFAULTS.voice,
        model: model ?? ELEVENLABS_DEFAULTS.speakModel,
        ...(this.apiRoot === undefined ? {} : { apiRoot: this.apiRoot }),
      });
    }
    return new LocalSynthesizer(
      localPrograms(speech.programs, this.workspace()),
      piperVoicePath(speech, this.workspace()),
    );
  }

  private config(): SpeechConfig {
    return this.hostConfig.speech();
  }

  private workspace(): string {
    return this.hostConfig.folders().workspace;
  }

  /** The ElevenLabs key, looked up afresh so a new one applies at once. */
  private key(): string | null {
    return elevenLabsKey(this.workspace(), this.env);
  }

  /** `speech`: which directions work, and why the others don't. */
  private reportHealth(): void {
    const speech = this.config();
    const directions = [
      ['transcribe', speech.transcribe.engine, this.transcribeProblem()],
      ['speak', speech.speak.engine, this.speakProblem()],
    ] as const;
    const on = directions.filter(([, engine]) => engine !== 'off');
    const failing = on.filter(([, , problem]) => problem !== null);
    if (on.length === 0) {
      this.health.report('speech', 'unconfigured', 'Voice messages are off');
    } else if (failing.length === 0) {
      this.health.report(
        'speech',
        'ok',
        on.map(([name, engine]) => `${name}: ${engine}`).join('; '),
      );
    } else {
      const problems = [
        ...new Set(failing.map(([, , problem]) => problem!)),
      ].join('; ');
      this.health.report(
        'speech',
        failing.length === on.length ? 'unconfigured' : 'degraded',
        problems,
      );
    }
    this.health.setRequired('speech', false);
  }
}
