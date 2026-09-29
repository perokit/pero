import {
  chmodSync,
  mkdirSync,
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
  controlSocketPath,
  DataDirError,
  dataDirLayout,
  ensureDataDir,
  MAX_SOCKET_PATH_BYTES,
  STATE_GITIGNORE,
} from './data-dir.js';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('dataDirLayout', () => {
  it('places every file under the root', () => {
    expect(dataDirLayout('/srv/pero')).toEqual({
      root: '/srv/pero',
      workspace: null,
      database: '/srv/pero/pero.sqlite',
      logs: '/srv/pero/logs',
      logFile: '/srv/pero/logs/pero.log',
      daemonOutputFile: '/srv/pero/logs/daemon.out',
      run: '/srv/pero/run',
      controlSocket: '/srv/pero/run/pero.sock',
      lockFile: '/srv/pero/run/pero.lock',
      metadataFile: '/srv/pero/run/pero.json',
      secrets: '/srv/pero/secrets',
      stateGitignore: null,
      envFile: null,
      workspaceGitignore: null,
    });
  });

  it('knows the workspace and its .pero/.gitignore', () => {
    const layout = dataDirLayout('/srv/ws/.pero', '/srv/ws');
    expect(layout).toMatchObject({
      root: '/srv/ws/.pero',
      workspace: '/srv/ws',
      database: '/srv/ws/.pero/pero.sqlite',
      stateGitignore: '/srv/ws/.pero/.gitignore',
      envFile: '/srv/ws/.env',
      workspaceGitignore: '/srv/ws/.gitignore',
    });
  });
});

describe('controlSocketPath', () => {
  it('is in run/ while that path fits a Unix socket', () => {
    expect(controlSocketPath('/srv/pero')).toBe('/srv/pero/run/pero.sock');
  });

  it('moves under XDG_RUNTIME_DIR, named after the root, when too long', () => {
    const root = `/srv/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}/.pero`;
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const socket = controlSocketPath(root, env);

    expect(socket).toMatch(
      /^\/run\/user\/1000\/pero-[0-9a-f]{16}\/pero\.sock$/,
    );
    expect(controlSocketPath(root, env)).toBe(socket);
    expect(controlSocketPath(`${root}2`, env)).not.toBe(socket);
  });

  it('uses the temp folder without XDG_RUNTIME_DIR', () => {
    const root = `/srv/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}`;
    expect(controlSocketPath(root, {})).toMatch(
      new RegExp(`^${tmpdir()}/pero-[0-9a-f]{16}/pero\\.sock$`),
    );
  });
});

describe('ensureDataDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-data-dir-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the root and subdirectories owner-only', () => {
    const layout = ensureDataDir(join(tmp, 'nested', 'pero'));

    for (const dir of [layout.root, layout.logs, layout.run, layout.secrets]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(mode(dir)).toBe(0o700);
    }
  });

  it('is idempotent and tightens existing subdirectories', () => {
    const root = join(tmp, 'pero');
    ensureDataDir(root);
    writeFileSync(join(root, 'logs', 'pero.log'), 'kept\n');
    const loose = join(root, 'secrets');
    chmodSync(loose, 0o755);

    ensureDataDir(root);

    expect(mode(loose)).toBe(0o700);
    expect(statSync(join(root, 'logs', 'pero.log')).size).toBe(5);
  });

  it('leaves the permissions of an existing root alone', () => {
    const root = join(tmp, 'shared');
    mkdirSync(root, { mode: 0o755 });

    ensureDataDir(root);

    expect(mode(root)).toBe(0o755);
  });

  it('writes .pero/.gitignore in a workspace once, keeping an edited one', () => {
    const workspace = join(tmp, 'ws');
    const layout = ensureDataDir(join(workspace, '.pero'), workspace);

    expect(readFileSync(layout.stateGitignore!, 'utf8')).toBe(STATE_GITIGNORE);
    writeFileSync(layout.stateGitignore!, '*\n');
    ensureDataDir(join(workspace, '.pero'), workspace);
    expect(readFileSync(layout.stateGitignore!, 'utf8')).toBe('*\n');
  });

  it('makes no secrets/ in a workspace', () => {
    const workspace = join(tmp, 'ws');
    const layout = ensureDataDir(join(workspace, '.pero'), workspace);
    expect(() => statSync(layout.secrets)).toThrow();
  });

  it('writes no .gitignore into a legacy data directory', () => {
    ensureDataDir(join(tmp, 'pero'));
    expect(() => statSync(join(tmp, 'pero', '.gitignore'))).toThrow();
  });

  it('creates an owner-only folder for a relocated socket', () => {
    const root = join(tmp, 'y'.repeat(MAX_SOCKET_PATH_BYTES));
    const layout = ensureDataDir(root);

    expect(layout.controlSocket.startsWith(join(root, 'run'))).toBe(false);
    const socketDir = join(layout.controlSocket, '..');
    try {
      expect(mode(socketDir)).toBe(0o700);
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('explains when the root is a file', () => {
    const root = join(tmp, 'file');
    writeFileSync(root, '');

    expect(() => ensureDataDir(root)).toThrow(DataDirError);
    expect(() => ensureDataDir(root)).toThrow(
      `Cannot prepare data directory ${root}:`,
    );
  });
});
