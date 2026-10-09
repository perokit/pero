# Pero guide

Pero runs you. It is a self-hosted runtime that connects you to its owner in Telegram and runs Workflows: tasks it does on its own, on a schedule or on demand. Every turn starts with the same personality and instructions, then those of the Channel it is in: a Telegram topic, a group's General topic, or a direct chat. Pero writes this guide on every start, so it matches the running version; don't edit it.

Read it when the owner asks you to change your personality or instructions, a Channel's settings, a Workflow, or Pero's defaults, or asks how Pero works. Your instructions name the files below with their full paths: `Persona.md`, `Instructions.md`, the note of the Channel you're in, `Pero.md`, the `Workflows/` folder, and this guide.

## Where everything is

```text
<workspace>/                      # where Pero runs
├── .env                          # the Telegram bot token and API keys: never read it aloud, never edit it
├── .pero/                        # Pero's own files: don't edit them
│   ├── config.yaml               # the data folder, which chats Pero serves, and speech
│   ├── attachments/              # files and recordings the owner sent, a folder per Channel
│   └── guide.md                  # this guide
└── data/                         # the data folder: the owner's notes, such as an Obsidian vault
    └── System/                   # the system folder
        ├── Pero.md               # installation defaults, settings only
        ├── Persona.md            # Pero's personality: who it is and how it talks
        ├── Instructions.md       # Pero's general instructions, for every Channel
        ├── Channels/
        │   ├── Default.md        # General topics, groups without topics, and direct chats
        │   └── <Title>.md        # one note per topic; its body is that topic's own instructions
        └── Workflows/<Title>.md  # one note per Workflow; its body is what each run asks
```

The data folder and system folder can be elsewhere: your instructions give their real paths.

- **Notes are Markdown with YAML frontmatter,** the block between `---` lines at the top. The body is everything after it. Property names are lowercase and hyphenated. An unknown property is an error; `tags`, `aliases`, and `cssclasses` are allowed and ignored.
- **The file name is the name.** `Channels/Weekly Health.md` is the Channel note titled _Weekly Health_, named `weekly-health`, and Workflows name it so. Subfolders under `Channels/` and `Workflows/` are fine for grouping. Renaming a Workflow note makes a new Workflow, and renaming a Channel note changes what Workflows must call it, so don't rename to "fix" a title unless asked.
- **A Channel note is bound to its topic by `channel-id`,** which Pero writes when it creates the note. Never change or copy it: it is how the note stays with its topic when the topic is renamed in Telegram.
- **Files starting with `_` or `.` are ignored,** such as `Channels/_Template.md`, the template for the notes of new topics.
- **Pero reads only `Pero.md`, `Persona.md`, `Instructions.md`, `Channels/`, and `Workflows/`.** Other folders and files in the system folder are the owner's, such as `Templates/`; a note elsewhere, even in a misspelled `Channel/`, is not read.
- **Paths in notes** are relative to the workspace, not to the note. `~` is the home folder.
- **Pero rereads the system folder every 10 seconds.** An edit applies from the next message or run; no restart is needed.

## How to change settings

1. **Find out what the owner wants,** and ask about what you can't infer (see the checklists below). Don't invent schedules, topics, or models.
2. **Read the note first** when changing one, and change only the properties asked for. Keep comments, other properties, and the body.
3. **Say what you'll write before you write it,** with the file path and the frontmatter, unless the request was already exact.
4. **Write the note.** With Claude and `permissions: ask`, the owner gets Allow or Deny, in the chat, before any edit in the system folder; that's expected. A Workflow run has no one to ask, so it can't change settings. With Codex and `ask`, you can write only inside your own folder.
5. **Check it.** Pero posts an "Errors in …" message in the chat when a note doesn't validate, and keeps the note's last good version meanwhile. You can run `pero check` to validate everything (it may ask the owner first). Tell the owner what changed, and how to see it, such as `pero workflows show <name>`.

Never edit `.env` or anything in `.pero/`, and never add allowed chats: only the owner can, on the host, with `pero telegram allow`.

### Changing personality and instructions

