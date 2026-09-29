import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Chat } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataDirLayout,
  type DataDirLayout,
  MAX_SOCKET_PATH_BYTES,
  STATE_GITIGNORE,
} from '../src/config/data-dir.js';
import { PACKAGE_VERSION } from '../src/common/package-version.js';
import { createControlClient } from '../src/control/client.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';
import {
  findRunningDaemon,
  readDaemonMetadata,
} from '../src/control/daemon-metadata.js';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');
const DENY_DAEMON_DEPS = join(
  import.meta.dirname,
  'fixtures/deny-daemon-deps.mjs',
);

const NOT_RUNNING = "Pero isn't running — start it with pero run";

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OTHER_TOKEN = '987654321:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-xy';

/** `pero logs` shows this entry, in local time, for every started daemon. */
const STARTED_ENTRY =
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}Pero daemon started /m;

/**
 * For waits on a spawned `pero logs --follow`: starting the CLI alone can
 * take over the 1s `vi.waitFor` default on a busy macOS runner.
 */
const FOLLOWER_WAIT = { timeout: 10_000 };

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('pero CLI (e2e)', { timeout: 60_000 }, () => {
  let tmp: string;
  let layout: DataDirLayout;
  /** Where backups of `layout` are restored. */
  let restored: DataDirLayout;
  /** Where the fake provider CLIs look for their sign-in. */
  let authDir: string;
  /** Other state directories a test started a daemon in. */
  const others: DataDirLayout[] = [];
  let api: FakeBotApi;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    layout = dataDirLayout(join(tmp, 'pero'));
    restored = dataDirLayout(join(tmp, 'restored'));
    authDir = join(tmp, 'auth');
    mkdirSync(authDir);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    for (const { metadataFile } of [layout, restored, ...others.splice(0)]) {
      const metadata = readDaemonMetadata(metadataFile);
      if (metadata) {
        kill(metadata.pid, 'SIGKILL');
        await vi.waitFor(() => expect(isAlive(metadata.pid)).toBe(false));
      }
    }
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Runs `pero` to completion with `input` on stdin, from `tmp` unless
   * `cwd` says otherwise; the environment carries no PERO_HOME,
   * PERO_WORKSPACE, or Telegram token, the fake provider CLIs that
   * the daemon inherits read their sign-in from `authDir`, and Telegram is
   * the fake Bot API.
   */
  function pero(
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      nodeArgs?: string[];
      cwd?: string;
      input?: string;
    } = {},
  ): Promise<Result> {
    const {
      PERO_HOME: _home,
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [...(options.nodeArgs ?? []), PERO, ...args],
        {
          env: {
            ...env,
            PERO_FAKE_AUTH_DIR: authDir,
            // The daemon inherits it, so Telegram is always the fake.
            PERO_TELEGRAM_API_ROOT: api.url,
            ...options.env,
          },
          cwd: options.cwd ?? tmp,
        },
        (error, stdout, stderr) => {
          const code = error ? (error.code as number | null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
      child.stdin!.end(options.input ?? '');
    });
  }

  /**
   * `pero status` once it shows the bot connected to the fake Bot API;
   * degraded while no chat is allowed.
   */
  async function connectedStatus(root = layout.root): Promise<Result> {
    let status: Result | undefined;
    await vi.waitFor(
      async () => {
        status = await pero(['--data-dir', root, 'status']);
        expect(status.stdout).toMatch(
          /telegram +(ok|degraded) +Connected as @pero_test_bot(\n|; no chat is allowed yet)/,
        );
      },
      { timeout: 10_000, interval: 200 },
    );
    return status!;
  }

  const withDataDir = (...args: string[]) => [
    '--data-dir',
    layout.root,
    ...args,
  ];

  it('runs once, reports status, and stops safely twice', async () => {
    const first = await pero(withDataDir('run'));
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const pid = Number(/\(pid (\d+),/.exec(first.stdout)?.[1]);
    expect(first.stdout).toContain(
      `Pero is running (pid ${pid}, data directory ${layout.root})`,
    );
    expect(first.stdout).toContain(
      [
        'Setup needed:',
        '  Default working directory is not set — pero settings set default-working-directory <folder>',
        '  Telegram: Bot token is not set — pero settings set telegram-bot-token (reads it from stdin), or start Pero with PERO_TELEGRAM_BOT_TOKEN',
        '  claude: Not signed in — run claude auth login, then pero run to check again',
        'Run pero run in a terminal to set these up step by step.',
      ].join('\n'),
    );
    // Codex is neither the default provider nor used by an Agent.
    expect(first.stdout).not.toContain('codex');

    const second = await pero(withDataDir('run'));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Pero is already running (pid ${pid},`);
    expect(readDaemonMetadata(layout.metadataFile)?.pid).toBe(pid);

    const status = await pero(withDataDir('status'));
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(status.stdout).toMatch(/Health +degraded/);
    for (const name of ['claude', 'codex', 'telegram']) {
      expect(status.stdout).toMatch(new RegExp(`${name} +unconfigured`));
    }
    expect(status.stdout).toMatch(/codex +unconfigured .*\(not in use\)\n/);

    const stop = await pero(withDataDir('stop'));
    expect(stop).toMatchObject({ code: 0, stdout: 'Pero stopped\n' });
    expect(isAlive(pid)).toBe(false);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);

    const again = await pero(withDataDir('stop'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('configures Telegram through settings without a restart, never showing the token', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;
    const before = await pero(withDataDir('status'));
    expect(before.stdout).toMatch(
      /telegram +unconfigured +Bot token is not set/,
    );
    expect(before.stdout).toMatch(/Health +degraded/);

    const set = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: `${TOKEN}\n`,
      },
    );
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (secrets)\n',
      stderr: '',
    });

    // Connecting happens in the background, without a restart.
    const status = await connectedStatus();
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const show = await pero(withDataDir('settings', 'show'));
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^telegram-bot-token +set \(secrets\)$/m);
    const secret = join(layout.secrets, 'telegram-bot-token');
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(readFileSync(secret, 'utf8')).toBe(`${TOKEN}\n`);

    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const seen = [
      set.stdout,
      set.stderr,
      status.stdout,
      status.stderr,
      show.stdout,
      show.stderr,
      readFileSync(layout.logFile, 'utf8'),
      readFileSync(layout.daemonOutputFile, 'utf8'),
    ];
    for (const text of seen) expect(text).not.toContain(TOKEN.split(':')[1]);
  });

  it('keeps the token of a workspace in its .env, which Git must ignore', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);
    const ws = (...args: string[]) => ['-w', workspace, ...args];
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n');

    expect((await pero(ws('run'))).code).toBe(0);
    const set = await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (.env)\n',
    });
    const envFile = join(workspace, '.env');
    expect(readFileSync(envFile, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(state.root, 'secrets'))).toBe(false);

    // Stored again, the .gitignore line is not added twice.
    await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: `${OTHER_TOKEN}\n`,
    });
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.env\n',
    );
    let status: Result | undefined;
    await vi.waitFor(
      async () => {
        status = await pero(ws('status'));
        expect(status.stdout).toMatch(/telegram +(ok|degraded) +Connected/);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(status!.stdout).not.toContain('Error:');
    const show = await pero(ws('settings', 'show'));
    expect(show.stdout).toMatch(/^telegram-bot-token +set \(\.env\)$/m);

    // A tracked .env is an error, whether or not Pero runs.
    execFileSync('git', ['-C', workspace, 'add', '-f', '.env']);
    const tracked = await pero(ws('status'));
    expect(tracked.code).toBe(0);
    expect(tracked.stdout).toContain('\nError: .env is tracked by Git');
    expect((await pero(ws('stop'))).code).toBe(0);
    const stopped = await pero(ws('status'));
    expect(stopped.code).toBe(3);
    expect(stopped.stderr).toContain('Error: .env is tracked by Git');

    const seen = [
      set.stdout,
      set.stderr,
      status!.stdout,
      show.stdout,
      readFileSync(state.logFile, 'utf8'),
      readFileSync(state.daemonOutputFile, 'utf8'),
    ];
    for (const text of seen) {
      expect(text).not.toContain(TOKEN.split(':')[1]);
      expect(text).not.toContain(OTHER_TOKEN.split(':')[1]);
    }
  });

  it('allows, lists, and denies Telegram chats', async () => {
    api.chats.set('-1001234567890', {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Household',
      is_forum: true,
    });
    expect((await pero(withDataDir('run'))).code).toBe(0);
    await pero(withDataDir('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    const before = await connectedStatus();
    expect(before.stdout).toMatch(
      /telegram +degraded +Connected as @pero_test_bot; no chat is allowed yet: add the bot to a group or message it, then pero telegram allow <chat-id>\n/,
    );
    const run = await pero(withDataDir('run'));
    expect(run.stdout).toContain(
      '  Telegram: no chat is allowed yet — add the bot to a group as an administrator or message it, then pero telegram allow <chat-id>',
    );
    expect((await pero(withDataDir('telegram'))).stdout).toContain(
      'No chat is allowed yet. To pair one:',
    );

    // A group's ID is negative, which must not pass for an option.
    const allow = await pero(
      withDataDir('telegram', 'allow', '-1001234567890'),
    );
    expect(allow).toMatchObject({ code: 0, stderr: '' });
    expect(allow.stdout).toBe('Allowed: group "Household" (-1001234567890)\n');
    const again = await pero([
      'telegram',
      'allow',
      '-1001234567890',
      '--data-dir',
      layout.root,
    ]);
    expect(again.stdout).toBe(
      'Already allowed: group "Household" (-1001234567890)\n',
    );
    const chats = await pero(withDataDir('telegram', 'chats'));
    expect(chats).toMatchObject({ code: 0, stderr: '' });
    expect(chats.stdout).toMatch(/^Bot: @pero_test_bot$/m);
    expect(chats.stdout).toMatch(
      /^ {2}-1001234567890 +group +Household +on +administrator$/m,
    );
    const status = await pero(withDataDir('status'));
    expect(status.stdout).toMatch(
      /telegram +ok +Connected as @pero_test_bot\n/,
    );

    const deny = await pero(withDataDir('telegram', 'deny', '-1001234567890'));
    expect(deny).toMatchObject({
      code: 0,
      stdout:
        'Denied: group "Household" (-1001234567890). Its Channels and Agents are kept and resume if you allow it again.\n',
    });
    const missing = await pero(
      withDataDir('telegram', 'deny', '-1001234567890'),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      'Telegram chat -1001234567890 is not allowed',
    );
    const invalid = await pero(withDataDir('telegram', 'allow', 'general'));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(
      'chat-id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
    );
  });

  it('refuses a token as an argument, and one that is not valid, without echoing either', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);

    const argument = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token', TOKEN),
    );
    expect(argument).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Pass telegram-bot-token on stdin or at the prompt, not as an argument, so it stays out of shell history\n',
    });

    const invalid = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      { input: 'secret-but-wrong\n' },
    );
    expect(invalid).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'telegram-bot-token: must be a bot token from @BotFather, such as 123456789:AAE…\n',
    });
    expect(existsSync(join(layout.secrets, 'telegram-bot-token'))).toBe(false);
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    expect(readFileSync(layout.logFile, 'utf8')).not.toContain(
      'secret-but-wrong',
    );
  });

  it('changes and clears settings through the daemon', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    // The CLI sees the real path where the temporary folder is a link.
    const cwd = realpathSync(tmp);
    mkdirSync(join(cwd, 'vault'));

    const settings = (...args: string[]) =>
      pero(withDataDir('settings', ...args), { cwd });

    expect(
      await settings('set', 'default-working-directory', 'vault'),
    ).toMatchObject({
      code: 0,
      stdout: `default-working-directory is now ${join(cwd, 'vault')}\n`,
    });
    expect(
      await settings('set', 'default-working-directory', 'missing'),
    ).toMatchObject({
      code: 1,
      stderr: `Working directory ${join(cwd, 'missing')} does not exist\n`,
    });
    expect(await settings('unset', 'default-working-directory')).toMatchObject({
      code: 1,
      stderr:
        'default-working-directory cannot be unset; set another folder instead\n',
    });
    expect(
      await settings('set', 'claude.model', 'claude-opus-5-5'),
    ).toMatchObject({
      code: 0,
      stdout: 'claude.model is now claude-opus-5-5\n',
    });
    expect(await settings('unset', 'claude.model')).toMatchObject({
      code: 0,
      stdout: 'claude.model is now (provider default)\n',
    });
    expect(await settings('set', 'default-provider', 'gemini')).toMatchObject({
      code: 1,
      stderr:
        'default-provider: Invalid option: expected one of "claude"|"codex"\n',
    });
    expect(await settings('set', 'nope', 'x')).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/^Unknown setting "nope"\. Settings: /),
    });
    const instructions = await pero(
      withDataDir('settings', 'set', 'shared-instructions'),
      { input: 'Be brief.\nAnswer in English.\n' },
    );
    expect(instructions.stdout).toBe(
      'shared-instructions is now Be brief. (2 lines)\n',
    );
    expect(await settings('set', 'history-carryover', '10')).toMatchObject({
      code: 0,
      stdout: 'history-carryover is now 10\n',
    });
    expect(await settings('set', 'history-carryover', 'all')).toMatchObject({
      code: 1,
      stderr: 'history-carryover must be a whole number, not "all"\n',
    });
    expect(await settings('set', 'history-carryover', '0')).toMatchObject({
      code: 0,
      stdout: 'history-carryover is now 0 (off)\n',
    });

    const show = await settings();
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(
      new RegExp(`^default-working-directory +${join(cwd, 'vault')}$`, 'm'),
    );
    expect(show.stdout).toMatch(/^claude\.model +\(provider default\)$/m);
    expect(show.stdout).toMatch(/^history-carryover +0 \(off\)$/m);
    expect(show.stdout).toMatch(/^telegram-bot-token +not set$/m);
  });

  it('lists, shows, creates, edits, disables, and enables Agents', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    // The CLI sees the real path where the temporary folder is a link.
    const cwd = realpathSync(tmp);
    const vault = join(cwd, 'vault');
    const own = join(cwd, 'own');
    mkdirSync(vault);
    const agents = (...args: string[]) =>
      pero(withDataDir('agents', ...args), { cwd });

    expect(await agents()).toMatchObject({
      code: 0,
      stdout:
        'No Agents yet. Create a topic in an allowed Telegram group, or run pero agents create <name>.\n',
    });
    expect(await agents('create', 'notes')).toMatchObject({
      code: 1,
      stderr:
        'No default working directory is set: give the Agent its own folder, or set the default working directory first\n',
    });
    await pero(withDataDir('settings', 'set', 'default-working-directory'), {
      cwd,
      input: 'vault\n',
    });

    expect(
      await agents(
        'create',
        'Notes',
        '--model',
        'claude-opus-5-5',
        '--no-shared-instructions',
      ),
    ).toMatchObject({
      code: 0,
      stdout: `Created Agent notes: claude, claude-opus-5-5, default effort, working in ${vault} (default)\n`,
    });
    expect(await agents('create', 'notes')).toMatchObject({
      code: 1,
      stderr: 'An Agent named notes already exists\n',
    });
    expect(
      await agents('create', 'coder', '--working-directory', 'own'),
    ).toMatchObject({
      code: 1,
      stderr: `Working directory ${own} does not exist\n`,
    });
    mkdirSync(own);
    const coder = await pero(
      withDataDir(
        'agents',
        'create',
        'coder',
        '--provider',
        'codex',
        '--effort',
        'ultra',
        '--working-directory',
        'own',
        '--instructions',
        '-',
        '--skip-git-repo-check',
      ),
      { cwd, input: 'Write tests first.\nKeep it short.\n' },
    );
    expect(coder).toMatchObject({
      code: 0,
      stdout: `Created Agent coder: codex, default model, ultra effort, working in ${own}\n`,
    });

    const ls = await agents('ls');
    expect(ls).toMatchObject({ code: 0, stderr: '' });
    expect(ls.stdout).toMatch(
      new RegExp(
        `^coder +codex +default +ultra +${escape(own)} +ask +enabled$`,
        'm',
      ),
    );
    expect(ls.stdout).toMatch(
      new RegExp(
        `^notes +claude +claude-opus-5-5 +default +${escape(vault)} \\(default\\) +ask +enabled$`,
        'm',
      ),
    );

    const show = await agents('show', 'coder');
    expect(show).toMatchObject({ code: 0, stderr: '' });
    expect(show.stdout).toContain(
      [
        'Agent coder',
        '  provider             codex',
        '  model                (provider default)',
        '  effort               ultra',
        `  working directory    ${own}`,
        '  instructions         Write tests first. (2 lines)',
        '  shared instructions  on',
        '  permissions          ask',
        '  codex git check      skipped',
        '  state                enabled',
        '  main agent           no',
        '',
        'No Channel is assigned to it yet.',
      ].join('\n'),
    );

    expect(await agents('edit', 'notes', '--effort', 'ultra')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--effort: Invalid option'),
    });
    expect(await agents('edit', 'notes')).toMatchObject({
      code: 1,
      stderr:
        'Nothing to change; see pero agents edit --help for the options\n',
    });
    expect(
      await agents(
        'edit',
        'notes',
        '--provider',
        'codex',
        '--effort',
        'high',
        '--working-directory',
        'own',
        '--shared-instructions',
      ),
    ).toMatchObject({
      code: 0,
      stdout: `Changed Agent notes: codex, default model, high effort, working in ${own}\n`,
    });
    expect(
      await agents(
        'edit',
        'notes',
        '--follow-default',
        '--no-effort',
        '--title',
        'Notes',
      ),
    ).toMatchObject({
      code: 0,
      stdout: `Changed Agent notes: codex, default model, default effort, working in ${vault} (default)\n`,
    });
    expect(await agents('show', 'nobody')).toMatchObject({
      code: 1,
      stderr: 'No Agent named nobody\n',
    });

    expect(await agents('disable', 'coder')).toMatchObject({
      code: 0,
      stdout:
        'Disabled Agent coder. Its Channels get no answer until pero agents enable coder.\n',
    });
    const settings = (...args: string[]) =>
      pero(withDataDir('settings', ...args), { cwd });
    expect(await settings('set', 'main-agent', 'coder')).toMatchObject({
      code: 1,
      stderr:
        'Agent coder is disabled; enable it first with pero agents enable coder\n',
    });
    expect(await settings('set', 'main-agent', 'nobody')).toMatchObject({
      code: 1,
      stderr: 'No Agent named nobody\n',
    });
    rmSync(own, { recursive: true });
    expect(await agents('enable', 'coder')).toMatchObject({
      code: 1,
      stderr: `Working directory ${own} does not exist\n`,
    });
    mkdirSync(own);
    expect(await agents('enable', 'coder')).toMatchObject({
      code: 0,
      stdout: `Enabled Agent coder: codex, default model, ultra effort, working in ${own}\n`,
    });

    expect(await settings('set', 'main-agent', 'coder')).toMatchObject({
      code: 0,
      stdout:
        'main-agent is now coder\nIt answers General topics and direct chats onboarded from now on; existing Channels keep their Agent.\n',
    });
    expect((await agents()).stdout).toMatch(/^coder \* +codex /m);
    expect(await agents('disable', 'coder')).toMatchObject({
      code: 0,
      stderr: expect.stringContaining(
        'Warning: coder is the main Agent, so General topics and direct chats get no answer either',
      ),
    });
    expect(await settings('unset', 'main-agent')).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^main-agent is now \(not set: main\)\n/),
    });
  });

  it('lists, shows, assigns, disables, and enables Channels, and prints their history', async () => {
    const channels = (...args: string[]) =>
      pero(withDataDir('channels', ...args));
    expect(await channels()).toMatchObject({
      code: 1,
      stderr: `${NOT_RUNNING}\n`,
    });

    const forum: Chat.SupergroupChat = {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Household',
      is_forum: true,
    };
    api.chats.set(String(forum.id), forum);
    expect((await pero(withDataDir('run'))).code).toBe(0);
    mkdirSync(join(tmp, 'vault'));
    await pero(
      withDataDir(
        'settings',
        'set',
        'default-working-directory',
        join(tmp, 'vault'),
      ),
    );
    await pero(withDataDir('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    await connectedStatus();
    expect(await channels()).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^No Channels yet\. /),
    });
    await pero(withDataDir('telegram', 'allow', String(forum.id)));
    api.push({
      message: {
        message_id: 1,
        date: 0,
        chat: forum,
        from: { id: 1234, is_bot: false, first_name: 'Ada' },
        message_thread_id: 42,
        is_topic_message: true,
        forum_topic_created: { name: 'Groceries', icon_color: 0 },
      },
    } as never);
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));

    expect(await channels()).toEqual({
      code: 0,
      stdout:
        'ID  CHANNEL                     TITLE      AGENT      STATE\n' +
        '1   telegram -1001234567890:42  Groceries  groceries  enabled\n',
      stderr: '',
    });
    const show = await channels('show', '1');
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^Channel 1 "Groceries"\n/);
    expect(show.stdout).toMatch(/^ {2}next turn +starts its first Session$/m);
    expect(show.stdout).toMatch(/^ {2}history +1 message, the latest at /m);

    await pero(withDataDir('agents', 'create', 'chef'));
    const described = 'Channel 1 (telegram -1001234567890:42 "Groceries")';
    expect(await channels('assign', '1', 'chef')).toMatchObject({
      code: 0,
      stdout: `${described} now talks to Agent chef.\nIts next turn starts a fresh Session.\n`,
    });
    expect(await channels('assign', '1', 'chef')).toMatchObject({
      code: 0,
      stdout: `${described} already talks to Agent chef.\n`,
    });
    expect(await channels('disable', '1')).toMatchObject({
      code: 0,
      stdout: `Disabled ${described}. Its messages are ignored until pero channels enable 1.\n`,
    });
    expect((await channels('ls')).stdout).toMatch(/ chef +disabled\n$/);
    expect(await channels('enable', '1')).toMatchObject({
      code: 0,
      stdout: `Enabled ${described}: it talks to Agent chef.\n`,
    });

    const history = await channels('history', '1', '-n', '5');
    expect(history.code).toBe(0);
    expect(history.stdout).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d {2}out {2}pero {2}This topic talks to Agent groceries: /,
    );

    expect(await channels('history', '1', '-n', '0')).toMatchObject({
      code: 1,
      stderr: '--lines must be a whole number from 1 to 500, not "0"\n',
    });
    expect(await channels('show', 'groceries')).toMatchObject({
      code: 1,
      stderr:
        'channel must be a Channel ID, as pero channels ls lists it, not "groceries"\n',
    });
    expect(await channels('show', '9')).toMatchObject({
      code: 1,
      stderr: 'No Channel with ID 9\n',
    });
    expect(await channels('assign', '1', 'nobody')).toMatchObject({
      code: 1,
      stderr: 'No Agent named nobody\n',
    });

    // A Workflow posts its runs to the Channel.
    await pero(
      withDataDir(
        'workflows',
        'create',
        'brief',
        '--agent',
        'chef',
        '--input',
        'Go',
      ),
    );
    const workflows = (...args: string[]) =>
      pero(withDataDir('workflows', ...args));
    expect(await workflows('notify', 'brief', '1')).toEqual({
      code: 0,
      stdout: `Workflow brief now notifies ${described}: each answer, and each run that fails, is posted there.\n`,
      stderr: '',
    });
    expect(await workflows('notify', 'brief', '1')).toMatchObject({
      code: 0,
      stdout: `Workflow brief already notifies ${described}.\n`,
    });
    expect((await workflows('show', 'brief')).stdout).toContain(
      [
        'Notifies',
        '  ID  CHANNEL                     TITLE      STATE',
        '  1   telegram -1001234567890:42  Groceries  enabled',
      ].join('\n'),
    );
    expect(await workflows('notify', 'brief', '1', '--remove')).toMatchObject({
      code: 0,
      stdout: 'Workflow brief no longer notifies Channel 1.\n',
    });
    expect(await workflows('notify', 'brief', '1', '--remove')).toMatchObject({
      code: 0,
      stdout: 'Workflow brief did not notify Channel 1.\n',
    });
    expect(await workflows('notify', 'brief', 'groceries')).toMatchObject({
      code: 1,
      stderr:
        'channel must be a Channel ID, as pero channels ls lists it, not "groceries"\n',
    });
    expect(await workflows('notify', 'brief', '9')).toMatchObject({
      code: 1,
      stderr: 'No Channel with ID 9; pero channels ls lists them\n',
    });
  });

  it('lists, shows, creates, edits, disables, and enables Workflows and their Triggers', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    await pero(
      withDataDir('settings', 'set', 'default-working-directory', vault),
    );
    await pero(withDataDir('settings', 'set', 'timezone', 'Europe/Berlin'));
    await pero(withDataDir('agents', 'create', 'coach'));
    const workflows = (...args: string[]) =>
      pero(withDataDir('workflows', ...args));
    const triggers = (...args: string[]) =>
      pero(withDataDir('triggers', ...args));

    expect(await workflows()).toMatchObject({
      code: 0,
      stdout:
        'No Workflows yet. Create one with pero workflows create <name> --agent <agent> --input <text>.\n',
    });
    expect(
      await workflows('create', 'evening-review', '--input', 'Go'),
    ).toMatchObject({
      code: 1,
      stderr: 'Give the Agent its runs use with --agent <name>\n',
    });
    expect(
      await workflows(
        'create',
        'evening review',
        '--agent',
        'coach',
        '--input',
        'Go',
      ),
    ).toMatchObject({
      code: 1,
      stderr:
        '<name>: must be letters and digits, in words joined by single hyphens\n',
    });
    expect(
      await workflows(
        'create',
        'evening-review',
        '--agent',
        'nobody',
        '--input',
        'Go',
      ),
    ).toMatchObject({ code: 1, stderr: 'No Agent named nobody\n' });
    expect(
      await pero(
        withDataDir(
          'workflows',
          'create',
          'Evening-Review',
          '--agent',
          'coach',
          '--input',
          '-',
        ),
        { input: "Review today's chats.\n" },
      ),
    ).toMatchObject({
      code: 0,
      stdout:
        'Created Workflow evening-review: runs Agent coach, 0 Triggers\n' +
        'Start it on a schedule with pero triggers add evening-review --cron "<expression>".\n',
    });
    expect(
      await workflows('edit', 'evening-review', '--title', 'Evening review'),
    ).toMatchObject({
      code: 0,
      stdout: 'Changed Workflow evening-review: runs Agent coach, 0 Triggers\n',
    });
    expect(await workflows('edit', 'evening-review')).toMatchObject({
      code: 1,
      stderr:
        'Nothing to change; see pero workflows edit --help for the options\n',
    });

    expect(await triggers('add', 'evening-review')).toMatchObject({
      code: 1,
      stderr:
        'Give a schedule with --cron "<expression>", such as --cron "0 9 * * *", or --manual\n',
    });
    expect(
      await triggers('add', 'evening-review', '--cron', '@daily', '--manual'),
    ).toMatchObject({
      code: 1,
      stderr: 'Give either --cron or --manual, not both\n',
    });
    expect(
      await triggers('add', 'evening-review', '--cron', '0 21 * *'),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /^--cron: must be a cron expression of five fields/,
      ),
    });
    expect(
      await triggers(
        'add',
        'evening-review',
        '--cron',
        '0 21 * * *',
        '--timezone',
        'Mars/Base',
      ),
    ).toMatchObject({
      code: 1,
      stderr: '--timezone: must be an IANA time zone such as Europe/Berlin\n',
    });
    expect(await triggers('add', 'nothing', '--manual')).toMatchObject({
      code: 1,
      stderr: 'No Workflow named nothing\n',
    });
    expect(
      await triggers('add', 'evening-review', '--cron', '0 21 * * *'),
    ).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        /^Added Trigger 1 of evening-review \(0 21 \* \* \* Europe\/Berlin\), next run \d{4}-\d\d-\d\d \d\d:\d\d\.\n$/,
      ),
    });
    expect(await triggers('add', 'evening-review', '--manual')).toMatchObject({
      code: 0,
      stdout: 'Added Trigger 2 of evening-review (manual).\n',
    });

    expect(await triggers()).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          [
            'ID  WORKFLOW        SCHEDULE                  NEXT RUN          STATE',
            '1   evening-review  0 21 \\* \\* \\* Europe/Berlin  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  enabled',
            '2   evening-review  manual                    —                 enabled',
            '',
          ].join('\n'),
        ),
      ),
    });
    expect(await triggers('disable', '1')).toMatchObject({
      code: 0,
      stdout:
        'Disabled Trigger 1 of evening-review (0 21 * * * Europe/Berlin). It starts nothing until pero triggers enable 1.\n',
    });
    expect(await triggers('remove', '2')).toMatchObject({
      code: 0,
      stdout: 'Removed Trigger 2 of evening-review (manual).\n',
    });
    expect(await triggers('remove', 'two')).toMatchObject({
      code: 1,
      stderr:
        'trigger must be a Trigger ID, as pero triggers ls lists it, not "two"\n',
    });
    expect(await triggers('enable', '2')).toMatchObject({
      code: 1,
      stderr: 'No Trigger with ID 2\n',
    });

    expect(await workflows('disable', 'evening-review')).toMatchObject({
      code: 0,
      stdout:
        'Disabled Workflow evening-review. Its Triggers start nothing until pero workflows enable evening-review.\n',
    });
    expect(await workflows()).toMatchObject({
      code: 0,
      stdout: [
        'NAME            AGENT  TRIGGERS  STATE',
        'evening-review  coach  1         disabled',
        '',
      ].join('\n'),
    });
    await pero(withDataDir('agents', 'disable', 'coach'));
    expect(await workflows('enable', 'evening-review')).toMatchObject({
      code: 0,
      stdout: 'Enabled Workflow evening-review: runs Agent coach, 1 Trigger\n',
      stderr:
        'Warning: Agent coach is disabled, so this Workflow cannot run until pero agents enable coach.\n',
    });
    expect(await workflows('show', 'evening-review')).toMatchObject({
      code: 0,
      stdout: [
        'Workflow evening-review "Evening review"',
        '  agent     coach (disabled)',
        "  input     Review today's chats.",
        '  runs      one at a time',
        '  attempts  1 (a run Pero stops is not started again)',
        '  history   none',
        '  state     enabled',
        '',
        'Warning: Agent coach is disabled, so this Workflow cannot run until pero agents enable coach.',
        '',
        'Triggers',
        '  ID  SCHEDULE                  NEXT RUN  STATE',
        '  1   0 21 * * * Europe/Berlin  —         disabled',
        '',
        'Notifies no Channel: pero workflows notify evening-review <channel> posts its answers there.',
        '',
      ].join('\n'),
    });
    expect(
      await workflows('edit', 'evening-review', '--agent', 'coach'),
    ).toMatchObject({
      code: 1,
      stderr:
        'Agent coach is disabled; enable it first with pero agents enable coach\n',
    });
  });

  it("runs a Workflow by hand and prints the Agent's answer", async () => {
    const run = await pero(withDataDir('run'), {
      env: { PERO_FAKE_RUNTIME: 'echo' },
    });
    expect(run.code).toBe(0);
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    await pero(
      withDataDir('settings', 'set', 'default-working-directory', vault),
    );
    await pero(withDataDir('agents', 'create', 'coach'));
    await pero(
      withDataDir(
        'workflows',
        'create',
        'brief',
        '--agent',
        'coach',
        '--input',
        'Summarize the day.',
      ),
    );
    const workflows = (...args: string[]) =>
      pero(withDataDir('workflows', ...args));

    expect(await workflows('run', 'brief')).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Workflow brief has no manual Trigger; add one with pero triggers add brief --manual\n',
    });
    await pero(withDataDir('triggers', 'add', 'brief', '--manual'));

    expect(await workflows('run', 'brief')).toEqual({
      code: 0,
      stdout: 'echo: Summarize the day.\n',
      stderr: 'Queued run 1 of Workflow brief…\n',
    });
    expect(await workflows('run', 'brief', '--no-wait')).toEqual({
      code: 0,
      stdout: 'Queued run 2 of Workflow brief; it runs in the background.\n',
      stderr: '',
    });

    const runs = (...args: string[]) => pero(withDataDir('runs', ...args));
    expect(await runs('cancel', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 has already finished (completed)\n',
    });
    expect(await runs('cancel', 'brief')).toMatchObject({
      code: 1,
      stderr: 'run must be a run ID, not "brief"\n',
    });
    expect(await runs('cancel', '9')).toMatchObject({
      code: 1,
      stderr: 'No run with ID 9\n',
    });

    expect(
      await workflows('edit', 'brief', '--max-attempts', '0'),
    ).toMatchObject({
      code: 1,
      stderr: '--max-attempts must be a positive whole number, not "0"\n',
    });
    expect(
      await workflows('edit', 'brief', '--max-attempts', '11'),
    ).toMatchObject({
      code: 1,
      stderr: '--max-attempts: must be at most 10\n',
    });
    expect(
      await workflows('edit', 'brief', '--max-attempts', '3'),
    ).toMatchObject({ code: 0 });
    expect((await workflows('show', 'brief')).stdout).toContain(
      '  attempts  up to 3 (a run Pero stops starts again when Pero does)\n',
    );
  });

  it('lists, shows, and retries runs and Notifications', async () => {
    const echo = { env: { PERO_FAKE_RUNTIME: 'echo' } };
    expect((await pero(withDataDir('run'), echo)).code).toBe(0);
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    await pero(
      withDataDir('settings', 'set', 'default-working-directory', vault),
    );
    await pero(withDataDir('agents', 'create', 'coach'));
    await pero(
      withDataDir(
        'workflows',
        'create',
        'brief',
        '--agent',
        'coach',
        '--input',
        'Summarize the day.',
      ),
    );
    await pero(withDataDir('triggers', 'add', 'brief', '--manual'));
    const runs = (...args: string[]) => pero(withDataDir('runs', ...args));
    const notifications = (...args: string[]) =>
      pero(withDataDir('notifications', ...args));

    expect(await runs()).toEqual({
      code: 0,
      stdout: 'No runs yet. pero workflows run <name> starts one by hand.\n',
      stderr: '',
    });
    expect((await pero(withDataDir('workflows', 'run', 'brief'))).code).toBe(0);
    expect(await runs('retry', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 completed; pero workflows run brief starts another\n',
    });

    // Run 1 failed, and left a Notification that could not be delivered.
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const db = new Database(layout.database);
    db.prepare(
      `UPDATE "workflow_runs" SET "status" = 'failed', "result_json" = NULL, ` +
        `"error_text" = 'The model is overloaded' WHERE "id" = 1`,
    ).run();
    db.prepare(
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "title", "agent_id") ` +
        `VALUES ('telegram', '-100:7', '{"chatId":"-100","topicId":7}', 'English', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO "notifications" ("workflow_run_id", "channel_id", "status", "payload", "attempt", "last_error") ` +
        `VALUES (1, 1, 'failed', '{"text":"Run 1 of Workflow brief failed"}', 10, 'Telegram is unreachable')`,
    ).run();
    db.close();
    expect((await pero(withDataDir('run'), echo)).code).toBe(0);

    const listed = await runs('ls', '--status', 'failed');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      /^ID +WORKFLOW +STATUS +ATTEMPT +STARTED BY +CREATED +FINISHED\n1 +brief +failed +1 +manual +/,
    );
    const shown = await runs('show', '1');
    expect(shown.stdout).toContain('Run 1 of Workflow brief\n');
    expect(shown.stdout).toContain('\nError\n  The model is overloaded\n');
    expect(shown.stdout).toMatch(
      /\nNotifications\n  ID +CHANNEL +STATUS +ATTEMPTS +NEXT ATTEMPT +LAST ERROR\n  1 +1 English +failed +10\/10 +— +Telegram is unreachable\n/,
    );
    expect(shown.stdout).toMatch(/pero runs retry 1 queues it again\.\n$/);

    expect(await runs('retry', '1')).toEqual({
      code: 0,
      stdout: 'echo: Summarize the day.\n',
      stderr: 'Queued run 2 to retry run 1 of Workflow brief…\n',
    });
    expect((await runs('show', '1')).stdout).toContain('  retried by  run 2\n');
    expect((await runs('show', '2')).stdout).toContain(
      '  started by  retry of run 1\n',
    );
    expect(await runs('retry', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 is already retried by run 2; retry that one instead\n',
    });
    expect(await runs('ls', '--status', 'lost')).toMatchObject({
      code: 1,
      stderr:
        '--status must be one of pending, running, completed, failed, cancelled, interrupted, not "lost"\n',
    });
    expect(await runs('ls', '-n', '0')).toMatchObject({
      code: 1,
      stderr: '--lines must be a whole number from 1 to 500, not "0"\n',
    });
    expect((await runs('ls', '-n', '1')).stdout).toMatch(
      /\n2 +brief +completed +2 +retry of run 1 /,
    );

    const notificationList = await notifications();
    expect(notificationList.stdout).toMatch(
      /^ID +RUN +WORKFLOW +CHANNEL +STATUS +ATTEMPTS +NEXT ATTEMPT +LAST ERROR\n1 +1 +brief +1 English +failed +10\/10 +— +Telegram is unreachable\n$/,
    );
    expect((await notifications('ls', '--status', 'delivered')).stdout).toBe(
      'No Notifications match.\n',
    );
    const notification = await notifications('show', '1');
    expect(notification.stdout).toContain(
      '  to            Channel 1 (telegram -100:7 "English")\n',
    );
    expect(notification.stdout).toContain(
      '\nMessage\n  Run 1 of Workflow brief failed\n',
    );
    // The chat was never allowed, and there is no bot token.
    expect(notification.stdout).toMatch(
      /\n\nIts Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again\.\nTelegram: Bot token is not set; pero status shows more\.\npero notifications retry 1 tries it again with fresh attempts\.\n$/,
    );

    const retried = await notifications('retry', '1');
    expect(retried.code).toBe(1);
    expect(retried.stderr).toMatch(
      /^Delivering Notification 1…\nCould not deliver Notification 1: the chat is no longer allowed\nIts Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again\.\nTelegram: Bot token is not set; pero status shows more\.\n$/,
    );
    expect((await notifications('show', '1')).stdout).toContain(
      '  attempts      1/10\n',
    );
    expect(await notifications('retry', '1', '--no-wait')).toEqual({
      code: 0,
      stdout: 'Notification 1 is due now; Pero delivers it within seconds.\n',
      stderr: '',
    });
    expect(await notifications('show', '9')).toMatchObject({
      code: 1,
      stderr: 'No Notification with ID 9\n',
    });
  });

  it('keeps message history for as many days as the owner sets', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const settings = (...args: string[]) =>
      pero(withDataDir('settings', ...args));

    expect((await settings('show')).stdout).toContain(
      'history-retention-days     (not set: keep all)\n',
    );
    expect(await settings('set', 'history-retention-days', '30')).toEqual({
      code: 0,
      stdout:
        'history-retention-days is now 30 days\n' +
        'Messages older than 30 days are deleted within the hour, and every hour after; runs and Notifications keep their text.\n',
      stderr: '',
    });
    expect(await settings('set', 'history-retention-days', '0')).toMatchObject({
      code: 1,
      stderr: 'history-retention-days: Too small: expected number to be >=1\n',
    });
    expect(await settings('unset', 'history-retention-days')).toEqual({
      code: 0,
      stdout:
        'history-retention-days is now (not set: keep all)\n' +
        'All message history is kept from now on.\n',
      stderr: '',
    });
  });

  it('sets the Channel history a Workflow reads, and skips a run with none', async () => {
    const run = await pero(withDataDir('run'), {
      env: { PERO_FAKE_RUNTIME: 'echo' },
    });
    expect(run.code).toBe(0);
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    await pero(
      withDataDir('settings', 'set', 'default-working-directory', vault),
    );
    await pero(withDataDir('agents', 'create', 'coach'));
    const workflows = (...args: string[]) =>
      pero(withDataDir('workflows', ...args));

    expect(
      await workflows(
        'create',
        'english',
        '--agent',
        'coach',
        '--input',
        'Suggest improvements: {{history}}',
        '--history-channels',
        '7',
      ),
    ).toMatchObject({
      code: 1,
      stderr:
        '--history-channels: no Channel with ID 7; pero channels ls lists them\n',
    });
    expect(
      await workflows(
        'create',
        'english',
        '--agent',
        'coach',
        '--input',
        'Suggest improvements: {{history}}',
        '--history',
      ),
    ).toMatchObject({
      code: 0,
      stdout: expect.stringContaining(
        'Created Workflow english: runs Agent coach, reads Channel history, 0 Triggers\n',
      ),
    });
    expect((await workflows('show', 'english')).stdout).toContain(
      "  history   people's messages in all Channels since the previous run; skipped when there are none\n",
    );
    expect(
      await workflows(
        'edit',
        'english',
        '--history-messages',
        'all',
        '--history-hours',
        '24',
        '--run-when-empty',
      ),
    ).toMatchObject({ code: 0 });
    expect((await workflows('show', 'english')).stdout).toContain(
      '  history   all messages in all Channels from the last 24 hours; runs even when there are none\n',
    );
    expect(
      await workflows('edit', 'english', '--history-messages', 'agents'),
    ).toMatchObject({
      code: 1,
      stderr: '--history-messages must be people or all, not "agents"\n',
    });
    expect(
      await workflows(
        'edit',
        'english',
        '--no-history',
        '--history-hours',
        '3',
      ),
    ).toMatchObject({
      code: 1,
      stderr:
        '--no-history stops runs reading history; give it without the other history options\n',
    });

    await workflows('edit', 'english', '--no-run-when-empty');
    await pero(withDataDir('triggers', 'add', 'english', '--manual'));
    expect(await workflows('run', 'english')).toMatchObject({
      code: 0,
      stdout:
        'Run 1 of Workflow english skipped: no messages in its history window\n',
    });

    expect(await workflows('edit', 'english', '--no-history')).toMatchObject({
      code: 0,
      stdout: 'Changed Workflow english: runs Agent coach, 1 Trigger\n',
    });
    expect((await workflows('show', 'english')).stdout).toContain(
      '  history   none\n',
    );
  });

  it('takes the token from PERO_TELEGRAM_BOT_TOKEN in the daemon environment', async () => {
    const run = await pero(withDataDir('run'), {
      env: { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
    });
    expect(run.code).toBe(0);
    // The token is fine; only a chat to serve is missing.
    expect(run.stdout).not.toMatch(/Telegram: .*(token|TOKEN)/);

    await connectedStatus();
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const set = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: OTHER_TOKEN,
      },
    );
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (PERO_TELEGRAM_BOT_TOKEN)\n',
      stderr:
        'PERO_TELEGRAM_BOT_TOKEN overrides the stored token while it is set\n',
    });

    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const log = readFileSync(layout.logFile, 'utf8');
    expect(log).not.toContain(TOKEN.split(':')[1]);
    expect(log).not.toContain(OTHER_TOKEN.split(':')[1]);
  });

  it('counts only providers in use and checks sign-in again on run', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    writeFileSync(join(authDir, 'claude'), '');
    mkdirSync(join(tmp, 'vault'));
    await pero(
      withDataDir(
        'settings',
        'set',
        'default-working-directory',
        join(tmp, 'vault'),
      ),
    );
    await pero(withDataDir('settings', 'set', 'telegram-bot-token'), {
      input: TOKEN,
    });
    await pero(withDataDir('telegram', 'allow', '1234'));

    const again = await pero(withDataDir('run'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero is already running (pid ${pid}, data directory ${layout.root})\n`,
    });
    const ready = await pero(withDataDir('status'));
    expect(ready.stdout).toMatch(/Health +ok/);
    expect(ready.stdout).toMatch(/claude +ok +Signed in \(claude\.ai, pro\)/);
    expect(ready.stdout).toContain(
      'codex     unconfigured  Not signed in — run codex login (on a headless host: codex login --device-auth) (not in use)',
    );
    expect(ready.stdout).not.toContain('owner@example.com');

    // Codex becomes the provider in use; Claude no longer counts.
    await pero(withDataDir('settings', 'set', 'default-provider', 'codex'));
    const switched = await pero(withDataDir('run'));
    expect(switched.stdout).toContain(
      '  codex: Not signed in — run codex login (on a headless host: codex login --device-auth), then pero run to check again',
    );
    expect(switched.stdout).not.toContain('claude:');
    expect((await pero(withDataDir('status'))).stdout).toMatch(
      /Health +degraded/,
    );
  });

  it('needs the daemon for settings', async () => {
    for (const args of [
      ['settings'],
      ['settings', 'show'],
      ['settings', 'set', 'timezone', 'UTC'],
    ]) {
      expect(await pero(withDataDir(...args))).toMatchObject({
        code: 1,
        stderr: `${NOT_RUNNING}\n`,
      });
    }
  });

  it('keeps the daemon running after the CLI and its process group end', async () => {
    const cli = spawn(process.execPath, [PERO, ...withDataDir('run')], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(cli);
    const code = await new Promise((resolve) => cli.once('exit', resolve));
    expect(code).toBe(0);

    // What closing a terminal does to the jobs it started.
    kill(-cli.pid!, 'SIGKILL');
    kill(-cli.pid!, 'SIGHUP');

    const running = await findRunningDaemon(layout.metadataFile);
    expect(running?.metadata.pid).not.toBe(cli.pid);
    await expect(
      createControlClient(layout.controlSocket).status(),
    ).resolves.toMatchObject({ pid: running?.metadata.pid });
  });

  it('fails a command that needs the daemon without starting one', async () => {
    const result = await pero(withDataDir('ping'));

    expect(result).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${NOT_RUNNING}\n`,
    });
    expect(existsSync(layout.controlSocket)).toBe(false);
    expect(existsSync(layout.metadataFile)).toBe(false);
  });

  it('reports status of a stopped daemon with exit code 3', async () => {
    const result = await pero(withDataDir('status'));

    expect(result).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('prints why the daemon failed to start and where its logs are', async () => {
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.database, 'not a database'.repeat(100));

    const result = await pero(withDataDir('run'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Pero failed to start: the daemon exited with code 1.',
    );
    expect(result.stderr).toContain('file is not a database');
    expect(result.stderr).toContain(
      `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`,
    );
    expect(await findRunningDaemon(layout.metadataFile)).toBeNull();
  });

  it('runs in the foreground as one process until SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [PERO, 'run', '--foreground', ...withDataDir()],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exited = new Promise((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );

    await vi.waitFor(
      async () => {
        const running = await findRunningDaemon(layout.metadataFile);
        expect(running?.metadata.pid).toBe(child.pid);
      },
      { timeout: 20_000, interval: 50 },
    );
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'Pero daemon started' }),
    );

    child.kill('SIGTERM');

    await expect(exited).resolves.toBe(0);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);
  });

  it('accepts the data directory before or after the command, or from PERO_HOME', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    for (const result of [
      await pero(['status', '--data-dir', layout.root]),
      await pero(['status'], { env: { PERO_HOME: layout.root } }),
    ]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    }
  });

  it('finds a workspace from options, PERO_WORKSPACE, or the current folder', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);

    const run = await pero(['run', '-w', workspace]);
    expect(run.code).toBe(0);
    const pid = readDaemonMetadata(state.metadataFile)?.pid;
    expect(run.stdout).toContain(
      `Pero is running (pid ${pid}, workspace ${workspace})`,
    );
    expect(readFileSync(join(workspace, '.pero', '.gitignore'), 'utf8')).toBe(
      STATE_GITIGNORE,
    );
    expect(statSync(state.database).isFile()).toBe(true);

    mkdirSync(join(workspace, 'data', 'Notes'), { recursive: true });
    for (const result of [
      await pero(['--workspace', workspace, 'status']),
      await pero(['status'], { env: { PERO_WORKSPACE: workspace } }),
      await pero(['status'], { cwd: join(workspace, 'data', 'Notes') }),
    ]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
      expect(result.stdout).toContain(`  Workspace  ${workspace}\n`);
    }

    expect(await pero(['stop'], { cwd: workspace })).toMatchObject({
      code: 0,
      stdout: 'Pero stopped\n',
    });
    expect(await pero(['status', '-w', workspace])).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (workspace ${workspace})\n`,
    });
    expect(
      await pero(['status', '-w', workspace, '--data-dir', layout.root]),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        '--workspace: cannot be combined with --data-dir',
      ),
    });
  });

  it('marks a data directory as legacy', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const status = await pero(withDataDir('status'));
    expect(status.stdout).toContain(
      `  Data directory  ${layout.root} (legacy)\n`,
    );
    expect(existsSync(join(layout.root, '.gitignore'))).toBe(false);
  });

  it('reaches a workspace whose path is too long for a socket in it', async () => {
    const workspace = join(
      realpathSync(tmp),
      'w'.repeat(MAX_SOCKET_PATH_BYTES),
    );
    const runtime = join(tmp, 'runtime');
    mkdirSync(runtime);
    const env = { XDG_RUNTIME_DIR: runtime };
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);

    expect((await pero(['run', '-w', workspace], { env })).code).toBe(0);
    const socket = readDaemonMetadata(state.metadataFile)?.socket;
    expect(socket?.startsWith(`${runtime}/pero-`)).toBe(true);
    expect(statSync(socket!).isSocket()).toBe(true);

    // The metadata says where the socket is, whatever the environment.
    const status = await pero(['status', '-w', workspace]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`  Workspace  ${workspace}\n`);
    expect(await pero(['stop', '-w', workspace])).toMatchObject({
      code: 0,
      stdout: 'Pero stopped\n',
    });
    expect(existsSync(socket!)).toBe(false);
  });

  it('shows recent logs readably whether or not the daemon runs', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const running = await pero(withDataDir('logs'));
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(STARTED_ENTRY);
    expect((await pero(withDataDir('stop'))).code).toBe(0);

    const stopped = await pero(withDataDir('logs'));
    expect(stopped).toMatchObject({ code: 0, stderr: '' });
    expect(stopped.stdout).toMatch(STARTED_ENTRY);
    expect(stopped.stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/);
    expect(stopped.stdout).not.toContain('{"level"');

    const one = await pero(withDataDir('logs', '-n', '1'));
    expect(one.stdout).toMatch(/^[^\n]+ INFO {2}Pero daemon stopped\n$/);

    const json = await pero(withDataDir('logs', '--json', '--lines', '2'));
    const entries = json.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ level: 30, msg: 'Pero daemon stopped' });
  });

  it('reports a missing log directory without creating anything', async () => {
    const result = await pero(withDataDir('logs'));

    expect(result).toMatchObject({
      code: 0,
      stdout: '',
      stderr: `No logs yet in ${layout.logs}\n`,
    });
    expect(existsSync(layout.root)).toBe(false);
  });

  it('follows new entries, from before the log exists until stopped', async () => {
    const follower = spawn(process.execPath, [
      PERO,
      ...withDataDir('logs', '--follow'),
    ]);
    children.push(follower);
    let stdout = '';
    let stderr = '';
    follower.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    follower.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    await vi.waitFor(
      () => expect(stderr).toBe(`Waiting for ${layout.logFile}…\n`),
      FOLLOWER_WAIT,
    );

    expect((await pero(withDataDir('run'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(STARTED_ENTRY),
      FOLLOWER_WAIT,
    );
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/),
      FOLLOWER_WAIT,
    );

    expect(follower.exitCode).toBeNull();
    expect(stdout).not.toContain('{"level"');
  });

  it('rejects a line count that is not a positive whole number', async () => {
    for (const count of ['0', '-3', '1.5', 'many']) {
      const result = await pero(withDataDir('logs', '-n', count));
      expect(result).toMatchObject({
        code: 1,
        stderr: `--lines must be a positive whole number, not "${count}"\n`,
      });
    }
  });

  it('restores a backup into a fresh data directory that starts with the same records', async () => {
    const cwd = realpathSync(tmp);
    const vault = join(cwd, 'vault');
    const own = join(cwd, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    const file = join(cwd, 'backup.tgz');
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    expect((await pero(withDataDir('run'))).code).toBe(0);
    expect(
      (
        await pero(
          withDataDir('agents', 'create', 'coder', '--working-directory', own),
        )
      ).code,
    ).toBe(0);
    const settings = [
      ['default-working-directory', vault],
      ['timezone', 'Europe/Lisbon'],
      ['claude.model', 'claude-opus-5-5'],
      ['history-carryover', '20'],
    ];
    for (const [key, value] of settings) {
      expect(
        (await pero(withDataDir('settings', 'set', key!, value!))).code,
      ).toBe(0);
    }
    for (const [key, input] of [
      ['shared-instructions', 'Be brief.\n'],
      ['telegram-bot-token', `${TOKEN}\n`],
    ]) {
      const set = await pero(withDataDir('settings', 'set', key!), { input });
      expect(set.code).toBe(0);
    }
    const before = await pero(withDataDir('settings'));

    // Taken while the daemon runs, so recent writes are still in the WAL.
    const backup = await pero(withDataDir('backup', 'backup.tgz'), {
      cwd,
      nodeArgs,
    });
    expect(backup).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Backed up ${escape(layout.root)} to ${escape(file)} \\(\\d+\\.\\d KB\\)\\n` +
            'It contains the Telegram bot token; keep it private, like the data directory\\.\\n$',
        ),
      ),
      stderr: '',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await pero(withDataDir('stop'))).code).toBe(0);

    rmSync(own, { recursive: true });
    const restore = await pero(['--data-dir', restored.root, 'restore', file], {
      nodeArgs,
    });
    expect(restore).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Restored the backup from \\S+ \\(Pero ${escape(PACKAGE_VERSION)}\\) into ${escape(restored.root)}\\. ` +
            `Start it with pero run --data-dir ${escape(restored.root)}\\n$`,
        ),
      ),
      stderr: `Warning: ${own}, the working directory of Agent coder, is missing; restore it from your own backup of the working folders\n`,
    });
    mkdirSync(own);

    const run = await pero(['--data-dir', restored.root, 'run']);
    expect(run.code).toBe(0);
    const after = await pero(['--data-dir', restored.root, 'settings']);
    expect(after).toEqual(before);
    // The restored token connects the bot.
    await connectedStatus(restored.root);
    expect((await pero(['--data-dir', restored.root, 'stop'])).code).toBe(0);

    expect(dumpTables(restored.database)).toEqual(dumpTables(layout.database));
  });

  it('refuses to restore over a running Pero or a data directory in use', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const file = join(tmp, 'backup.tgz');
    expect((await pero(withDataDir('backup', file))).code).toBe(0);

    expect(await pero(withDataDir('restore', file))).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `Pero is running for data directory ${layout.root} — stop it with pero stop before restoring\n`,
    });
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    expect(await pero(withDataDir('restore', file))).toMatchObject({
      code: 1,
      stderr: `${layout.root} is not empty. Restore into a new data directory, or stop Pero and move ${layout.root} aside first.\n`,
    });
    expect(
      await pero(['--data-dir', restored.root, 'restore', join(tmp, 'nope')]),
    ).toMatchObject({
      code: 1,
      stderr: `${join(tmp, 'nope')} does not exist\n`,
    });
    expect(existsSync(restored.root)).toBe(false);
  });

  it('needs the daemon for a backup', async () => {
    expect(await pero(withDataDir('backup', join(tmp, 'b.tgz')))).toMatchObject(
      {
        code: 1,
        stderr: `${NOT_RUNNING}\n`,
      },
    );
    expect(existsSync(layout.root)).toBe(false);
  });

  it('never loads the database stack for status, ping, logs, settings, and stop', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    for (const command of [
      'status',
      'ping',
      'logs',
      'settings',
      'agents',
      'telegram',
      'stop',
    ]) {
      const result = await pero(withDataDir(command), { nodeArgs });
      expect(result, command).toMatchObject({ code: 0, stderr: '' });
    }
    const follower = spawn(
      process.execPath,
      [...nodeArgs, PERO, ...withDataDir('logs', '--follow')],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(follower);
    let followed = '';
    follower.stdout!.on('data', (chunk: Buffer) => (followed += chunk));
    await vi.waitFor(
      () => expect(followed).toMatch(STARTED_ENTRY),
      FOLLOWER_WAIT,
    );
    expect(follower.exitCode).toBeNull();
    // The hook itself works: the daemon cannot start under it.
    const foreground = await pero(withDataDir('run', '--foreground'), {
      nodeArgs,
    });
    expect(foreground.code).not.toBe(0);
    expect(foreground.stderr).toContain('The CLI must not load');
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every row of every table, to compare two databases. */
function dumpTables(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`,
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Sends `signal`, ignoring a process or group that is already gone. */
function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
