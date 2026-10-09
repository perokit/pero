import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './bootstrap-config.js';
import {
  allowChat,
  chatKindOf,
  DEFAULT_SPEECH,
  DEFAULT_FILES,
  defaultHostConfig,
  denyChat,
  editHostConfig,
  moveChatId,
  parseHostConfig,
  readHostConfig,
  resolveDataFolder,
  setSpeech,
  resolveSystemFolder,
} from './host-config.js';

/** Beyond 2^53, where a JavaScript number would lose the last digits. */
const BIG = '-1009007199254740993';

describe('parseHostConfig', () => {
  it('separates recording duration, processing time and file transport limits', () => {
    const config = parseHostConfig(
      'config.yaml',
      'files:\n  max-mb: 512\n  download-timeout-seconds: 900\n  telegram-api-root: http://127.0.0.1:8081\n  telegram-local-file-root: /srv/bot-api\nspeech:\n  transcribe:\n    max-minutes: 120\n    timeout-seconds: 7200\n',
    );
    expect(config.files).toMatchObject({
      maxMb: 512,
      downloadTimeoutSeconds: 900,
      telegramApiRoot: 'http://127.0.0.1:8081',
      telegramLocalFileRoot: '/srv/bot-api',
    });
    expect(config.speech.transcribe).toMatchObject({
      maxMinutes: 120,
      timeoutSeconds: 7200,
    });
    for (const text of [
      'files:\n  max-mb: 0',
      'speech:\n  transcribe:\n    timeout-seconds: 0',
      'files:\n  telegram-api-root: https://user:token@example.com',
    ])
      expect(() => parseHostConfig('config.yaml', text)).toThrow();
  });
  it('reads the data folder, system folder, and allowed chats', () => {
    const config = parseHostConfig(
      'config.yaml',
      [
        'data: ~/notes',
        'system: notes/System',
        'telegram:',
        '  allowed-chats:',
        `    - id: ${BIG}`,
        '      title: Home',
        '    - id: "123456789"',
      ].join('\n'),
    );

    expect(config).toEqual({
      data: '~/notes',
      system: 'notes/System',
      allowedChats: [
        { chatKey: BIG, title: 'Home' },
        { chatKey: '123456789', title: null },
      ],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    });
  });

  it('takes an empty file, and the template, as nothing set', () => {
    expect(parseHostConfig('config.yaml', '')).toEqual({
      data: null,
      system: null,
      allowedChats: [],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    });
    expect(parseHostConfig('config.yaml', defaultHostConfig())).toEqual({
      data: 'data',
      system: null,
      allowedChats: [],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    });
    expect(parseHostConfig('config.yaml', defaultHostConfig('2024'))).toEqual({
      data: '2024',
      system: null,
      allowedChats: [],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    });
  });

  it('reads speech, with a default for each setting left out', () => {
    const config = parseHostConfig(
      'config.yaml',
      [
        'speech:',
        '  transcribe:',
        '    engine: elevenlabs',
        '    language: de',
        '    max-minutes: 2.5',
        '  speak:',
        '    engine: off',
        '  programs:',
        '    whisper: /opt/whisper/whisper-cli',
      ].join('\n'),
    );

    expect(config.speech).toEqual({
      transcribe: {
        engine: 'elevenlabs',
        model: null,
        language: 'de',
        maxMinutes: 2.5,
        timeoutSeconds: 3600,
        convertTimeoutSeconds: 300,
      },
      speak: { engine: 'off', voice: null, model: null },
      programs: {
        ffmpeg: 'ffmpeg',
        whisper: '/opt/whisper/whisper-cli',
        piper: 'piper',
      },
    });
  });

  it('names a speech setting that is not valid', () => {
    expect(() =>
      parseHostConfig(
        'config.yaml',
        [
          'speech:',
          '  transcribe:',
          '    engine: openai',
          '    max-minutes: 0',
          '  speak:',
          '    pitch: high',
        ].join('\n'),
      ),
    ).toThrow(
      new ConfigError(
        [
          'Invalid config.yaml:',
          '  line 3: speech.transcribe.engine: must be one of local, elevenlabs, off',
          '  line 4: speech.transcribe.max-minutes: must be more than 0',
          '  line 6: speech.speak.pitch: unknown key',
        ].join('\n'),
      ),
    );
  });

  it('names the file, line, and key of each problem', () => {
    const parse = () =>
      parseHostConfig(
        '/ws/.pero/config.yaml',
        [
          'data: 5',
          'modle: x',
          'telegram:',
          '  allowed-chats:',
          '    - id: abc',
          '    - id: 1',
          '    - id: 1',
          '      name: Home',
        ].join('\n'),
      );

    expect(parse).toThrow(ConfigError);
    expect(parse).toThrow(
      [
        'Invalid /ws/.pero/config.yaml:',
        '  line 1: data: must be a folder path',
        '  line 5: telegram.allowed-chats (item 1).id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
        '  line 8: telegram.allowed-chats (item 3).name: unknown key',
        '  line 7: telegram.allowed-chats (item 3).id: 1 is listed twice',
        '  line 2: modle: unknown key',
      ].join('\n'),
    );
  });

  it('reports YAML that does not parse', () => {
    expect(() => parseHostConfig('config.yaml', 'data: [')).toThrow(
      /^Invalid config\.yaml:\n {2}line 1: /,
    );
    expect(() => parseHostConfig('config.yaml', '- data')).toThrow(
      'must be "key: value" lines',
    );
  });
});

