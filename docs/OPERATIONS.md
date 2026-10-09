# Operating Pero

How to install and upgrade Pero, where its credentials and data live, what its message history keeps, and how to back it up and bring it back on another machine.

## Install and upgrade

Pero needs Node.js 22.17+ or 24.11+ and runs on Linux and macOS:

```sh
npm install -g @perokit/pero
mkdir ~/workspace && cd ~/workspace
pero run
```

In a folder that isn't a workspace yet, `pero run` offers to make it the workspace Pero runs in; commands find it from any folder inside it, and from the home folder. To make it without a terminal, such as in a provisioning script, run `pero init <dir>` first. Run Pero under the OS account whose Claude Code and Codex sign-ins it should use: your own account is simplest. For a dedicated account, such as `pero`, do everything below as that account with its own home directory and environment (`sudo -iu pero`, not `sudo -u pero`), as [Testing](./TESTING.md#provider-smoke-tests-under-the-services-account) describes for the smoke tests.

`pero run` starts Pero in the background and keeps it running after the terminal closes, but not across a reboot. To start it with the machine, run `pero service install`, which the first `pero run` also offers: it writes a systemd user unit on Linux, or a launchd agent on macOS, that runs `pero run --foreground` for the workspace with the current Node.js, `pero`, and `PATH`, starts it, and on Linux turns on lingering so it keeps running while you are logged out. `pero service uninstall` removes it. The service gets no other environment variables, so keep the bot token in `.env` (`pero telegram token`) rather than in `PERO_TELEGRAM_BOT_TOKEN`; after switching Node.js versions, run `pero service install` again.

To write the service yourself, or for another service manager, let it run `pero run --foreground`. With systemd, a user unit for the account that runs Pero:

