import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
import {
  type WorkspaceLayout,
  workspaceLayout,
} from '../config/workspace-layout.js';
import {
  DEFAULT_SPEECH,
  DEFAULT_FILES,
  readHostConfig,
} from '../config/host-config.js';
import { allowInFile, denyInFile } from './allowlist-file.js';

describe('allowing and denying in config.yaml', () => {
  let tmp: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-allowlist-'));
    layout = workspaceLayout(join(tmp, 'ws'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates config.yaml from the template for the first chat', () => {
    const result = allowInFile(layout, '-1001234567890');

    expect(result).toEqual({
      chat: {
        chatId: '-1001234567890',
        kind: 'group',
        title: null,
        bot: null,
        topics: null,
        problem: null,
        danger: null,
      },
      alreadyAllowed: false,
    });
    expect(readHostConfig(layout.configFile)).toEqual({
      data: 'data',
      system: null,
      allowedChats: [{ chatKey: '-1001234567890', title: null }],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    });
  });

  it('keeps comments and titles, and says when a chat was already there', () => {
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(
      layout.configFile,
      '# mine\ntelegram:\n  allowed-chats:\n    - id: 42\n      title: Me\n',
    );

    expect(allowInFile(layout, '42')).toMatchObject({
      chat: { chatId: '42', kind: 'private', title: 'Me' },
      alreadyAllowed: true,
    });
    expect(allowInFile(layout, '-100')).toMatchObject({
      alreadyAllowed: false,
    });
    expect(denyInFile(layout, '42')).toMatchObject({
      chat: { chatId: '42', title: 'Me' },
    });
    expect(readFileSync(layout.configFile, 'utf8')).toBe(
      '# mine\ntelegram:\n  allowed-chats:\n    - id: -100\n',
    );
  });

  it('refuses a chat that is not allowed, and an ID that is not one', () => {
    expect(() => denyInFile(layout, '42')).toThrow(
      new NotFoundError('Telegram chat 42 is not allowed'),
    );
    expect(() => allowInFile(layout, 'general')).toThrow(InvalidInputError);
    expect(() => allowInFile(layout, 'general')).toThrow(
      'chat-id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
    );
  });
});