describe('config.yaml on disk', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-host-config-'));
    file = join(tmp, 'config.yaml');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads nothing when there is no file', () => {
    expect(readHostConfig(file)).toBeNull();
  });

  it('starts a missing file from the template', () => {
    const config = editHostConfig(file, (document) => {
      allowChat(document, '123456789', null);
    });

    expect(config.allowedChats).toEqual([
      { chatKey: '123456789', title: null },
    ]);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("# Pero's host settings");
    expect(text).toContain('  allowed-chats:\n    - id: 123456789\n');
  });

  it('keeps comments, order, and hand edits through its own changes', () => {
    writeFileSync(
      file,
      [
        '# My Pero',
        'telegram:',
        '  allowed-chats:',
        '    - id: -100111   # the family group',
        '      title: Family',
        '',
        'data: vault # synced',
        '',
      ].join('\n'),
      { mode: 0o640 },
    );

    editHostConfig(file, (document) => allowChat(document, BIG, 'Home'));
    // Someone edits by hand between two of Pero's changes.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('Family', 'Family chat'),
    );
    editHostConfig(file, (document) => denyChat(document, BIG));

    expect(readFileSync(file, 'utf8')).toBe(
      [
        '# My Pero',
        'telegram:',
        '  allowed-chats:',
        '    - id: -100111 # the family group',
        '      title: Family chat',
        '',
        'data: vault # synced',
        '',
      ].join('\n'),
    );
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it('allows a chat once, adding a missing title', () => {
    writeFileSync(file, 'telegram:\n  allowed-chats:\n    - id: 5\n');
    let changes: boolean[] = [];

    editHostConfig(file, (document) => {
      changes = [
        allowChat(document, '5', null),
        allowChat(document, '5', 'Me'),
        allowChat(document, '5', 'Other'),
      ];
    });

    expect(changes).toEqual([false, true, false]);
    expect(readHostConfig(file)?.allowedChats).toEqual([
      { chatKey: '5', title: 'Me' },
    ]);
  });

  it('writes a list left empty as []', () => {
    writeFileSync(file, 'telegram:\n  allowed-chats:\n    - id: 5\n');

    editHostConfig(file, (document) => denyChat(document, '5'));

    expect(readFileSync(file, 'utf8')).toBe('telegram:\n  allowed-chats: []\n');
  });

  it('keeps every digit of a large ID it writes', () => {
    editHostConfig(file, (document) => allowChat(document, BIG, null));

    expect(readFileSync(file, 'utf8')).toContain(`- id: ${BIG}\n`);
    expect(readHostConfig(file)?.allowedChats[0]?.chatKey).toBe(BIG);
  });

  it('follows a chat to its new ID, or drops it when that is allowed too', () => {
    writeFileSync(
      file,
      'telegram:\n  allowed-chats:\n    - id: -1\n      title: Old\n    - id: -2\n',
    );

    let moved: boolean[] = [];
    editHostConfig(file, (document) => {
      moved = [
        moveChatId(document, '-1', '-1001'),
        moveChatId(document, '-2', '-1001'),
        moveChatId(document, '-3', '-1003'),
      ];
    });

    expect(moved).toEqual([true, true, false]);
    expect(readHostConfig(file)?.allowedChats).toEqual([
      { chatKey: '-1001', title: 'Old' },
    ]);
  });

  it('refuses to change a file that is not valid, leaving it as it is', () => {
    writeFileSync(file, 'dta: data\n');

    expect(() =>
      editHostConfig(file, (document) => allowChat(document, '5', null)),
    ).toThrow('line 1: dta: unknown key');
    expect(readFileSync(file, 'utf8')).toBe('dta: data\n');
  });
});

