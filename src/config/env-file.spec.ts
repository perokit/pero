import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureGitignoreLine,
  EnvFilePermissionError,
  gitEnvFileProblem,
  parseEnvFile,
  readEnvFile,
  setEnvValue,
} from './env-file.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

describe('parseEnvFile', () => {
  it('reads KEY=value lines, skipping comments and blank lines', () => {
    const values = parseEnvFile(
      [
        '# Pero',
        '',
        `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}`,
        '  export OTHER = spaced  ',
        "SINGLE='a # b'",
        'DOUBLE="say \\"hi\\""',
        'EMPTY=',
        'not a variable',
      ].join('\n'),
    );

    expect(Object.fromEntries(values)).toEqual({
      PERO_TELEGRAM_BOT_TOKEN: TOKEN,
      OTHER: 'spaced',
      SINGLE: 'a # b',
      DOUBLE: 'say "hi"',
      EMPTY: '',
    });
  });

  it('lets a later line win', () => {
    expect(parseEnvFile('A=1\r\nA=2\r\n').get('A')).toBe('2');
  });
});

describe('.env files', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-env-'));
    file = join(tmp, '.env');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads nothing when there is no file', () => {
    expect(readEnvFile(file)).toBeNull();
  });

  it('refuses a file others can read, naming the fix', () => {
    writeFileSync(file, `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`, { mode: 0o644 });
    chmodSync(file, 0o644);

    expect(() => readEnvFile(file)).toThrow(EnvFilePermissionError);
    expect(() => readEnvFile(file)).toThrow(
      `${file} is readable by other users; run chmod 600 ${file}`,
    );
    chmodSync(file, 0o600);
    expect(readEnvFile(file)?.get('PERO_TELEGRAM_BOT_TOKEN')).toBe(TOKEN);
  });

  it('creates the file owner-only', () => {
    setEnvValue(file, 'PERO_TELEGRAM_BOT_TOKEN', TOKEN);

    expect(readFileSync(file, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces the value in place, keeping every other line', () => {
    const before = [
      '# Secrets for Pero',
      'export PERO_TELEGRAM_BOT_TOKEN=old',
      '',
      'OTHER="kept as is"  ',
      'PERO_TELEGRAM_BOT_TOKEN=duplicate',
    ].join('\n');
    writeFileSync(file, before, { mode: 0o600 });

    setEnvValue(file, 'PERO_TELEGRAM_BOT_TOKEN', TOKEN);

    expect(readFileSync(file, 'utf8')).toBe(
      [
        '# Secrets for Pero',
        `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}`,
        '',
        'OTHER="kept as is"  ',
        '',
      ].join('\n'),
    );
  });

  it('appends a new key and quotes a value that needs it', () => {
    writeFileSync(file, 'A=1', { mode: 0o600 });

    setEnvValue(file, 'B', 'two words "quoted"');

    expect(readFileSync(file, 'utf8')).toBe(
      'A=1\nB="two words \\"quoted\\""\n',
    );
    expect(readEnvFile(file)?.get('B')).toBe('two words "quoted"');
  });

  it('removes a key, and leaves a file without it untouched', () => {
    writeFileSync(file, '# keep\nA=1\nB=2\n', { mode: 0o600 });

    setEnvValue(file, 'A', null);
    expect(readFileSync(file, 'utf8')).toBe('# keep\nB=2\n');

    const { mtimeMs } = statSync(file);
    setEnvValue(file, 'A', null);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
  });

  it('makes a readable file owner-only when it writes it', () => {
    writeFileSync(file, 'A=1\n', { mode: 0o644 });
    chmodSync(file, 0o644);

    setEnvValue(file, 'A', '2');

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('ensureGitignoreLine', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-gitignore-'));
    file = join(tmp, '.gitignore');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the file with the line', () => {
    expect(ensureGitignoreLine(file, '.env')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('.env\n');
  });

  it('adds the line once, after a last line without a newline', () => {
    writeFileSync(file, 'node_modules/');

    expect(ensureGitignoreLine(file, '.env')).toBe(true);
    expect(ensureGitignoreLine(file, '.env')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('node_modules/\n.env\n');
  });

  it('accepts the line anchored to the folder', () => {
    writeFileSync(file, '/.env\n');
    expect(ensureGitignoreLine(file, '.env')).toBe(false);
  });
});

describe('gitEnvFileProblem', () => {
  let tmp: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', tmp, ...args], { stdio: 'ignore' });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-git-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('has nothing to say outside a Git repository', async () => {
    writeFileSync(join(tmp, '.env'), 'A=1\n');
    await expect(gitEnvFileProblem(tmp)).resolves.toBeNull();
  });

  it('accepts an ignored .env, or none at all', async () => {
    git('init', '-q');
    await expect(gitEnvFileProblem(tmp)).resolves.toBeNull();

    writeFileSync(join(tmp, '.gitignore'), '.env\n');
    writeFileSync(join(tmp, '.env'), 'A=1\n');
    await expect(gitEnvFileProblem(tmp)).resolves.toBeNull();
  });

  it('reports a .env Git would not ignore', async () => {
    git('init', '-q');
    writeFileSync(join(tmp, '.env'), 'A=1\n');

    await expect(gitEnvFileProblem(tmp)).resolves.toMatch(
      /^\.env is not ignored by Git/,
    );
  });

  it('reports a tracked .env even when it is ignored now', async () => {
    git('init', '-q');
    writeFileSync(join(tmp, '.env'), 'A=1\n');
    git('add', '.env');
    writeFileSync(join(tmp, '.gitignore'), '.env\n');

    await expect(gitEnvFileProblem(tmp)).resolves.toMatch(
      /^\.env is tracked by Git/,
    );
  });
});