- **Personality** is `Persona.md`'s text: who Pero is and how it talks, such as "be less formal" or "always answer in German". It applies in every Channel.
- **General instructions** are `Instructions.md`'s text: what Pero knows and does everywhere, such as "my notes are in Journal/".
- **A Channel's own instructions** are the body of its note: what applies in that topic only, such as "my training log is in Health/Log.md" in the Health topic. Unless the owner says it's for everywhere, a request in a topic is about that topic's note.
- Both `Persona.md` and `Instructions.md` hold text only: properties there are errors.

### Creating a Workflow

Agree on these before writing `Workflows/<Title>.md`:

- **Title:** the file name. Short, as it'll show in `pero workflows`, such as `Evening review`.
- **What each run does:** the note's body, sent as the run's input. It can't be empty. Write it as a complete request to someone who sees nothing else: name the files to read and write, and the shape of the answer. The answer is what gets posted. A run that should sometimes post nothing, such as a check that finds all in order, must say when to answer exactly `NO_REPLY`: that answer notifies no one.
- **When:** days, hours, and minute, or `cron`, and the time zone if it differs from `Pero.md`'s `timezone`. Without any, it runs only by hand.
- **Where the answer goes:** `channel`, a Channel note's name or a list of them. Its first Channel also gives the run its settings and instructions. Without it, the run's answer is only kept in `pero runs`, and it runs with `Default.md`'s.
- **Chat history,** only if it should review conversations: `history: true`, and `{{history}}` in the body where the transcript goes. The transcript holds what people wrote and Pero's replies, in the Workflow's own Channels unless `history-channels` says otherwise: `current` (its `channel`s, or `Default.md`'s Channels without one), `default` (the General topics and direct chats `Default.md` answers), `all`, or Channel names, mixed in a list. A run with no messages still runs, with a note that there were none: say in the body to answer `NO_REPLY` then, if it should stay quiet.

A run starts a fresh conversation, apart from the chat. It can't ask the owner anything: with `permissions: ask`, tools that would need approval, such as shell commands, web fetches, and settings edits, are refused. Say so if the task needs them; `permissions: bypass` in that Channel's note lifts this, but suggest it only if the owner wants it.

### Changing a Channel

To create a topic when the owner asks, create the actual Telegram topic before editing its note. Writing a Markdown note alone does not create a topic.

- The owner can send `/topic <name>` in the group, including inside another topic. Pero creates the topic in that same group and returns a link.
- Prefer proposing a name on a standalone line as `<topic>Name</topic>` in your answer. Pero shows Create topic and Cancel buttons; creation happens only after confirmation. This also works with Codex's sandbox. Do not say the topic exists before it is confirmed. Proposals expire after 15 minutes or a restart; ask again when a button has expired.
- You can run `pero telegram topic <chat-id> "<name>"` from the workspace. Find the group's ID from the current note's `channel-id` (`telegram:<chat-id>:<topic-id>`), or `pero channels ls`. If the destination is ambiguous, ask; never invent a chat ID or add allowed chats.
- Pass the name as one safely quoted argument; do not interpolate user text as shell code. Use this only when the owner asks to create a topic. With `permissions: ask`, a command may need approval; respect a denial and do not bypass it.
- The group must already be allowed, Topics must be enabled, and the bot must be an administrator with **Manage Topics** permission. The name must be 1–128 characters.
- Pero immediately creates and binds the new topic's note using its normal Channel template. Read that note before editing its instructions or settings, and preserve its `channel-id`.
- If creation cannot be confirmed, check the group's topics before retrying: Telegram may have created it even if the connection failed.

- **Topics:** each Telegram topic has its own note in `Channels/`, which Pero writes from `Channels/_Template.md`, or its own template, on creation through Pero or the first time someone writes there. `Default.md` is for the General topic of every group, groups without topics, and direct chats.
- **Settings the owner may ask about:** `model`, `effort`, `provider`, `permissions`, `working-directory`, `enabled`.

## Properties

### `Pero.md`

| Property                        | Values                             | Default            | Meaning                                   |
| ------------------------------- | ---------------------------------- | ------------------ | ----------------------------------------- |
| `provider`                      | `claude`, `codex`                  | `claude`           | Provider of Channels that don't name one  |
| `claude-model`, `codex-model`   | model name                         | provider's default | Model for that provider's Channels        |
| `claude-effort`, `codex-effort` | that provider's levels             | provider's default | Effort for that provider's Channels       |
| `permissions`                   | `ask`, `bypass`                    | `ask`              | How tools are approved                    |
| `timezone`                      | IANA zone, such as `Europe/Berlin` | the host's         | Time zone for schedules                   |
| `history-carryover`             | 0 or more                          | 50                 | Messages a fresh conversation starts with |
| `history-retention-days`        | whole days, or empty               | keep everything    | Delete older message history              |
| `max-concurrent-runs`           | 1–10                               | 2                  | Workflow runs at once                     |

It holds settings only: text after its frontmatter is an error. Changing a default changes every Channel that doesn't set its own value.

### Channel notes

| Property              | Values            | Default                       | Meaning                                                                       |
| --------------------- | ----------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `channel-id`          | written by Pero   | none                          | The Channel the note is bound to; not on `Default.md`                         |
| `provider`            | `claude`, `codex` | `Pero.md`                     | Which provider answers there                                                  |
| `model`               | model name        | `Pero.md` `<provider>-model`  | Its model                                                                     |
| `effort`              | provider's levels | `Pero.md` `<provider>-effort` | Its effort                                                                    |
| `permissions`         | `ask`, `bypass`   | `Pero.md`                     | How its tools are approved                                                    |
| `working-directory`   | path              | the workspace                 | The folder its turns work in                                                  |
| `skip-git-repo-check` | `true`, `false`   | `false`                       | Let Codex work outside a Git repository                                       |
| `enabled`             | `true`, `false`   | `true`                        | `false` silences its Channel and stops the schedules of Workflows that use it |

Claude efforts are `low`, `medium`, `high`, `xhigh`, and `max`; Codex efforts are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Changing `provider` or `working-directory` starts a fresh conversation that carries over the topic's recent messages; other changes keep it.

### Workflow notes

| Property           | Values                                                                    | Default                       | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `day`              | `monday`…`sunday`, `daily`, `weekdays`, `weekends`, or a list of weekdays | `daily`                       | Days it runs                                                        |
| `hour`             | 0–23, or a list                                                           | none: runs only by hand       | Hours it runs                                                       |
| `minute`           | 0–59                                                                      | 0                             | Minute of those hours                                               |
| `cron`             | five-field cron, or `@daily` etc.                                         | none                          | Instead of `day`/`hour`/`minute`, never with them                   |
| `timezone`         | IANA zone                                                                 | `Pero.md` `timezone`          | Time zone of the schedule                                           |
| `channel`          | Channel note name, or a list                                              | none                          | Where each run's answer is posted; the first gives its settings     |
| `history`          | `true`, `false`                                                           | `false`                       | Read chat history as input                                          |
| `history-channels` | `all`, `current`, `default`, Channel note names                           | `current`                     | Only these Channels' history                                        |
| `history-hours`    | 1–720                                                                     | since the last successful run | A fixed window instead                                              |
| `max-attempts`     | 1–10                                                                      | 1                             | Times a run may start, counting restarts after Pero stopped mid-run |
| `enabled`          | `true`, `false`                                                           | `true`                        | `false` stops its schedule; it can still run by hand                |

One schedule per Workflow; for two different schedules, write two notes. Examples:

| Wanted                         | Properties                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| Every day at 21:00             | `hour: 21`                                                         |
| Weekdays at 9:00 and 18:00     | `day: weekdays`, `hour: [9, 18]`                                   |
| Sundays at 12:30               | `day: sunday`, `hour: 12`, `minute: 30`                            |
| Monday and Thursday at 8:00    | `day: [monday, thursday]`, `hour: 8`                               |
| The 1st of each month at 10:00 | `cron: 0 10 1 * *`                                                 |
| Every 15 minutes               | `cron: "*/15 * * * *"` (quoted: YAML can't start a value with `*`) |

A Workflow note:

```markdown
---
day: weekdays
hour: 8
minute: 30
channel: Health
---

Read Health/Log.md and post a short plan for today's workout, based on the last week.
```

### Naming Channels

`channel` and `history-channels` name Channels three ways (`history-channels` also takes `all`, `current`, and `default`):

- **A Channel note's name,** such as `Health` for `Channels/Health.md`: the topic the note is bound to. This is the usual way, and keeps working when the topic is renamed in Telegram. A note without a `channel-id` yet can't be named until someone writes in its topic.
- **`General`,** a group's General topic, which `Default.md` answers. When Pero serves several groups, write `<chat title>/General`, such as `Home/General`.
- **A Channel ID** from `pero channels`, such as `channel: 5`, for a direct chat.

To post into the topic you're talking in, use its note's name, or `General` in the General topic. When unsure, ask the owner which Channel.

## How Pero works

- **Telegram:** Pero serves only the chats allowed in `.pero/config.yaml`. In a group with topics, each topic is one conversation, with its own note; the General topic, groups without topics, and direct chats use `Default.md`.
- **Conversations:** each Channel keeps its conversation across messages and restarts. Pero also records the chat's text, so a fresh conversation (after a provider or folder change) starts with the recent messages, and Workflows can read it.
- **Commands:** Pero answers these in the chat itself; you never see them or their answers. `/status` shows the Channel's note and settings, its conversation and how full its context is, and Pero's health; `/new` starts the Channel's conversation over, without the messages before it; `/stop` stops your answer in progress and drops the messages waiting for you; `/model` and `/effort` show the Channel's model or effort with buttons to change it in its note; `/workflows`, `/run`, `/runs`, `/cancel`, and `/retry` show, start, and manage Workflow runs; `/help` lists them. Point the owner to them when they fit, such as `/new` to start a fresh subject. Any other `/word` reaches you as text.
- **Permissions:** with Claude and `ask`, you read and edit in your folder freely, and the owner is asked in the chat (Allow and Deny buttons) before anything else, including any edit in the system folder. With Codex and `ask`, you run in a sandbox that writes only in your folder, without network, and the owner is never asked. `bypass` runs every tool without asking.
- **Workflows:** a schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run. A run's answer is posted to its `channel` Channels; those messages become part of their conversations, so the owner can reply to them.
- **Formatting:** your answers are Telegram messages. Pero shows their Markdown as Telegram's formatting: bold, italic, strikethrough, `||spoiler||`, inline code, fenced code blocks, links, and `>` quotes; a heading is a bold line and a `-` list item starts with a bullet. Telegram has no tables, so Pero shows a table as a monospace block with its columns lined up, or row by row as `Header: value` lines when it is wider than a phone; emphasis never spans lines. Should Telegram reject the formatting, the answer is sent as written.
- **Voice messages:** a voice message, round video message, or audio file the owner sends reaches you as a line naming the recording, then its transcript. When your instructions say you can answer by voice, a `<voice>…</voice>` block in your answer is recorded and sent as a voice message, with the rest as text, in order; this works in Workflow answers too. How Pero transcribes and records is `speech` in `config.yaml`, which the owner sets up and changes with `pero speech` on the host, never by editing files: `local` (whisper.cpp, Piper, and ffmpeg on the host) or `elevenlabs` (an API key in `.env`).
- **Generated files:** put each intended result on a standalone `<file>path/to/result.ext</file>` line (up to ten files). Pero sends it to the originating topic, within the Channel's working folder or data folder. Never request hidden/private files or credentials. Images appear inline, MP3/M4A as playable audio, and other formats as documents. Static HTML/SVG gets a PNG preview when Chromium is installed; WAV/FLAC/AIFF gets an MP3 copy when ffmpeg is available. Failed delivery produces a notice in the chat. `/files` shows file and processing limits. Large incoming files require a local Telegram Bot API; raising Pero's cap alone cannot bypass Telegram's cloud limits. Host settings belong to the owner; do not edit them in a turn.
- **Broken notes** never stop Pero: it keeps the last good version and reports the errors in the chat.

The owner manages Pero from the host's terminal:

| Command                                        | What it does                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pero status`                                  | Whether Pero runs, and the health of each part                                          |
| `pero check`                                   | Validate every note                                                                     |
| `pero channels`, `pero channels show <id>`     | Topics and chats with their notes, and one Channel's settings and where each comes from |
| `pero workflows`, `pero workflows show <name>` | Workflows with their next run, and one Workflow                                         |
| `pero workflows run <name>`                    | Run a Workflow now                                                                      |
| `pero runs`, `pero runs show <id>`             | Recent runs, and how one ended                                                          |
| `pero settings`                                | The defaults in effect                                                                  |
| `pero telegram allow <chat>`                   | Allow a chat                                                                            |
| `pero speech`, `pero speech configure`         | Whether voice messages work, setting them up, and changing engines                      |
| `pero logs -f`                                 | Follow the log                                                                          |

The full documentation is at https://github.com/perokit/pero/tree/main/docs.
