# Operating Pero

How to install and upgrade Pero, where its credentials and data live, what its message history keeps, and how to back it up and bring it back on another machine.

## Install and upgrade

Pero needs Node.js 22.17+ or 24.11+ and runs on Linux and macOS:

```sh
npm install -g @perokit/pero
pero run
```

Run Pero under the OS account whose Claude Code and Codex sign-ins it should use: your own account is simplest. For a dedicated account, such as `pero`, do everything below as that account with its own home directory and environment (`sudo -iu pero`, not `sudo -u pero`), as [Testing](./TESTING.md#provider-smoke-tests-under-the-services-account) describes for the smoke tests.

`pero run` starts Pero in the background and keeps it running after the terminal closes, but not across a reboot. To start it with the machine, let a service manager run `pero run --foreground`. With systemd, a user unit for the account that runs Pero:

```ini
# ~/.config/systemd/user/pero.service
[Unit]
Description=Pero
After=network-online.target

[Service]
ExecStart=/usr/bin/env pero run --foreground
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now pero
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

`env` must find the same `node` and `pero` your shell does; with a Node version manager, write their full paths in `ExecStart` instead. Other `pero` commands work as usual while the service runs. Pero exits cleanly on `pero stop` as on `systemctl --user stop pero`, so `Restart=on-failure` restarts it only after a crash; `systemctl --user start pero` starts it again.

To upgrade, back up first, install the new version, and restart Pero, which applies any new database migrations as it starts:

```sh
pero backup ~/backups/pero-before-upgrade.tgz
npm install -g @perokit/pero
pero stop && pero run
```

A running Pero keeps the version it started with until it is restarted.

## Configuration

Almost everything is configured with `pero settings` while Pero runs (see the [user guide](./USER_GUIDE.md#first-run-setup-and-settings)). A few settings are read when Pero starts, from its command line and environment:

| Setting | Source | Default |
|---|---|---|
| Workspace | `--workspace`/`-w` (any `pero` command, before or after its name), then `PERO_WORKSPACE`, then the nearest folder holding `.pero/` from the current folder upward (never the home folder itself), then `~/workspace` when it holds `.pero/` | none |
| Legacy data directory | `--data-dir`, then `PERO_HOME`; used when no workspace is given or found | `~/.pero` |
| Log level | `PERO_LOG_LEVEL` (`fatal` … `trace`) | `info` |
| Telegram bot token | `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment, then the workspace's `.env` (or `secrets/telegram-bot-token` in a legacy data directory) | none |
| Telegram Bot API server | `PERO_TELEGRAM_API_ROOT`, such as a [local Bot API server](https://github.com/tdlib/telegram-bot-api) | `https://api.telegram.org` |
| Echo runtime, for testing only | `PERO_FAKE_RUNTIME=echo`: every Agent answers `echo: <message>` instead of running Claude or Codex | unset |

A workspace keeps Pero's state in its `.pero/` folder, which is laid out like a data directory; Pero writes `.pero/.gitignore` there so that committing the workspace commits only `.pero/config.yaml`. `pero status` shows the workspace, or the data directory marked `(legacy)`. An explicit option or variable always wins over a workspace found from the current folder. When a workspace path is too long for a Unix socket, the control socket moves to `$XDG_RUNTIME_DIR` (or the temp folder), in a folder named after a hash of the path; commands find it through `run/pero.json`.

Pero creates the data directory (`logs/`, `run/`, `secrets/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting. `pero run` passes its own environment to the daemon it starts.

## Credentials

Pero keeps no provider credentials of its own. It runs Claude Code and Codex with the sign-ins of the account it runs as:

| Provider | Sign in | Check | Stored by the provider CLI in |
|---|---|---|---|
| Claude | `claude auth login` | `claude auth status` | `~/.claude/.credentials.json` (the login Keychain on macOS) |
| Codex | `codex login`, or `codex login --device-auth` on a headless host | `codex login status` | `~/.codex/auth.json`, or under `CODEX_HOME` |

Pero never passes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, or `CODEX_API_KEY` on, so a key in its environment cannot switch you to API billing. When a sign-in expires, `pero status` shows that provider `degraded`; sign in again as the same account and run `pero run` to check again.

The Telegram bot token is Pero's one secret. It comes from `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment when that is set, otherwise from the workspace's `.env` (`PERO_TELEGRAM_BOT_TOKEN=…`, a file a systemd `EnvironmentFile=` can read too), or from `secrets/telegram-bot-token` in a legacy data directory. Either file is owner-only and never shown or logged; Pero refuses to read a `.env` that group or others can read, and `pero status` says which `chmod` fixes it. Storing the token writes `.env` atomically, keeping its other lines, and adds `.env` to the workspace's `.gitignore`. When the workspace is in a Git repository, `pero status` reports an error if Git tracks `.env` or would not ignore it. To change it, including after revoking it with @BotFather `/revoke`, run `printf '%s' "$TOKEN" | pero settings set telegram-bot-token`; Pero switches without a restart. Telegram delivers a bot's updates to one poller at a time, so never run two Peros with the same token: the second shows Telegram `degraded` because another process polls the bot.

## Data layout

Everything Pero owns is in its data directory: a workspace's `.pero/`, or `~/.pero` unless `--data-dir` or `PERO_HOME` names another:

```text
~/.pero/                 # owner-only
├── pero.sqlite          # the database; pero.sqlite-wal and -shm beside it while Pero runs
├── logs/
│   ├── pero.log         # daemon logs, JSON lines, without message text
│   └── daemon.out       # raw output of a daemon started by `pero run`
├── run/                 # control socket, lock, and process metadata while Pero runs
└── secrets/
    └── telegram-bot-token
```

The database holds:
- **Settings:** the installation defaults, including the default working directory and shared instructions.
- **Telegram:** the allowed chats, and the inbound updates already handled.
- **Agents, Channels, and Sessions:** each Agent's settings, each Channel's Agent, and the provider session ID each Session resumes.
- **Message history:** the text of each Channel (see below).
- **Workflows, Triggers, and Notifications:** the definitions, each Workflow Run with its answer or error, and each Notification with its delivery state.

Outside the data directory, and never in Pero's backups:
- **Working folders:** the default working directory and each Agent's own folder. They are yours, such as a notes vault or a project.
- **Provider conversations:** Claude Code keeps each session's transcript in `~/.claude/projects/<folder>/`, named after the folder it ran in; Codex keeps its threads in `~/.codex/sessions/` and state databases next to it in `~/.codex`. A Session resumes only while its provider still has that conversation.
- **Provider sign-ins:** listed under [Credentials](#credentials).

## Message history

Pero records the text of each allowed Channel: what people wrote there, what its Agents answered, Pero's own notices (such as the onboarding welcome and failure messages), and the Workflow Notifications delivered there. It uses it to start a fresh Session from the recent conversation, to give an Agent the Workflow messages posted since the last message, and as input for Workflows that review chats. `pero channels history <channel>` shows it.

It does not record:
- messages from chats that are not allowed;
- the Agents' reasoning, tool use, or tool approval requests;
- messages to a disabled Channel.

Logs never hold message text.

History is kept until you set `history-retention-days`; then messages older than that many days are deleted within the hour, every hour, and when Pero starts. Workflow Runs and Notifications keep their own text (the answer a run gave, the message a Notification carried) whatever the setting. Backups contain the history as it was when they were taken, and retention never reaches into them: delete old backups to be rid of it. The providers keep their own transcripts of each Session, with the reasoning and tool activity Pero leaves out, in the stores above. `history-retention-days` does not touch them; Claude Code deletes old ones on its own schedule (its `cleanupPeriodDays` setting).

## Backup

```sh
pero backup ~/backups/pero-$(date +%F).tgz
```

`pero backup` asks the running daemon for a consistent snapshot of the database, taken with SQLite's online backup API while Pero keeps working, and writes it with `secrets/` and a manifest as an owner-only gzip tar. The file must be outside the data directory; one already at that path is replaced. Logs and `run/` are left out. The backup holds the bot token and your message history, so keep it as private as the data directory. A bot token given in `PERO_TELEGRAM_BOT_TOKEN` is not in it.

It needs Pero running. To back up every night, add a line to the crontab of the account that runs Pero (`crontab -e`), with the full path to `pero` when cron's `PATH` does not have it:

```text
30 3 * * * pero backup "$HOME/backups/pero-$(date +\%F).tgz"
```

Back up the rest yourself, with the tool you already use for your files:
- **Working folders:** every folder `pero agents` lists, and the default working directory in `pero settings`. The manifest inside each backup, `pero-backup.json`, lists them too.
- **Provider conversations:** `~/.claude/projects` and `~/.codex` (without `auth.json` when you would rather sign in again), so every Session can resume after a restore. Without them, Pero still restores, and each Channel continues in a fresh Session that starts from its recent messages (see below).
- **Provider sign-ins:** optional. Signing in again after a restore is simpler and keeps the credentials out of your backups; if you do back them up, encrypt that backup.

## Restore

`pero restore <file>` runs without the daemon and restores into a data directory that is missing or empty, so it never overwrites an installation. It warns about each working folder the records name that does not exist on this machine.

To go back to a backup on the same machine, stop Pero and move its data directory aside first:

```sh
pero stop
mv ~/.pero ~/.pero.old
pero restore ~/backups/pero-2026-09-28.tgz
pero run
```

### Moving to a fresh machine

The drill below brings back every definition, and every Session resumes where it stopped. `test/restore.e2e-spec.ts` runs the same steps with the fake Bot API and the echo runtime.

1. **Stop Pero on the old machine** (`pero stop`, or stop its service), and take a last backup before that with `pero backup`. The two must never poll the same bot at once.
2. **Install Pero** on the new machine, the same version or a newer one, under an account with the **same home directory path** as before, so that the folders and provider stores keep their paths.
3. **Sign in to the providers** as that account: `claude auth login`, `codex login --device-auth`. Or restore their credential files from your encrypted backup.
4. **Restore the working folders** from your own backup, at the same paths as before.
5. **Restore the provider conversations**, `~/.claude/projects` and `~/.codex`, from your own backup.
6. **Restore Pero's backup:**

   ```sh
   pero restore ~/backups/pero-2026-09-28.tgz
   ```

   A warning names each working folder that is still missing; restore it before going on.
7. **Start Pero**, with the same `PERO_TELEGRAM_BOT_TOKEN` if you gave it the token that way:

   ```sh
   pero run
   pero status
   pero channels show <channel>   # "resumes Session …" for each Channel
   ```

Then write in a topic: its Agent answers in the same conversation.

What to expect afterwards:
- **Schedules** that came due while Pero was down run once, as one catch-up run that records how many times it stands for.
- **Notifications** still waiting to be delivered are delivered, and a Workflow that reads history goes on from where its last successful run stopped.
- **Folders at new paths:** point Pero at them with `pero settings set default-working-directory <folder>`, or `pero agents edit <agent> --working-directory <folder>` for an Agent with its own. A provider conversation belongs to its folder, so each affected Channel then starts a fresh Session that begins with its recent messages.
- **Provider conversations not restored:** when a provider no longer has a Session's conversation, Pero closes that Session and answers the same message in a fresh one that begins with the Channel's recent messages, so the Channel keeps working. The same happens when a provider has deleted an old transcript.
- **A newer Pero** applies its migrations to the restored database as it starts.