```ini
# ~/.config/systemd/user/pero.service
[Unit]
Description=Pero
After=network-online.target

[Service]
ExecStart=/usr/bin/env pero run --foreground --workspace %h/workspace
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now pero
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

`env` must find the same `node` and `pero` your shell does; with a Node version manager, write their full paths in `ExecStart` instead. Other `pero` commands work as usual while the service runs. Pero exits cleanly on `pero stop` as on `systemctl --user stop pero`, so `Restart=on-failure` restarts it only after a crash; `systemctl --user start pero` starts it again.

To upgrade, back up first, then run `pero upgrade`. It installs the latest version with npm and restarts Pero, through its service when it runs as one, which applies any new database migrations as it starts:

```sh
pero backup ~/backups/pero-before-upgrade.tgz
pero upgrade --check   # only says whether a newer version is available
pero upgrade
```

`pero upgrade` installs with the npm that comes with the Node.js running Pero. When npm's global packages belong to another account, such as root, it says so; install as that account, `sudo npm install -g @perokit/pero`, then run `pero upgrade` again to restart Pero. By hand, the same upgrade is `npm install -g @perokit/pero`, then `pero stop && pero run` (or `systemctl --user start pero` for the service). A running Pero keeps the version it started with until it is restarted.

## Configuration

Pero's personality and instructions, the Channel notes, Workflows, and the installation defaults are notes in the workspace, and the data folder and allowed chats are in `.pero/config.yaml`, as [Configuring Pero](./CONFIGURATION.md) describes; Pero applies edits to them while it runs. A few settings are read when Pero starts, from its command line and environment:

| Setting | Source | Default |
|---|---|---|
| Workspace | `--workspace`/`-w` (any `pero` command, before or after its name), then `PERO_WORKSPACE`, then the nearest folder holding `.pero/` from the current folder upward (never the home folder itself), then `~/workspace` when it holds `.pero/` | none |
| Log level | `PERO_LOG_LEVEL` (`fatal` … `trace`) | `info` |
| Telegram bot token | `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment, then the workspace's `.env` | none |
| Telegram Bot API server | `PERO_TELEGRAM_API_ROOT`, such as a [local Bot API server](https://github.com/tdlib/telegram-bot-api) | `https://api.telegram.org` |
| ElevenLabs API key | `ELEVENLABS_API_KEY` in the daemon's environment, then the workspace's `.env`; used only by an `elevenlabs` speech engine; the [permissions it needs](./USER_GUIDE.md#elevenlabs-api-key-permissions) | none |
| Echo runtime, for testing only | `PERO_FAKE_RUNTIME=echo`: every turn answers `echo: <message>` instead of running Claude or Codex | unset |

A workspace keeps Pero's state in its `.pero/` folder; Pero writes `.pero/.gitignore` there so that committing the workspace commits only `.pero/config.yaml`. `pero status` shows the workspace. An explicit option or variable always wins over a workspace found from the current folder. When a workspace path is too long for a Unix socket, the control socket moves to `$XDG_RUNTIME_DIR` (or the temp folder), in a folder named after a hash of the path; commands find it through `run/pero.json`.

Pero creates `.pero/` (with `logs/` and `run/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting. `pero run` passes its own environment to the daemon it starts.

## Credentials

Pero keeps no provider credentials of its own. It runs Claude Code and Codex with the sign-ins of the account it runs as:

| Provider | Sign in | Check | Stored by the provider CLI in |
|---|---|---|---|
| Claude | `claude auth login` | `claude auth status` | `~/.claude/.credentials.json` (the login Keychain on macOS) |
| Codex | `codex login`, or `codex login --device-auth` on a headless host | `codex login status` | `~/.codex/auth.json`, or under `CODEX_HOME` |

Pero never passes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, or `CODEX_API_KEY` on, so a key in its environment cannot switch you to API billing. When a sign-in expires, `pero status` shows that provider `degraded`; sign in again as the same account and run `pero run` to check again.

The Telegram bot token is Pero's one required secret; the ElevenLabs API key, when a speech engine uses ElevenLabs, is kept the same way in `.env`, and `pero speech configure` stores it. It comes from `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment when that is set, otherwise from the workspace's `.env` (`PERO_TELEGRAM_BOT_TOKEN=…`, a file a systemd `EnvironmentFile=` can read too). It is owner-only and never shown or logged; Pero refuses to read a `.env` that group or others can read, and `pero status` says which `chmod` fixes it. Storing the token writes `.env` atomically, keeping its other lines, and adds `.env` to the workspace's `.gitignore`. When the workspace is in a Git repository, `pero status` reports an error if Git tracks `.env` or would not ignore it. To change it, including after revoking it with @BotFather `/revoke`, run `printf '%s' "$TOKEN" | pero telegram token`; a running Pero switches without a restart. Telegram delivers a bot's updates to one poller at a time, so never run two Peros with the same token: the second shows Telegram `degraded` because another process polls the bot.

## Data layout

Everything Pero owns is in the workspace's `.pero/`:

```text
~/workspace/.pero/       # owner-only
├── pero.sqlite          # the database; pero.sqlite-wal and -shm beside it while Pero runs
├── logs/
│   ├── pero.log         # daemon logs, JSON lines, without message text
│   └── daemon.out       # raw output of a daemon started by `pero run`
├── run/                 # control socket, lock, and process metadata while Pero runs
├── attachments/         # files and recordings people send, a folder per Channel
├── models/              # the local speech engine's models, from pero speech configure
├── tools/               # whisper.cpp and Piper, when pero speech configure installs them
└── config.yaml          # the data folder and the chats Pero serves; commit it
```

`config.yaml` holds what describes the installation, and what Pero itself must not change:

```yaml
data: data               # the data folder Pero keeps notes in; relative to the workspace
telegram:
  allowed-chats:
    - id: -1001234567890 # a group; negative
      title: Home        # for you; Pero doesn't use it
    - id: 123456789      # a direct chat: your user ID
```

- **Created when missing.** `pero init` writes it, and so does Pero's first start when it is missing, with `data: data` (or the folder picked when `pero run` makes the workspace) and no allowed chats. The default `data/` folder is created when missing. Every start also fills in what the system folder is missing of what `pero init` writes: `Pero.md`, `Persona.md`, `Instructions.md`, `Channels/Default.md`, and `Workflows/`, never changing a note that is there.
- **Edited with comments kept.** `pero telegram allow` and `deny`, and a chat's new ID when a group turns on topics, change only their own lines, read the file again right before, and replace it in one step.
- **Checked at startup.** An invalid file stops Pero with the file, line, key, and reason, and so does a `data` folder other than the default that doesn't exist.
- **Edits by hand apply while Pero runs.** Pero looks at the file every 10 seconds. A chat added or removed by hand is served, or turned away, from its next message. A changed `data` or `system` needs a restart, and until then `pero status` shows the `config` component `degraded` saying so. An invalid edit is logged once and shown by `config` too, while the last valid version stays in use.
- **`pero telegram allow` and `deny` work without Pero running:** they then edit the file themselves, and Pero serves the new list from its next start.

The database holds only state; personality, instructions, Channel notes, Workflows, and the defaults are notes:
- **Telegram:** the inbound updates already handled.
- **Channels and Sessions:** each Channel Pero has seen, with its topic's title, and the provider session ID each Session resumes.
- **Message history:** the text of each Channel (see below).
- **Workflow Runs, schedules, and Notifications:** each run with its answer or error, where each schedule stands, and each Notification with its delivery state.

The images, recordings, and other files people send in chats are kept in `.pero/attachments/`, a folder per Channel, outside the database, so they are not in `pero backup`; neither are the speech models in `.pero/models/`.

Outside `.pero/`:
- **Working folders:** the data folder and each folder a Channel note names in `working-directory`. They are yours, such as a notes vault or a project. `pero backup --include-data` adds the data folder; the others are never in Pero's backups.
- **Provider conversations:** Claude Code keeps each session's transcript in `~/.claude/projects/<folder>/`, named after the folder it ran in, except a Workflow run's, which it doesn't save; Codex keeps its threads in `~/.codex/sessions/` and state databases next to it in `~/.codex`. A Session resumes only while its provider still has that conversation.
- **Provider sign-ins:** listed under [Credentials](#credentials).

## Voice messages

The `local` speech engine runs three programs on the host, as the account Pero runs as. When any is missing, `pero speech` (or `pero speech configure`) lists the commands that install them and offers to run them:

- **ffmpeg, and what the rest need to build:** with Homebrew when it is installed, or else the system's package manager (`apt-get`, `dnf`, `pacman`, or `apk`) as root: as `sudo`, which may ask for your password, unless Pero runs as root. `apt-get` also gets `python3-venv`, and when whisper.cpp must be built, `cmake`, a C++ compiler, and `make` are added unless they're installed. Without `sudo`, Pero prints these commands for you to run as root.
- **whisper-cli:** Homebrew's `whisper-cpp`; without Homebrew, Pero downloads whisper.cpp's source (a pinned release) and builds `whisper-cli` in `.pero/tools/`, which takes a few minutes on a small VPS.
- **piper:** the `piper-tts` Python package (a pinned release), in a Python environment of its own in `.pero/tools/piper/`.

What Pero builds itself it links into `.pero/tools/bin/`, where the local engine looks for a program named without a path before it looks on `PATH`, so it needs no change to `config.yaml` or the service's `PATH`. Like the models, `.pero/tools/` isn't in `pero backup`; on a new machine, `pero speech` installs them again. Without a terminal, `pero speech configure --transcribe local --speak local --yes` installs them too, with `sudo -n`, so sudo must not need a password there.

To install them yourself instead, such as on a system Pero doesn't know, put them where the service's `PATH` finds them (`pero service install` records the `PATH` of the shell it runs in), or name them in `speech.programs`:

| Program | For | Install |
|---|---|---|
| `ffmpeg` | converting recordings to and from the formats below | `apt install ffmpeg`, `brew install ffmpeg` |
| `whisper-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | transcribing | `brew install whisper-cpp`, or build it: `cmake -B build && cmake --build build --target whisper-cli`, then put `build/bin/whisper-cli` on `PATH` or name it in `speech.programs.whisper` |
| `piper` from [Piper](https://github.com/OHF-Voice/piper1-gpl) | recording | `pipx install piper-tts` |

Then `pero speech` (or `pero speech configure`) downloads `ggml-base.bin` (whisper.cpp's multilingual base model, 148 MB) and the `en_US-lessac-medium` Piper voice (63 MB) from Hugging Face into `.pero/models/`; `pero speech configure --transcribe local --speak local --yes` does it, and installs the programs, without asking, for scripts. A larger whisper.cpp model transcribes better and more slowly: download it and name it in `speech.transcribe.model`. Piper has [voices in many languages](https://huggingface.co/rhasspy/piper-voices); name the `.onnx` file in `speech.speak.voice`, with its `.onnx.json` beside it.

Pero converts each recording to 16 kHz mono WAV for whisper.cpp, and Piper's WAV to OGG with Opus, which Telegram shows as a voice message. Recordings longer than `speech.transcribe.max-minutes` (60 by default) aren't transcribed. Local Whisper has a configurable 3600-second processing budget; local ffmpeg conversion defaults to 300 seconds. These are separate from recording duration. Each program run is limited in time, and temporary files are deleted after it.

### Files and result previews

Use `/files` in Telegram to see file caps, transfer budgets, audio processing limits, and preview settings. [Configuration](./CONFIGURATION.md#peroconfigyaml) describes `files` and `speech.transcribe`. Large files stream to disk instead of being buffered in the daemon. At most two incoming file messages are processed together; messages in one topic retain arrival order, while other topics and commands remain responsive. `/stop` cancels incoming processing in that topic as well as its agent turn. Shutdown cancels incoming processing before draining agent turns.

For HTML/SVG previews, install Chromium as the service account from the Pero installation directory (`node_modules/@perokit/pero` inside a global npm prefix):

```sh
npx playwright install chromium
# On a host missing browser libraries, an administrator can install them:
npx playwright install-deps chromium
```

Rendering runs in a separate process with a 45-second budget, JavaScript disabled, and remote requests blocked. Local assets must remain inside the design's directory and exclude hidden/private paths. Include a PNG/JPEG for interactive designs. A missing browser or failed preview produces a notice in Telegram, and the original is still attached. WAV/FLAC/AIFF results get a playable MP3 copy using ffmpeg when available, with the original attached as a document.

ZIP attachments are automatically extracted next to the original attachment before the agent starts. This requires `python3` on the host. The extractor supports ZIP64 and validates CRCs; it rejects absolute/traversing paths, backslashes, duplicate paths, symlinks, special files, encryption and unsupported compression. Extraction is limited to 10,000 entries, four times `files.max-mb` (at most 2 GiB total), a 1000:1 per-entry compression ratio and five minutes. Failed/cancelled extraction removes its temporary directory. The agent receives the extracted directory as untrusted data; archive contents are never executed by Pero. History retention removes extracted directories along with old attachments. Large ZIP downloads still require a local Bot API when the cloud download limit is exceeded.

Codex gets the file handoff instructions in every turn input, including resumed sessions. No direct Telegram tool, bot token or network access is required by the agent: it verifies the local file and returns `<file>path</file>`; the host performs the upload.

File diagnostics are metadata only in `.pero/file-events.jsonl`: operation, name, bytes, elapsed milliseconds, success/failure and timestamp. Upload timing covers preparation and delivery of the result, including conversion/preview; preview timing is recorded separately. The owner-only log rotates at 2 MiB to `file-events.previous.jsonl`, keeping one previous file. Neither contents nor full paths nor credentials are recorded. These logs are local diagnostics and are not part of a backup.

`pero status` shows the `speech` component: `ok` with each direction's engine, `unconfigured` when neither works (with the first thing missing), or `degraded` when only one does. It's optional, so it never makes Pero's health `degraded`. Models aren't in `pero backup`; on a new machine, `pero speech` offers to download them again.

## Message history

Pero records the text of each allowed Channel: what people wrote there (for an image or file, a line naming where it is saved), what Pero answered, Pero's own notices (such as the onboarding welcome and failure messages), and the Workflow Notifications delivered there. It uses it to start a fresh Session from the recent conversation, to give a turn the Workflow messages posted since the last message, and as input for Workflows that review chats. `pero channels history <channel>` shows it.

It does not record:
- messages from chats that are not allowed;
- Pero's reasoning, tool use, or tool approval requests;
- messages in a Channel Pero doesn't answer, such as a topic whose note is disabled or has errors and never loaded, and Pero's reply saying why.

Logs never hold message text.

History is kept until you set `history-retention-days`; then messages older than that many days, and the images and files saved before then, are deleted within the hour, every hour, and when Pero starts. Workflow Runs and Notifications keep their own text (the answer a run gave, the message a Notification carried) whatever the setting. Backups contain the history as it was when they were taken, and retention never reaches into them: delete old backups to be rid of it. The providers keep their own transcripts of each Session, with the reasoning and tool activity Pero leaves out, in the stores above. `history-retention-days` does not touch them; Claude Code deletes old ones on its own schedule (its `cleanupPeriodDays` setting).

## Backup

```sh
pero backup ~/backups/pero-$(date +%F).tgz
```

`pero backup` asks the running daemon for a consistent snapshot of the database, taken with SQLite's online backup API while Pero keeps working, and writes it with `config.yaml` and a manifest as an owner-only gzip tar. The file must be outside `.pero/`; one already at that path is replaced. Logs, `run/`, and `.env` are never in it, so a backup has no bot token. The backup holds your message history, so keep it as private as `.pero/`.

`--include-data` adds the data folder, as it is at that moment, for when it isn't in Git or synced elsewhere. Only its files and folders are included, not links, and neither `.pero/` nor `.env` should they be inside it. The file must then be outside the data folder too.

It needs Pero running. To back up every night, add a line to the crontab of the account that runs Pero (`crontab -e`), with the full path to `pero` when cron's `PATH` does not have it:

```text
30 3 * * * cd "$HOME/workspace" && pero backup "$HOME/backups/pero-$(date +\%F).tgz"
```

Back up the rest yourself, with the tool you already use for your files:
- **The workspace:** commit it to a private Git repository. That keeps `config.yaml` and the data folder, including its `System/`, and never the token or the database.
- **Working folders:** each folder a Channel note names in `working-directory`, which `pero channels show` shows, and a data folder outside the workspace. The manifest inside each backup, `pero-backup.json`, lists them too.
- **Provider conversations:** `~/.claude/projects` and `~/.codex` (without `auth.json` when you would rather sign in again), so every Session can resume after a restore. Without them, Pero still restores, and each Channel continues in a fresh Session that starts from its recent messages (see below).
- **Provider sign-ins:** optional. Signing in again after a restore is simpler and keeps the credentials out of your backups; if you do back them up, encrypt that backup.

## Restore

`pero restore <file>` runs without the daemon and never overwrites Pero's database.

It restores into a workspace (the one found from the current folder, or `-w <folder>`, created when missing), whose `.pero/` must have no database, such as a fresh clone of the workspace's repository:
- The database goes into `.pero/`. If Pero starts there meanwhile, the restore stops with nothing changed.
- The workspace's own `config.yaml` is kept, and the restore lists the chats the backup's file allowed that it doesn't; `--replace-config` takes the backup's instead. Without one, the backup's is used.
- A backup made with `--include-data` restores its data folder into the one the workspace's `config.yaml` names, keeping every file already there.

It warns about each folder the workspace uses that does not exist here: the data folder, and each Channel note's own. A file that is not a backup this version of Pero reads is refused before anything changes.

To go back to a backup on the same machine, stop Pero and move its database aside first:

```sh
pero stop
mkdir ~/pero-old && mv ~/workspace/.pero/pero.sqlite* ~/pero-old/
pero restore ~/backups/pero-2026-09-28.tgz
pero run
```

### Moving to a fresh machine

The drill below brings back the workspace from Git and Pero's state from its backup, and every Session resumes where it stopped. `test/restore.e2e-spec.ts` runs the same steps with the fake Bot API and the echo runtime.

1. **Stop Pero on the old machine** (`pero stop`, or stop its service), and take a last backup before that with `pero backup`. The two must never poll the same bot at once.
2. **Install Pero** on the new machine, the same version or a newer one, under an account with the **same home directory path** as before, so that the folders and provider stores keep their paths.
3. **Sign in to the providers** as that account: `claude auth login`, `codex login --device-auth`. Or restore their credential files from your encrypted backup.
4. **Clone the workspace** from its Git repository to the same path, and restore any other working folders from your own backup, at the same paths as before.
5. **Restore the provider conversations**, `~/.claude/projects` and `~/.codex`, from your own backup.
6. **Restore Pero's backup** into the clone:

   ```sh
   cd ~/workspace
   pero restore ~/backups/pero-2026-09-28.tgz
   ```

   A warning names each folder that is still missing; restore it before going on.
7. **Write the bot token** again: `printf '%s' "$TOKEN" | pero telegram token`, a `PERO_TELEGRAM_BOT_TOKEN=…` line in the workspace's `.env`, or the same `PERO_TELEGRAM_BOT_TOKEN` in Pero's environment.
8. **Start Pero:**

   ```sh
   pero run
   pero status
   pero channels show <channel>   # "resumes Session …" for each Channel
   ```

Then write in a topic: Pero answers there in the same conversation.

What to expect afterwards:
- **Schedules** that came due while Pero was down run once, as one catch-up run that records how many times it stands for.
- **Notifications** still waiting to be delivered are delivered, and a Workflow that reads history goes on from where its last successful run stopped.
- **A workspace at a new path** keeps working: its data folder is relative to it. Each Channel then starts a fresh Session that begins with its recent messages, since a provider conversation belongs to its folder.
- **Folders at new paths:** point Pero at them with `data` in `.pero/config.yaml`, then restart it, or `working-directory` in each Channel note that names its own. A provider conversation belongs to its folder, so each Channel whose `working-directory` moved then starts a fresh Session that begins with its recent messages; a moved data folder only changes where every turn's instructions say notes go.
- **Provider conversations not restored:** when a provider no longer has a Session's conversation, Pero closes that Session and answers the same message in a fresh one that begins with the Channel's recent messages, so the Channel keeps working. The same happens when a provider has deleted an old transcript.
- **A newer Pero** applies its migrations to the restored database as it starts.
