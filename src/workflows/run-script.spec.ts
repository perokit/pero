import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isNoData,
  renderScriptInput,
  runScript,
  ScriptError,
  type ScriptOptions,
} from './run-script.js';

describe('runScript', () => {
  let folder: string;

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'pero-run-script-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function options(overrides: Partial<ScriptOptions> = {}): ScriptOptions {
    return {
      cwd: folder,
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      ...overrides,
    };
  }

  /** Whether the process `pid` is still running. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    // A killed orphan waits as a zombie until init reaps it, which a
    // container's init may never do.
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
    } catch {
      return true;
    }
  }

  it('resolves to what it printed, run through the shell', async () => {
    await expect(
      runScript('echo one; echo two | tr a-z A-Z', options()),
    ).resolves.toBe('one\nTWO\n');
  });

  it('runs in its folder, with Pero’s environment and its own', async () => {
    process.env.PERO_RUN_SCRIPT_TEST = 'inherited';
    try {
      await expect(
        runScript(
          'echo "$PWD $PERO_RUN_SCRIPT_TEST $PERO_WORKFLOW"',
          options({ env: { PERO_WORKFLOW: 'alerts' } }),
        ),
      ).resolves.toBe(`${folder} inherited alerts\n`);
    } finally {
      delete process.env.PERO_RUN_SCRIPT_TEST;
    }
  });

  it('fails with the last line it wrote to standard error, or its exit code', async () => {
    await expect(
      runScript('echo first >&2; echo last >&2; echo out; exit 4', options()),
    ).rejects.toThrow(new ScriptError('script failed: last'));
    await expect(runScript('exit 4', options())).rejects.toThrow(
      new ScriptError('script failed (exit 4)'),
    );
  });

  it('fails when its folder does not exist', async () => {
    const error = await runScript(
      'echo hi',
      options({ cwd: join(folder, 'missing') }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).aborted).toBe(false);
  });

  it('stops it and what it started once it takes too long', async () => {
    const pidFile = join(folder, 'pid');
    const error = await runScript(
      `sleep 30 & echo $! > ${pidFile}; wait`,
      options({ timeoutMs: 300 }),
    ).catch((caught: unknown) => caught);

    expect(error).toEqual(new ScriptError('script took longer than 0.3 s'));
    expect((error as ScriptError).aborted).toBe(false);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it('stops it when its signal aborts', async () => {
    const controller = new AbortController();
    const running = runScript(
      'sleep 30',
      options({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toEqual(new ScriptError('script was stopped', true));
    expect((error as ScriptError).aborted).toBe(true);

    controller.abort();
    await expect(
      runScript('echo hi', options({ signal: controller.signal })),
    ).rejects.toMatchObject({ aborted: true });
  });
});

describe('isNoData', () => {
  it('is just NO_DATA, whatever whitespace surrounds it', () => {
    expect(isNoData('NO_DATA\n')).toBe(true);
    expect(isNoData('  NO_DATA  ')).toBe(true);
    expect(isNoData('NO_DATA, but one alert')).toBe(false);
    expect(isNoData('no_data')).toBe(false);
    expect(isNoData('')).toBe(false);
  });
});

describe('renderScriptInput', () => {
  it('puts the output in place of each {{script}}', () => {
    expect(
      renderScriptInput('Alerts:\n{{script}}\nAgain: {{script}}', 'a $& b\n'),
    ).toBe(
      'Alerts:\n[Script output]\na $& b\n[End of script output]\nAgain: [Script output]\na $& b\n[End of script output]',
    );
  });

  it('puts it after the input when there is no {{script}}', () => {
    expect(renderScriptInput('Summarize.', '  one\ntwo\n\n')).toBe(
      'Summarize.\n\n[Script output]\n  one\ntwo\n[End of script output]',
    );
  });

  it('says when the script printed nothing', () => {
    expect(renderScriptInput('Summarize.', '\n')).toBe(
      'Summarize.\n\n[The script printed nothing]',
    );
  });

  it('keeps the start of output past its budget, saying how much it left out', () => {
    expect(renderScriptInput('{{script}}', 'abcdefghij', 4)).toBe(
      '[Script output]\nabcd\n[6 more characters left out to fit]\n[End of script output]',
    );
  });
});
