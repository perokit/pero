# Configuring Pero

Pero is configured by files in its workspace. Its personality, its instructions, each Channel, each Workflow, and the installation defaults are Markdown notes, which you can edit in Obsidian on your desktop or phone, commit to Git, and copy to another server. Pero's database keeps only state: conversations, message history, runs, and delivery queues.

| File | What it configures | Who changes it |
|---|---|---|
| [`.env`](#env) | The Telegram bot token | You, on the host |
| [`.pero/config.yaml`](#peroconfigyaml) | Where the data folder is, and which chats Pero serves | You, on the host, or `pero telegram allow`/`deny` |
| [`System/Pero.md`](#systemperomd) | Defaults | You, from anywhere the vault syncs to |
| [`System/Persona.md`, `System/Instructions.md`](#systempersonamd-and-systeminstructionsmd) | Pero's personality, and the instructions every Channel shares | You, from anywhere the vault syncs to |
| [`System/Channels/*.md`](#channel-notes), [`System/Workflows/*.md`](#workflow-notes) | Each Channel's instructions and settings, and Workflows | You, from anywhere the vault syncs to |

[`examples/workspace/`](../examples/workspace/) is a complete workspace to start from.

## The workspace

```text
~/workspace/                         # the workspace: where Pero runs; can be a Git repository
├── .env                             # secrets, owner-only, Git-ignored: PERO_TELEGRAM_BOT_TOKEN=…
├── .gitignore                       # Pero makes sure it lists .env
├── .pero/                           # Pero's own files
│   ├── config.yaml                  # host settings: data folder, allowed chats (commit it)
│   ├── .gitignore                   # written by Pero: ignores everything else in .pero/
│   ├── pero.sqlite                  # state: Sessions, history, runs, Notifications
│   ├── guide.md                     # written by Pero on each start: how Pero changes these settings
│   ├── attachments/                 # images and files sent in chats, a folder per Channel
│   ├── logs/
│   └── run/
├── data/                            # the data folder, such as an Obsidian vault
│   ├── System/                      # the system folder
│   │   ├── Pero.md                  # installation defaults
│   │   ├── Persona.md               # Pero's personality: every turn starts with it
│   │   ├── Instructions.md          # Pero's general instructions, after the personality
│   │   ├── Channels/
│   │   │   ├── Default.md           # General topics, groups without topics, and direct chats
│   │   │   ├── Health.md            # the "Health" topic's own instructions and settings
│   │   │   └── _Template.md         # optional: starting point for the notes of new topics
│   │   └── Workflows/
│   │       ├── Weekly health report.md
│   │       └── Evening review.md
│   ├── Reports/                     # whatever Pero and you write
│   └── …
└── projects/                        # optional: scripts, repositories, other folders Pero can work in
    └── site/
```

| Location | Holds | In Git | In `pero backup` |
|---|---|---|---|
| `.env` | The Telegram bot token | Never | Never |
| `.pero/config.yaml` | Where the data folder is, which chats are allowed | Yes | Yes |
| `.pero/pero.sqlite` | Sessions, message history, runs, Notifications, schedule state | No | Yes |
| `.pero/attachments/` | Images and files people sent in chats | No | No |
| `data/System/` | Defaults, personality, instructions, Channel notes, Workflows | Yes | With `--include-data` |
| `data/` (the rest) | Your notes and Pero's work | Your choice | With `--include-data` |

Every `pero` command works on one workspace, found in this order: `--workspace <dir>` (`-w`), then `PERO_WORKSPACE`, then the nearest folder holding `.pero/` from the current folder upward (never the home folder itself), then `~/workspace` when it holds `.pero/`. `pero init [dir]` makes one: a `.gitignore` listing `.env`, `.pero/` with its `.gitignore` and a commented `config.yaml`, and in the system folder `Pero.md`, `Persona.md`, `Instructions.md`, `Channels/Default.md`, and an empty `Workflows/`. `Pero.md` lists every setting as a property, so Obsidian shows each one to change: Pero's defaults are written out, `timezone` is the host's, so you can see the zone schedules use and change it to yours, and `provider`, the models, efforts, `permissions`, and `history-retention-days` are empty, which keeps their defaults; the first `pero run` fills in `provider` and `permissions`. `Default.md` lists its `provider`, `model`, `effort`, and `permissions` empty, so it follows `Pero.md` until you set one. It never overwrites a file, so running it in a cloned workspace only fills in what's missing; `pero run` does the same each time it starts, so `Persona.md`, `Instructions.md`, and `Default.md` are always there.

To set Pero up on another server, clone the workspace and run it:

```sh
git clone git@github.com:me/my-pero.git ~/workspace
cd ~/workspace
pero run     # asks for the bot token and writes it to .env
```

The allowed chats are in the committed `config.yaml`, and each Channel note keeps the `channel-id` of its topic, so the same group keeps working with the same notes. [Operating Pero](./OPERATIONS.md#moving-to-a-fresh-machine) describes bringing the database along too.

## Conventions

- **Notes are Markdown with YAML frontmatter,** as Obsidian writes them. The frontmatter is the block between `---` lines at the very top, and everything after it is the body. A note without frontmatter is valid: every property takes its default.
- **Property names are lowercase words joined by hyphens,** like `claude-model`. Unknown properties are errors, so a typo like `modle:` doesn't pass silently. Obsidian's own properties are allowed and ignored: `tags`, `aliases`, and `cssclasses`.
- **An empty property is not set.** A property Obsidian shows without a value takes its default.
- **The file name is the name.** `System/Channels/Weekly Health.md` is the Channel note titled *Weekly Health* and named `weekly-health`, and `System/Workflows/Weekly Health.md` the Workflow of that name. The name is a slug: lowercase, accents dropped, Cyrillic spelled in Latin letters. Two notes of one kind with the same name are an error. Renaming a Workflow note makes a new Workflow (see [Renaming notes](#renaming-notes)).
- **Subfolders are allowed** under `Channels/` and `Workflows/` for your own grouping. They don't change the name.
- **The rest of the system folder is yours.** Pero reads only `Pero.md`, `Persona.md`, `Instructions.md`, and the notes under `Channels/` and `Workflows/`, so other folders and files there, such as Obsidian's `Templates/`, are left alone. A note in a misspelled folder, such as `Channel/`, is skipped too, so check the folder name when a note doesn't apply.
- **Ignored files:** names starting with `_` or `.`, and anything that isn't `.md`. That leaves room for templates and drafts, such as `_Template.md` and `_Ideas.md`.
- **Lists can be written either way:** `channel: Health` and `channel: [Health]` mean the same. Obsidian gives each property name one type across the vault, so it's best to keep `channel` and `day` as the List type everywhere.
- **Paths:** `~` is your home directory. A relative path is relative to the **workspace** (the folder containing `.pero/`), not to the note, so a cloned workspace keeps working wherever it's cloned.

## `.env`

Secrets, in the workspace root, next to `.pero/`:

```sh
PERO_TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
ELEVENLABS_API_KEY=sk_…   # only with an elevenlabs speech engine
```

- **Format:** one `KEY=value` per line; `#` starts a comment, and `export` and quotes are allowed. The same file works as a systemd `EnvironmentFile=`.
- **Never committed.** `pero init` and storing the token add `.env` to the workspace's `.gitignore` when it isn't there yet. `pero check` and `pero status` report an error when the workspace is in a Git repository that tracks `.env` or wouldn't ignore it.
- **Must be owner-only.** Pero refuses to read it when it is readable by group or others, and says which `chmod` fixes that, as `ssh` does for keys.
- **Written for you:** an interactive `pero run` asks for a missing token and writes this file itself (mode `0600`), keeping any other lines in it. So does `pero telegram token`, and `pero speech configure` for the ElevenLabs key.
- **Environment wins:** a variable already in Pero's environment overrides the file.
- **Only Pero's own secrets.** Claude and Codex sign-ins stay where their CLIs keep them (`~/.claude`, `~/.codex`).

Each workspace has its own `.env`, so two workspaces on one account can run two bots.

## `.pero/config.yaml`

Host settings: what describes this installation, and what Pero itself must not be able to change.

```yaml
# Data folder: the vault Pero keeps notes in. Relative to the workspace. Default: data
data: data

# System folder. Relative to the workspace. Default: <data>/System
# system: data/System

telegram:
  # The chats Pero serves. Anyone who can post in an allowed group reaches Pero.
  allowed-chats:
    - id: -1001234567890   # a group; negative
      title: Home          # for you; Pero doesn't use it
    - id: 123456789        # a direct chat: your user ID

# Voice messages; every setting is optional.
speech:
  transcribe:                # the voice messages you send
    engine: local            # local, elevenlabs, or off. Default: local
    model: .pero/models/ggml-base.bin   # local: a whisper.cpp model; elevenlabs: scribe_v1
    language: en             # Default: detected
    max-minutes: 60          # recording duration limit, 1–240 minutes. Default: 60
    timeout-seconds: 3600    # local Whisper processing budget, 1–86400 seconds
    convert-timeout-seconds: 300 # ffmpeg conversion budget, 1–86400 seconds
  speak:                     # the voice messages Pero sends
    engine: local            # local, elevenlabs, or off. Default: local
    voice: .pero/models/en_US-lessac-medium.onnx   # local: a Piper voice; elevenlabs: a voice ID
    model: eleven_multilingual_v2                  # elevenlabs only
  programs:                  # what the local engine runs, by name or path; a name is looked for in .pero/tools/bin/, then on PATH
    ffmpeg: ffmpeg
    whisper: whisper-cli
    piper: piper

# Incoming files and generated results; every setting is optional.
files:
  max-mb: 512                # actual streamed bytes, 1–2000 MiB
  download-timeout-seconds: 600
  upload-timeout-seconds: 600
  previews: true             # static HTML/SVG image previews
  # telegram-api-root: http://127.0.0.1:8081
  # telegram-local-file-root: /srv/telegram-bot-api
```

- **Hand edits and `pero telegram allow`/`deny` are equivalent.** The commands edit this file and keep comments and ordering, and work without Pero running. Pero rereads the file within 10 seconds either way: a chat added or removed is served, or turned away, from its next message.
- **Chat ID changes:** when turning on topics gives a group a new chat ID, Pero rewrites that entry itself.
- **Changing `data` or `system` needs a restart.** Until then, `pero status` shows the `config` component `degraded` saying so. A folder that doesn't exist stops startup with a message naming the key.
- **`speech` is written for you** by `pero speech configure`, which asks which engine to use for each direction and changes only those lines; editing it by hand works too.
- **`speech` applies from the next voice message.** Each direction has its own engine. `local` runs whisper.cpp, Piper, and ffmpeg on the host, with the models `pero speech configure` downloads to `.pero/models/` unless `model` or `voice` names other files, relative to the workspace; a Piper voice needs its `.onnx.json` beside it. `elevenlabs` needs `ELEVENLABS_API_KEY` in `.env` or Pero's environment; `voice` is an ElevenLabs voice ID, which `pero speech voice` picks from your account's voices; without one, Pero speaks with ElevenLabs' *George*. These are host settings, since the programs run on the host: a turn can't change them.
- **An invalid file** stops startup with the file, line, key, and reason. An invalid edit while Pero runs is logged and shown by `pero status`, and the last valid version stays in use.

**File limits:** `max-mb` limits both incoming files and outgoing originals. The limit is checked against actual bytes during downloads, including when size metadata is missing. Partial downloads are removed. Transfer budgets and preview settings apply to new operations; restart Pero after changing `telegram-api-root` or the client's upload timeout. `telegram-local-file-root` is the explicitly allowed directory for absolute paths returned by a local Bot API, including shared storage mounted at the same path.

Telegram's cloud Bot API still limits downloads to 20 MiB and most uploads to 50 MiB. Increasing `max-mb` cannot override this. To receive large ZIPs, run an authenticated [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), migrate the bot as Telegram documents, and configure its URL here. It supports uploads up to 2000 MiB and downloads without a Telegram size limit; Pero's own cap still applies. A proxy to the cloud API does not lift cloud limits. ZIPs are saved as attachments for the agent's tools, not automatically extracted.

The local processing budget is separate from recording duration: a 30-minute recording can take longer than 30 minutes to transcribe on a small VPS. `timeout-seconds` controls local Whisper, while `convert-timeout-seconds` controls local ffmpeg conversion. Cloud speech engines keep their provider-specific timeouts. Actual converted recording duration is checked too, so missing Telegram metadata does not bypass the duration limit.

The data folder can be an existing vault anywhere, such as `data: ~/notes`. Pero works in the workspace, where your scripts, Git repository, and other tools are, unless a Channel note names another folder; every turn's instructions say where the data folder is, so that's where Pero keeps notes and other files it writes for you.

## `System/Pero.md`

Installation defaults. Each value applies to every Channel and Workflow that doesn't set its own, and applies **live**: changing `claude-model` here changes every Claude Channel without its own `model` from its next turn.

`Pero.md` holds settings only. Text after its frontmatter is an error: instructions every Channel shares go in [`Instructions.md`](#systempersonamd-and-systeminstructionsmd).

```markdown
---
provider: claude
claude-model: opus
claude-effort: high
codex-model: gpt-5.5
permissions: ask
timezone: Europe/Berlin
history-carryover: 50
history-retention-days: 90
max-concurrent-runs: 2
---
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `provider` | `claude`, `codex` | `claude` | Provider of Channels whose note names none |
| `claude-model`, `codex-model` | provider model name | provider's default | Model for that provider's Channels |
| `claude-effort`, `codex-effort` | that provider's levels | provider's default | Effort for that provider's Channels |
| `permissions` | `ask`, `bypass` | `ask` | How tools are approved ([user guide](./USER_GUIDE.md#with-claude)) |
| `timezone` | IANA zone | the host's | Time zone for schedules and transcripts |
| `history-carryover` | 0 or more | 50 | Messages a fresh Session starts with, none from before a `/new`; 0 turns it off |
| `history-retention-days` | whole days, or empty | empty: keep everything | Delete message history, and the images and files sent in chats, older than this |
| `max-concurrent-runs` | 1–10 | 2 | Workflow runs at once |

A missing `Pero.md` means all defaults, as does a broken one that hasn't loaded since Pero started (see [Broken notes](#broken-notes)).

## `System/Persona.md` and `System/Instructions.md`

What every turn shares, in every Channel: `Persona.md` is Pero's personality, who it is and how it talks, and `Instructions.md` its general instructions, what it knows and does everywhere. Both hold text only: a property other than Obsidian's own is an error.

```markdown
You are a calm, concise personal assistant. Reply in the language you're written to in.
```

Every turn's instructions are, in order:

1. Where the data folder is and where Pero's settings are, with the path of the Channel's note and of `.pero/guide.md`, which Pero reads before changing them.
2. `Persona.md`.
3. `Instructions.md`.
4. The body of the Channel's note.

Empty parts are left out. There is no opting out: a topic that needs to differ says so in its own note. Edits apply from the next turn and keep the Session. `pero init` writes both, and `pero run` writes either again when it's missing.

**Pero knows where its settings are,** so you can ask it in Telegram to "create a Workflow that…", "answer me less formally", or "use opus" here, and it asks what it needs, such as when a Workflow should run and where it should post, and writes the note. See [Asking Pero](./USER_GUIDE.md#asking-pero-to-change-settings).

## Channel notes

`System/Channels/<Title>.md`, one per Channel. The body is that Channel's own instructions, after `Persona.md` and `Instructions.md`, and its properties its settings.

```markdown
---
channel-id: telegram:-1001234567890:5
provider: claude
model: sonnet
effort: high
permissions: ask
---
You are my health coach. My training log is in Health/Log.md; append each workout I tell you about.
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `channel-id` | `<integration>:<address>`, written by Pero | none | The Channel the note is bound to. Not on `Default.md` |
| `provider` | `claude`, `codex` | `Pero.md` `provider` | Which provider answers there |
| `model` | model name | `Pero.md` `<provider>-model` | Model, for this note's provider |
| `effort` | provider's levels | `Pero.md` `<provider>-effort` | Effort, for this note's provider |
| `permissions` | `ask`, `bypass` | `Pero.md` `permissions` | How its tools are approved |
| `working-directory` | path | the workspace | The folder its turns work in, relative to the workspace (such as `projects/site`) |
| `skip-git-repo-check` | `true`, `false` | `false` | Let Codex work outside a Git repository |
| `enabled` | `true`, `false` | `true` | `false` silences its Channel and stops the schedules of the Workflows that use it |

**`Default.md`** answers the General topic of every allowed group, groups without topics, and direct chats, each in a Session of its own. It has no `channel-id`: setting one is an error. `pero init` writes it, `pero run` writes it again when it's missing, and so does the first message in a primary Channel that finds none. Its settings are not inherited: every other Channel follows `Pero.md` for what its own note leaves out.

**Which note a topic uses** is worked out on every message:

1. The note whose `channel-id` is the topic's, such as `telegram:-1001234567890:5`: the chat's ID, then the topic's.
2. Otherwise, a note without `channel-id` named as the topic's title, ignoring case and accents, such as a `Health.md` you wrote before the topic existed. Pero adds the topic's `channel-id` to it, which binds it to that topic for good.
3. Otherwise, Pero writes `Channels/<Topic title>.md` for it, with its `channel-id`, and posts a welcome naming the note. The note starts from `Channels/_Template.md` when you've added one, or else from Pero's own: the settings listed empty, so they follow `Pero.md`. Characters file names can't hold are replaced, and when the name is taken, as by a topic of the same title in another group, the file is numbered: `Health 2.md`.

Pero answers from the first message either way. A topic whose title Pero hasn't seen yet, such as one it learns of from a reply, gets its note once a message tells its title.

**The template for new topics** is `Channels/_Template.md`. `pero init` doesn't write it; add it when the notes Pero writes for new topics should start with more. Its name starts with `_`, so it's never a Channel note itself. Pero copies its properties, comments included, and its body, and sets `channel-id`:

```markdown
---
# The starting point for the note of a new topic: Pero copies these
# properties and this text, and sets channel-id to the topic's.
# provider: claude
# model: sonnet
# effort: high
# permissions: ask
---
You are my assistant for this topic.
```

**Renaming a topic** in Telegram changes nothing in its note: the note is bound by `channel-id`, so it stays with the topic, keeps its file name, and Workflows that name it keep working. The same goes for a topic renamed while Pero is stopped. You may rename the note's file yourself; the topic keeps it, but Workflows naming the old name need the new one.

**Don't copy a `channel-id`** into a second note: two notes bound to one Channel are both left out, and Pero reports the conflict on both until one of them loses it.

## Workflow notes

`System/Workflows/<Title>.md`. The body is the input each run sends, as written, headings included, and must not be empty. `{{history}}` in it is replaced by the chat transcript when the Workflow reads history.

```markdown
---
day: sunday
hour: 12
channel: Health
---
Create a weekly report in the Reports folder from Health/Log.md…
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `day` | `monday`…`sunday`, `daily`, `weekdays`, `weekends`, or a list of weekdays | `daily` | Days it runs |
| `hour` | 0–23, or a list | none: without it or `cron`, it runs only by hand | Hours it runs |
| `minute` | 0–59 | 0 | Minute of those hours |
| `cron` | five-field cron, or `@daily` etc. | none | For anything `day`/`hour`/`minute` can't say; not together with them |
| `timezone` | IANA zone | `Pero.md` `timezone` | Time zone of the schedule |
| `channel` | Channel note name, or a list | none | Where each run's answer is posted, unless it is just `NO_REPLY`; the first gives the run its note |
| `history` | `true`, `false` | `false` | Read chat history as input ([user guide](./USER_GUIDE.md#reading-chat-history)) |
| `history-channels` | `all`, `current`, `default`, Channel note names, or a list | `current`: the Channels `channel` names, or `Default.md`'s without one | Whose history it reads; `default` is every Channel `Default.md` answers |
| `history-hours` | 1–720 | since the last successful run | A fixed window instead |
| `max-attempts` | 1–10 | 1 | Times a run may start, counting restarts after Pero stopped mid-run |
| `enabled` | `true`, `false` | `true` | `false` stops its schedule, which it keeps; it can still be run by hand |

A Workflow has at most one schedule. Any Workflow can be run by hand with `pero workflows run <name>`, with a schedule or without.

**Schedules:** `day: sunday`, `hour: 12`, `minute: 0` is `0 12 * * 0`. `day: weekdays` and `hour: [9, 18]` is `0 9,18 * * 1-5`. Times the clocks skip or repeat follow the daylight-saving rules in [Architecture §8](./ARCHITECTURE.md#8-scheduling-and-recovery).

**Which note a run uses:** the note of its first `channel`, so a run posted to Health has Health's instructions, model, and folder, after `Persona.md` and `Instructions.md`. Without `channel`, it uses `Default.md`. A run whose note is disabled doesn't start.

**Channels in `channel` and `history-channels`** are named three ways, and `history-channels` also takes `all`, `current`, and `default`:

- **A Channel note's name,** such as `Health` for `Channels/Health.md`: the topic it is bound to by `channel-id`. This keeps working when the topic is renamed in Telegram. A note without `channel-id` yet means the topic of its title that no note is bound to, once Pero has seen it.
- **`General`,** a group's General topic, answered from `Default.md`. When several allowed groups have one, write `<chat title>/General`, such as `Home/General`. `Default` itself is no Channel: it answers several.
- **A Channel ID** from `pero channels`, such as `5`, for a direct chat.

A Channel Pero hasn't seen yet has no known address: write something in it first. Until then, the Workflow is left out, and `pero status` and `pero check` report it. Without Pero running, `pero check` checks note names against the notes and leaves the rest for when it runs.

## Validation

`pero check` validates the whole workspace and exits 1 on any error, naming the file and property. It works with or without a running Pero:

- **With Pero running,** it asks the daemon, which also resolves the Channels Workflows name against those it has seen.
- **Without Pero, or in CI on a workspace repository,** it reads the files itself and checks everything except whether those Channels exist.

```text
data/System/Workflows/Weekly health report.md
  channel: no Channel note named "Helth"; Channel notes: English, Health
data/System/Channels/Coach.md
  modle: unknown property (did you mean model?)

2 problems in 2 files.
```

`--json` prints the result for tools.

## How Pero reads the files

Pero holds the whole configuration in memory as one snapshot: `Pero.md`, `Persona.md`, `Instructions.md`, every Channel note, and every Workflow, with references resolved. A turn or run uses the snapshot current when it starts, until it finishes. **Every 10 seconds**, Pero rescans the system folder, rereads only the notes whose size or modification time changed, and swaps in a new snapshot when anything did, logging which files changed. Edits arrive the same way whether you make them in Obsidian, through Syncthing or `git pull`, or Pero makes them.

| Change | Takes effect |
|---|---|
| A Channel note's `provider` or `working-directory` | Its Channel's next turn, in a fresh Session that carries over recent messages |
| `Persona.md`, `Instructions.md`, a Channel note's instructions, `model`, `effort`, or `permissions`, `Pero.md` defaults, the data folder the instructions name | The next turn, in the same Session |
| A Channel note's `channel-id`, or a note added, removed, or renamed | The next message in the Channels it binds or leaves |
| `enabled: false` | Its Channel stops getting answers; the schedules of Workflows that use it pass without a run |
| Workflow schedule (`day`, `hour`, `minute`, `cron`, `timezone`) | Its next run is computed from the time of the change; times already passed are not caught up |
| Workflow body or other properties | Its next run |
| Workflow removed or `enabled: false` | No more scheduled runs; runs its schedule queued are cancelled (all its waiting runs, when removed), and a running one finishes |
| `config.yaml` allowed chats | The next message from that chat |

### Broken notes

A broken note never takes Pero down:

- **A note that doesn't parse or validate** is left out, along with only the notes that depend on it, such as a Workflow whose `channel` names it. While Pero runs, its **last good version** stays in use, so a typo in a note's properties doesn't silence its Channel. After a restart, a note that is still broken isn't loaded until it's fixed, and its Channel isn't answered meanwhile: Pero never falls back to the defaults for a Channel whose note has errors.
- **A Workflow whose `channel` doesn't resolve,** such as a topic Pero hasn't seen, is left out until it does.
- **Half-written files** are not errors: Pero reports a note only when it fails twice in a row with the same size and modification time.

Problems are reported in four places:

- **`pero status`:** the `system` component is `degraded`, counting the notes with errors.
- **`pero check`:** every error, with its file and property.
- **The log:** each error once, when it appears, and again when it's fixed.
- **Telegram:** since you'll often edit on your phone, Pero posts one message per broken version of a note, naming each error and what Pero uses meanwhile: *"Errors in data/System/Workflows/Weekly health report.md: channel: no Channel note named "Helth"… It's left out until it's fixed."* It goes to the Channels the note relates to (a Channel note's Channel, a Workflow's `channel`), or else to a General topic or direct chat, and isn't part of the Channel's history. A fix is only logged, and notes already broken when Pero starts are left to `status` and `check`.

When a message arrives in a Channel Pero can't answer, because its note is disabled or has never loaded, Pero replies once saying why.

### Renaming notes

State in the database names a Workflow by its name, so it outlives the note: runs record the Workflow's name and what they ran, and a Workflow's history window starts after its last completed run of that name. Renaming a Workflow note is therefore a new Workflow: it starts its history window 24 hours back, as a new Workflow does, and its schedule starts from the rename. The old name's runs stay in `pero runs`.

A Channel's Session belongs to the Channel, not to its note's name, so renaming a Channel note keeps the conversation, and its `channel-id` keeps it bound to its topic. Workflows that name the note by its old name need the new one. Moving a note to another subfolder keeps its name, so nothing changes.

### What Pero writes

Configuration is yours. Pero writes to it only in these cases, and logs each write:

| When | Writes |
|---|---|
| `pero init` | The skeleton files that don't exist yet |
| `pero run` | `Persona.md`, `Instructions.md`, and `Channels/Default.md`, when one is missing |
| Pero starts | `.pero/guide.md`, the guide to these settings, when it differs from this version's. It isn't configuration: don't edit it |
| A token is stored (`pero run` asks for it, or `pero telegram token`) | `.env`, and the `.env` line in `.gitignore` if it's missing |
| `pero telegram allow`/`deny` | The `allowed-chats` list in `config.yaml` |
| A group gets a new chat ID (topics turned on) | That entry's `id` in `config.yaml`, and the `channel-id` of its Channel notes |
| A topic without a note | A new `Channels/<Topic title>.md` with its `channel-id`. Characters file names can't hold are replaced, and an existing file is never overwritten (`Health 2.md`) |
| A topic whose title names a note without `channel-id` | That note's `channel-id` |
| A General topic or direct chat while `Default.md` is missing | `Channels/Default.md` |
| `/model` or `/effort` in a Channel | That Channel note's `model` or `effort` |

Edits to existing files change only the one value, keeping comments, ordering, and the body. Every write is atomic, so Obsidian and Syncthing never see half a note.

## Security

**Pero can edit configuration.** Pero works in the workspace by default, and the system folder is inside it. That's deliberate, since "be less formal" should work. But a turn could also change its Channel's `permissions` or add a Workflow. So:

- **Claude with `ask`:** an edit under the system folder always asks in the Channel, with Allow and Deny buttons, even though Pero may otherwise edit its folder freely. So does an edit of `.pero/` or `.env`. Workflow runs have no one to ask, so they can't change configuration.
- **Codex with `ask`:** the `workspace-write` sandbox allows writes anywhere in the folder and can't leave out a subfolder, so it can edit the system folder, `.pero/config.yaml`, and `.env` too. A Codex Channel that must not touch configuration needs a `working-directory` that holds none of them, such as `data` or `projects/site`.
- **`bypass`** can change anything.
- **Every applied change is logged** with the files that changed. When the workspace is a Git repository, `git diff` shows exactly what Pero changed.

**Access control is in the workspace root.** Allowed chats are in `.pero/config.yaml` and the token is in `.env`, outside the data folder but inside the workspace Pero works in by default. Every turn can read them, and a Codex `ask` turn or a `bypass` turn can edit them. To keep them out of reach in a Channel, give its note a `working-directory` that doesn't contain them.

**Committed configuration is not secret.** Chat IDs, prompts, and schedules end up in Git, so keep that repository private. The token never goes there: `.env` is Git-ignored, and Pero reports it if Git would commit it.