describe('setSpeech', () => {
  let folder: string;
  let file: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pero-speech-config-'));
    file = join(folder, 'config.yaml');
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("changes the template's engines in place, keeping its comments", () => {
    writeFileSync(file, defaultHostConfig());

    const config = editHostConfig(file, (document) => {
      expect(setSpeech(document, 'transcribe', 'elevenlabs')).toBe(true);
      expect(setSpeech(document, 'speak', 'local')).toBe(false);
    });

    expect(config.speech.transcribe.engine).toBe('elevenlabs');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('pero speech configure sets them');
    expect(text).toContain(
      'speech:\n  transcribe:\n    engine: elevenlabs\n  speak:\n    engine: local\n',
    );
  });

  it("drops the other engine's model and voice when the engine changes", () => {
    writeFileSync(
      file,
      [
        'speech:',
        '  speak:',
        '    engine: local',
        '    voice: voices/de.onnx',
        '    model: x',
        '',
      ].join('\n'),
    );

    editHostConfig(file, (document) => {
      setSpeech(document, 'speak', 'elevenlabs', 'voice-1');
    });
    expect(readHostConfig(file)!.speech.speak).toEqual({
      engine: 'elevenlabs',
      voice: 'voice-1',
      model: null,
    });

    editHostConfig(file, (document) => {
      setSpeech(document, 'speak', 'local');
    });
    expect(readHostConfig(file)!.speech.speak).toEqual({
      engine: 'local',
      voice: null,
      model: null,
    });
  });

  it('adds speech to a file without it, apart from what is above', () => {
    writeFileSync(file, 'data: data\nspeech:\n');

    editHostConfig(file, (document) => {
      setSpeech(document, 'transcribe', 'off');
    });

    expect(readFileSync(file, 'utf8')).toBe(
      'data: data\n\nspeech:\n  transcribe:\n    engine: off\n',
    );
  });
});

describe('data folder', () => {
  it('resolves relative to the workspace, with data/ by default', () => {
    expect(resolveDataFolder({ data: null }, '/ws')).toBe('/ws/data');
    expect(resolveDataFolder({ data: 'vault' }, '/ws')).toBe('/ws/vault');
    expect(resolveDataFolder({ data: '~/notes' }, '/ws', '/home/o')).toBe(
      '/home/o/notes',
    );
  });

  it('holds the system folder, unless system names another', () => {
    const system = (config: { data: string | null; system: string | null }) =>
      resolveSystemFolder(config, '/ws', '/home/o');
    expect(system({ data: null, system: null })).toBe('/ws/data/System');
    expect(system({ data: '~/notes', system: null })).toBe(
      '/home/o/notes/System',
    );
    expect(system({ data: 'vault', system: 'config/pero' })).toBe(
      '/ws/config/pero',
    );
    expect(system({ data: null, system: '/srv/system' })).toBe('/srv/system');
  });
});

describe('chatKindOf', () => {
  it('takes negative IDs for groups and positive ones for people', () => {
    expect(chatKindOf('-1001234567890')).toBe('group');
    expect(chatKindOf('123456789')).toBe('private');
  });
});
