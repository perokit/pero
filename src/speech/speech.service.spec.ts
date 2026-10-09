import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SPEECH, type SpeechConfig } from '../config/host-config.js';
import { ComponentHealth } from '../health/component-health.js';
import type { HostConfigService } from '../host-config/host-config.service.js';
import { SpeechError } from './speech-engine.js';
import { MAX_VOICE_CHARACTERS, SpeechService } from './speech.service.js';

describe('SpeechService', () => {
  let workspace: string;
  let speech: SpeechConfig;
  let health: ComponentHealth;

  function service(env: NodeJS.ProcessEnv = {}): SpeechService {
    const hostConfig = {
      speech: () => speech,
      folders: () => ({ workspace }),
    } as unknown as HostConfigService;
    const created = new SpeechService(hostConfig, health, { env });
    created.onModuleInit();
    return created;
  }

  function program(name: string): string {
    const path = join(workspace, 'bin', name);
    mkdirSync(join(workspace, 'bin'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-speech-'));
    speech = structuredClone(DEFAULT_SPEECH);
    speech.programs = {
      ffmpeg: join(workspace, 'bin', 'ffmpeg'),
      whisper: join(workspace, 'bin', 'whisper-cli'),
      piper: join(workspace, 'bin', 'piper'),
    };
    health = new ComponentHealth();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('says what the local engine is missing, as optional', () => {
    const speaking = service();

    expect(speaking.transcribeProblem()).toBe(
      `${speech.programs.ffmpeg} isn't installed; run pero speech`,
    );
    expect(speaking.canSpeak()).toBe(false);
    expect(health.get('speech')).toMatchObject({
      state: 'unconfigured',
      required: false,
    });
  });

  it('works locally once the programs and models are there', () => {
    program('ffmpeg');
    program('whisper-cli');
    program('piper');
    const models = join(workspace, '.pero', 'models');
    mkdirSync(models, { recursive: true });
    for (const file of [
      'ggml-base.bin',
      'en_US-lessac-medium.onnx',
      'en_US-lessac-medium.onnx.json',
    ]) {
      writeFileSync(join(models, file), '');
    }

    const speaking = service();

    expect(speaking.transcribeProblem()).toBeNull();
    expect(speaking.canSpeak()).toBe(true);
    expect(health.get('speech')).toMatchObject({
      state: 'ok',
      detail: 'transcribe: local; speak: local',
      required: false,
    });
  });

  it('reports a direction that works and one that does not as degraded', () => {
    speech.transcribe.engine = 'elevenlabs';
    service({ ELEVENLABS_API_KEY: 'key' });

    expect(health.get('speech')).toMatchObject({
      state: 'degraded',
      detail: `${speech.programs.piper} isn't installed; run pero speech`,
    });
  });

  it("finds ElevenLabs' key in the environment or in .env", () => {
    speech.transcribe.engine = 'elevenlabs';
    speech.speak.engine = 'elevenlabs';

    expect(service().speakProblem()).toBe(
      'no ElevenLabs API key is set; run pero speech',
    );
    expect(service({ ELEVENLABS_API_KEY: 'key' }).canSpeak()).toBe(true);
    writeFileSync(join(workspace, '.env'), 'ELEVENLABS_API_KEY=key\n', {
      mode: 0o600,
    });
    expect(service().canSpeak()).toBe(true);
    expect(health.get('speech')).toMatchObject({
      state: 'ok',
      detail: 'transcribe: elevenlabs; speak: elevenlabs',
    });
  });

  it('refuses what is off, or too long to speak', async () => {
    speech.transcribe.engine = 'off';
    speech.speak.engine = 'off';
    const speaking = service();

    expect(health.get('speech')).toMatchObject({
      state: 'unconfigured',
      detail: 'Voice messages are off',
    });
    await expect(
      speaking.transcribe({ path: 'voice.ogg', type: 'audio/ogg' }),
    ).rejects.toThrow(
      new SpeechError(
        'transcription is turned off; pero speech configure turns it on',
      ),
    );
    await expect(speaking.speak('Hi.')).rejects.toThrow(
      new SpeechError(
        'voice messages are turned off; pero speech configure turns them on',
      ),
    );

    speech.speak.engine = 'elevenlabs';
    const keyed = service({ ELEVENLABS_API_KEY: 'key' });
    await expect(
      keyed.speak('a'.repeat(MAX_VOICE_CHARACTERS + 1)),
    ).rejects.toThrow(new SpeechError('it is longer than 4,000 characters'));
    expect(keyed.maxDurationS()).toBe(3600);
  });
});
