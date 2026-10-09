# Pero user guide

How Pero behaves once it is installed: first-run setup and settings, Telegram, its personality, instructions, and Channel notes with their permissions, and Workflows. Every file and property is in [Configuring Pero](./CONFIGURATION.md); for installing, upgrading, backups, and running Pero as a service, see [Operating Pero](./OPERATIONS.md); for every command and option, see the [CLI reference](./CLI.md).

## Running Pero

```sh
pero run                # start in the background; waits until ready
pero status             # process, health, and components
pero stop               # graceful stop; waits until it exits
pero logs -f            # recent log entries, then new ones
pero run --foreground   # attached; logs to stdout
```

`pero run` starts Pero detached in its own session, so it keeps running after the terminal closes, and reports the running Pero instead of starting a second one. Pero's own stdout and stderr (startup errors, crashes) go to `logs/daemon.out`; on a failed start, `pero run` prints that output and both log paths. `pero stop` and a repeated `pero run` are safe when there is nothing to do. `pero status` exits 3 when Pero is stopped. Commands that need Pero running fail with `Pero isn't running — start it with pero run` rather than starting it.

`pero logs` prints the last 50 entries of `logs/pero.log` as readable lines in local time (`-n <count>` for more or fewer); `--follow` keeps streaming new entries, waiting for the file if Pero has not written it yet, and `--json` prints the raw lines for `jq`. It reads files only, so it works whether or not Pero is running. It does not stream `logs/daemon.out`, but it names that file on stderr when it has content.

Every command works on the workspace found from the current folder (the nearest folder holding `.pero/`), or takes `--workspace <dir>` (`-w`) to name one. With none found, `pero run` on a terminal offers to make one in the current folder, or in `~/workspace` from the home folder. `pero init [dir]` makes one without starting Pero; it only fills in what's missing, so it also completes a cloned one. Other commands say which `pero init` to run. See [Configuration](./OPERATIONS.md#configuration).

## First-run setup and settings

The first `pero run` in a workspace on a terminal, before Pero has a database, settles the provider Pero uses. With both the Claude Code and Codex CLIs installed, it asks which one; with one, it uses it; with neither, it refuses to start and says how to install one. It then waits while that CLI is signed out (`claude auth login` or `codex login` in another terminal, then Enter), and refuses to start if you quit. The choice is written as `provider:` in `Pero.md`, unless `Pero.md` already sets one, which is then the one checked. It then asks how tools are approved by default, `ask` (selected first) or `bypass` (see [With Claude](#with-claude) and [With Codex](#with-codex)), and writes it as `permissions:` in `Pero.md`, unless `Pero.md` already sets one; picking `bypass` with Claude as root warns that Claude Code refuses it there unless `IS_SANDBOX=1` is set. A later `pero run` on a terminal that finds `Pero.md` missing, as after you delete the system folder, settles both the same way and writes a whole `Pero.md` with them; without a terminal, Pero writes `Pero.md` with `provider` and `permissions` empty, which means `claude` and `ask`. With `PERO_FAKE_RUNTIME=echo` no provider is needed and neither is asked for.

Pero starts even when nothing is configured, reporting what is missing as degraded. `pero run` then checks what is still needed: sign-in for the providers in use (the default provider, plus any provider a Channel note uses), and the Telegram bot token. On a terminal it asks for each one, each step in a block of its own: the token shows as `*` while you type or paste it, and it waits while you run `claude auth login` or `codex login` elsewhere. Without a terminal it prints the missing settings with the commands that fix them and returns at once. After a first start, an interactive `pero run` offers to install Pero as a service (see [Operating Pero](./OPERATIONS.md#install-and-upgrade)); after a first start or any setup it ends with what `pero status` shows, so you can see that Pero is running and what each component reports. If you leave setup before it finishes, with Ctrl-C or by closing the terminal or connection, the Pero it started is stopped again; run `pero run` to pick up where you left off.

```sh
pero settings                                   # show everything
printf '%s' "$TOKEN" | pero telegram token      # set the bot token
```

The installation defaults are properties of `Pero.md` in the system folder; Pero's personality and the instructions every Channel shares are `Persona.md` and `Instructions.md`. The data folder is `data` in `.pero/config.yaml`. `pero settings` shows them. `pero telegram token` sets the Telegram bot token, read from a prompt on a terminal, otherwise from stdin, and never accepted as an argument. It goes owner-only into the workspace's `.env` and is never shown or logged. Changes apply without a restart.

Pero rereads the notes every 10 seconds, so an edit applies without a restart. A note with errors doesn't stop Pero: `pero status` counts it, and `pero check` lists each error. Since you may edit on your phone, Pero also posts once per broken version of a note in Telegram, in the Channels it relates to (a Channel note's Channel, a Workflow's `channel`), or else in a General topic or direct chat. The message names each error and what Pero uses meanwhile: the note's last good version, if Pero read one since it started, or nothing. It isn't part of the Channel's history. A fix is only logged, and a note already broken when Pero starts is left to `status` and `check`.

## Telegram

### Set up Telegram

Pero talks to you in a private Telegram group with topics, where each topic is a conversation with instructions and settings of its own:

1. Create a bot with [@BotFather](https://t.me/BotFather) and give Pero its token: an interactive `pero run` asks for it, or `pero telegram token` reads it from a prompt or stdin.
2. Create a private group and turn on Topics in its settings. Telegram gives the group a new chat ID when topics are turned on; Pero follows it. Keep the group private: anyone who can write in an allowed chat can talk to Pero, so a public group, which anyone can find and join, is a danger that `pero status`, `pero telegram chats`, and `pero run` point out.
3. Add the bot to the group as an administrator. Otherwise Telegram shows it only commands, mentions, and replies, unless you turn off its privacy mode with @BotFather `/setprivacy`.
4. Allow the group. Write anything in it: the bot answers with the group's chat ID and the command to run on the host, `pero telegram allow <chat-id>`. An interactive `pero run` asks first whether you will use a private group (recommended) or a direct chat with the bot, shows the steps for that choice, then waits for that message and offers to allow the chat itself; meanwhile the bot answers that chat that it can be confirmed in the terminal. Once a chat that asked to pair is allowed, the bot posts the first steps there: which provider and model answer, where Pero's personality and instructions are (`Persona.md` and `Instructions.md`, which every Channel starts with), how topics get notes of their own (or, in a direct chat, how to set up a group with topics), which time zone schedules use and where to change it and other defaults (`Pero.md`, where `pero init` sets the host's zone), and how to ask for a Workflow. A chat allowed otherwise, such as in `config.yaml` or before the bot connects, gets them with its first message.
5. Create a topic for each conversation you want. A new topic gets a note of its own, `Channels/<Topic title>.md`, bound to it by its `channel-id` and written from `Channels/_Template.md` when you add one ([the template](./CONFIGURATION.md#channel-notes)), or from Pero's own, and the bot posts where the note is. Its turns start with `Persona.md` and `Instructions.md`, then the note's text. Renaming the topic keeps its note, which stays bound to it. The General topic uses `Channels/Default.md`, which Pero writes again if it is missing.
6. Optionally, allow a direct chat with the bot too: message the bot, then allow your user ID the same way. It uses `Default.md` too, in a conversation separate from the General topic.

Before signing in to a provider, you can try the whole setup with the echo runtime: `PERO_FAKE_RUNTIME=echo pero run` (see [Checking a real bot by hand](./TESTING.md#checking-a-real-bot-by-hand)).

### How it works

To create a topic from the chat, send `/topic <name>` in an allowed group or ask Pero to create one. An agent proposes the name with Create topic and Cancel buttons; it creates nothing until someone confirms. A proposal expires after 15 minutes or a restart. Enable Topics in the group and give the bot administrator **Manage Topics** permission. Pero creates the topic's Channel note immediately and returns a link; it never creates a topic in a direct chat or adds a group to the allowlist. Like other chat commands, anyone who can write in the allowed group can use it. From the host, use `pero telegram topic <chat-id> "<name>"`. Check the group's topics before retrying a failed creation, since a lost network response does not mean Telegram created nothing.

With a bot token set, Pero long-polls Telegram for messages and membership changes. `pero status` shows `telegram ok Connected as @<bot>` once connected and serving a chat, and `degraded` while connecting, while no chat is allowed, when Telegram can't be reached, when another process polls the same bot, when the bot is not an administrator of an allowed group (Telegram then shows it only commands, mentions, and replies), or when an allowed group is public. A token Telegram rejects shows as `unconfigured`, like a missing one. Telegram shows no read status for messages a bot receives, so while Pero works on a message, the message carries a 👀 reaction; it goes away once the answer, or a notice saying why there is none, is posted, or once `/stop` ends the turn. A message waiting behind another in the same topic has it too. A group whose administrators don't allow that reaction simply gets none. Replies go to the topic they answer; the General topic, a group without topics, and a direct chat are answered without a topic. Long replies are split into several messages. Pero's answers use Telegram's formatting where it helps: the agent writes Markdown, and Pero shows its bold, italic, strikethrough, `||spoiler||`, code, links, and `>` quotes as Telegram formatting, a heading as a bold line, and a `-` list item with a bullet; Telegram has no tables, so a table is shown as a monospace block with its columns lined up, or, when that is too wide for a phone, row by row as `Header: value` lines. A message split for length never cuts a table in two. Should Telegram reject the formatting, the answer is sent as written. Other bots' messages are ignored. When enabling topics gives a group a new chat ID, Pero moves its Channel and its entry in `config.yaml` to the new ID.

### Commands

Pero answers a few commands itself, in the topic or chat they are sent in; the bot lists them in Telegram's `/` menu. Neither a command nor Pero's answer joins the Channel's history, so no turn or Workflow sees them. Any other `/word`, such as `/plan the week`, is answered as text. A command for another bot in the group, such as `/status@other_bot`, is ignored.

| Command | What it does |
|---|---|
| `/status` | How Pero answers here: whether it is answering (and for how long, and how many messages wait), the Channel's note (`Config:`), provider, model, effort, permissions, and folder with where each comes from, its Session (when it started and how many turns it had), how full its context is, and its note's errors. Then each part of Pero and its state, as `pero status` shows them. Where Pero doesn't answer, it says why and what to edit. |
| `/new` | Starts the conversation here over: Pero's next answer begins a new provider conversation that carries over nothing from before `/new`, unlike a fresh Session after a provider change. An answer in progress is stopped. The history is kept, for Workflows and `pero channels history`. |
| `/stop` | Stops Pero's answer in progress here, and the messages waiting behind it, which it never answers. Its open tool requests are denied. The conversation stays as it was. |
| `/model [name]` | Without a name, the Channel's model and where it comes from, with a button for each well-known one (`opus`, `sonnet`, and `haiku` for Claude) and each the workspace already uses. With a name, or by pressing one, Pero sets `model` in the Channel's note, keeping its comments, and writes the note first if it has none; `default` removes it, so `Pero.md` or the provider decides. It applies from the next answer, in the same conversation. |
| `/effort [level]` | The same for `effort`, offering the levels of the Channel's provider; a level the provider doesn't have shows the choices again. |
| `/workflows [name]` | Each Workflow with when it runs next and how its latest run went, and a button for each. A Workflow's own screen shows its note, the Channel note its runs use, its schedule, the topics it posts to, and its latest runs, with Run now and Runs. |
| `/run [name]` | Runs a Workflow now, as `pero workflows run` does. Without a name, or with one that matches no Workflow, it offers a button for each. A Workflow is named by its name or its title, in any case. |
| `/runs [name]` | The latest runs, or one Workflow's, with a button for each; a run's screen shows its times, error, and the start of its answer, with Cancel or Retry when they apply. `/runs #42` opens run 42. |
| `/cancel [id]` | Cancels a waiting or running run, as `pero runs cancel` does; without an ID, or with one that can't be cancelled, it offers those that can be. |
| `/retry [id]` | Runs a failed, interrupted, or cancelled run again, once, as `pero runs retry` does; without an ID it offers those that can be. |
| `/help` | Lists the commands. |

Some answers have buttons: `/status` offers Stop (while Pero answers), New session, Refresh, Model, and Effort, `/help` the common commands, and the Workflow commands a button for each Workflow or run. Pressing one edits the same message rather than sending a new one, and a button that starts over asks first. Anyone in the chat may use the commands and their buttons, as with the Allow and Deny buttons. `/model` and `/effort` edit the note directly, so the approval Claude with `ask` asks for settings edits doesn't apply; to change `permissions`, edit the note.

`/status` shows context only with Claude: the tokens the conversation held after the latest answer, out of the model's context window. Codex reports only the tokens a whole turn used, which overstates the context, so the line is left out.

### Allowed chats

Pero serves only the chats allowed on its host. A chat it does not serve gets, at most once an hour, a reply naming its chat ID and the command that allows it:

```sh
pero telegram                         # the bot, allowed chats, and chats that asked to pair
pero telegram allow -1001234567890    # a group (negative ID) or a direct chat (your user ID)
pero telegram deny -1001234567890     # its Channels and notes stay for when it is allowed again
```

`pero telegram chats` shows for each allowed group whether topics are on and whether the bot is an administrator, and warns of a public one. Once the token works, an interactive `pero run` explains how to set up a group or a direct chat, waits for the first message to the bot, and offers to allow that chat. For each allowed group where Telegram says the bot is not an administrator, it waits until the bot is made one; for each public group, it shows the danger and checks again once you have made it private. Enter or `s` skips either step, and the next `pero run` asks again. A non-interactive `pero run` lists all of these among what is missing.

### Images and files

Send Pero a photo, or any file (a PDF, a spreadsheet, a CSV, code, a JPEG, PNG, GIF, or WebP image), with or without a caption, and it answers with the file in view: "What does this receipt add up to?", "Summarize this contract", "Save this whiteboard to my notes". An album of several photos or files sent at once is answered once, with every part and caption. Pero saves each owner-only in `.pero/attachments/<Channel ID>/`, a file under the name it was sent with, and starts the message with a line naming where, such as `[Image attached, saved at /home/me/workspace/.pero/attachments/3/20261003-061700-512-1.jpg]` or `[File attached: Q3 report.pdf, saved at /home/me/workspace/.pero/attachments/3/20261003-061700-513-1-Q3_report.pdf]`, so it can copy a file into your notes when you ask, and later turns can still find it. When Telegram can't hand a file over, such as one over the 20 MB bots may download, Pero says so and doesn't answer the message; send it again. Videos and stickers aren't read yet; their caption is answered as text. Voice messages are described next.

Claude sees an image of up to 3.75 MB, and a PDF of up to 5 MB and 20 pages, with the message, and reads any other file, or a larger one, from where it is saved, without asking, whatever its permissions. Codex is handed every image and reads other files itself with its tools; for a PDF that takes a tool such as `pdftotext` or Python on the machine. Files aren't in the Git repository or in `pero backup`, and `history-retention-days` deletes them along with the messages.

### Voice messages

Send Pero a voice message, a round video message, or an audio file, and it answers what was said. Pero saves the recording in `.pero/attachments/<Channel ID>/` like any file, transcribes it, and the message's text becomes the transcript under a line naming the recording, such as:

```text
[Voice message, 0:42, saved at /home/me/workspace/.pero/attachments/3/20261003-061700-514-1.ogg. Transcript:]
Remind me to call Ana tomorrow at ten.
```

Later turns and Workflows that read the chat see those words. A recording that can't be transcribed (transcription is off or not set up, it fails, or the recording is longer than `max-minutes`) gets a reply saying why; Pero still answers a caption that came with it, and otherwise doesn't answer.

Pero can answer by voice too. Ask for it ("answer by voice", or in a Workflow's note, "send the summary as a voice message") and Pero puts what to say in a `<voice>…</voice>` block of its answer; Pero records the block and sends it as a voice message, with the rest of the answer as text, in order. The history keeps the words, under `[Voice message]`. When a block can't be recorded, its words are sent as text, saying why. Pero only knows it can do this while recording works; `pero speech` shows whether it does.

Set speech up with `pero speech`. It says whether Pero can transcribe and record voice messages, and when it can't yet, offers to set them up there and then. The first `pero run` offers it too. Setup asks how to handle each direction:

- **Local**, the default: free and private, on your server. Transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and recording [Piper](https://github.com/OHF-Voice/piper1-gpl), with [ffmpeg](https://ffmpeg.org) converting between formats. Setup checks that the three programs are installed and offers to install any that aren't: it shows the commands, then runs them when you choose *Install them now*, with `sudo` for the system's packages, which may ask for your password. It builds whisper.cpp in `.pero/tools/` when Homebrew can't install it, which takes a few minutes. You can also install them yourself in another terminal and choose *check again*; [Operations](./OPERATIONS.md#voice-messages) lists what each needs. It then downloads a whisper.cpp model and an English Piper voice to `.pero/models/` (about 210 MB).
- **ElevenLabs**: [ElevenLabs](https://elevenlabs.io)' speech-to-text and voices, billed by ElevenLabs. Setup asks for your API key, hidden as you type, checks it with ElevenLabs, and stores it in `.env`; then it lists your account's voices for Pero to speak with. The key needs the permissions below.
- **Off**: voice messages get a reply saying so, and Pero never records one.

#### ElevenLabs API key permissions

ElevenLabs lets you limit what an API key may do. Create the key at [ElevenLabs' API keys page](https://elevenlabs.io/app/settings/api-keys) with these permissions, or edit an existing key there to add them:

| Permission | What Pero uses it for | Needed when |
| --- | --- | --- |
| **Text to Speech** | recording the voice messages Pero sends | Pero speaks with ElevenLabs |
| **Voices**: Read | listing your voices, in `pero speech configure` and `pero speech voice` | Pero speaks with ElevenLabs |
| **Speech to Text** | transcribing the voice messages you send | Pero transcribes with ElevenLabs |
| **User** | checking the key when setup stores it | optional: without it, setup stores the key unchecked |

When a permission is missing, Pero names it, both in the terminal and in the note it sends in place of a voice message, such as `the ElevenLabs API key lacks the "Voices: Read" permission; edit the key at https://elevenlabs.io/app/settings/api-keys`. Changing an existing key's permissions needs nothing from Pero. If you make a new key instead, `pero speech configure` stores it. Then run `pero speech voice` to pick a voice.

#### Changing the voice

`pero speech voice` lists your ElevenLabs account's voices, the premade ones and any you have added or cloned, and lets you pick the one Pero speaks with. Give a voice's name or ID to set it without asking, such as `pero speech voice George`. `--list` only lists them, with `*` at the current one. A key without the **Voices** permission can't list voices; `pero speech voice <voice-id>` still sets one by its ID, as shown in your ElevenLabs voices. If no voice was ever picked, Pero speaks with ElevenLabs' *George*. If ElevenLabs has no voice with the ID Pero uses, Pero's note says so and `pero speech voice` picks another. The local engine's voice is a Piper model file, set as `voice` in `config.yaml` (see [Configuration](./CONFIGURATION.md)).

```sh
pero speech              # can Pero transcribe and record voice messages? offers setup when it can't
pero speech configure    # change how: local or ElevenLabs for each direction, the key, the voice
pero speech voice        # list your ElevenLabs voices and pick one; or pero speech voice <name or ID>
```

`pero speech configure` asks the same questions whenever you want to change something, such as moving from local to ElevenLabs. It writes `speech:` in `.pero/config.yaml` and the key in `.env` for you, and a running Pero uses the change from the next voice message. Without a terminal, give the answers as options: `pero speech configure --transcribe local --speak elevenlabs --yes`, with the key piped in.

`pero status` lists a `speech` component too. It's optional: Pero is healthy without it.

### Channels and history

Each topic, General topic, and direct chat is a Channel, created when it first reaches Pero. Which note it uses is worked out on every message: `Default.md` for General topics, groups without topics, and direct chats, and for a topic the note bound to it by `channel-id`. To silence one, set `enabled: false` in its note. Where Pero doesn't answer, such as a topic whose note has errors, it replies once saying why. `pero channels` lists them by ID:

```sh
pero channels                  # each Channel with its note, then notes no Channel uses
pero channels show 3           # its settings and where each comes from, or why Pero doesn't answer
pero channels history 3 -n 50  # its latest messages
```

`/new` starts a Channel's conversation over without carrying anything over (see [Commands](#commands)).

Pero keeps each Channel's message history until you set `history-retention-days` in `Pero.md`: then messages, and the images and files sent with them, older than that many days are deleted within the hour, and every hour after, including when Pero starts. Removing it keeps everything again. Workflow Runs and Notifications keep their own text, such as a run's answer, whatever the setting. [Operating Pero](./OPERATIONS.md#message-history) describes exactly what the history keeps.

## Personality, instructions, and Channel notes

Every turn's instructions are, in order: where the data folder and Pero's settings are, `Persona.md`, Pero's personality, `Instructions.md`, its general instructions, then the text of the Channel's note. Each Channel's note, in the system folder's `Channels/` folder, also chooses its provider, model, effort, permissions, and folder; anything it leaves out comes from `Pero.md`. Pero writes a topic's note the first time someone writes there; to change one, edit it; to silence a Channel, set `enabled: false`. The [configuration reference](./CONFIGURATION.md#channel-notes) lists every property.

```markdown
---
channel-id: telegram:-1001234567890:12
provider: codex
working-directory: projects/training
---
You are my running coach. My plan is in Plan.md.
```

A note without `working-directory` works in the workspace, where your scripts, Git repository, and other tools are. Every turn is told where the data folder is, and that's where Pero keeps notes and other files it writes for you. Changing a note's provider or folder makes its Channel's next turn start a fresh Session that carries over the Channel's recent messages; model, effort, and instructions apply from the next turn of the same Session.

### Asking Pero to change settings

Pero knows where `Persona.md`, `Instructions.md`, the Channel's note, `Pero.md`, and the Workflows are, and reads its guide (`.pero/guide.md`, which Pero writes on each start) before changing them. So you can manage Pero from Telegram:

- *"Create a Workflow that summarizes my health log every Sunday evening."* Pero asks what it can't infer, such as the hour, the time zone, and which topic gets the summary, shows the note, and writes `Workflows/<Title>.md`.
- *"Be less formal"* changes `Persona.md`; *"use opus here"* or *"my log is in Health/Log.md"* changes the note of the Channel you're in.
- *"How do Workflows read chat history?"* gets an answer from the guide.

With Claude and `permissions: ask`, Pero asks you with Allow and Deny buttons before it writes anything in the system folder, and a Workflow run never changes settings. A broken note is reported in the chat as when you edit it yourself. The welcome Pero posts in a new topic names its note, if you'd rather edit it.

### With Claude

With `provider: claude`, Pero runs Claude Code through the Claude Agent SDK, signed in with the Claude Code sign-in of the account running Pero (`claude auth login`). Pero never passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on, so a key in Pero's environment cannot switch you to API billing. A turn works in its folder like Claude Code does: Claude Code's own system prompt with the turn's instructions appended, and your user, project, and local Claude Code settings, so the folder's `CLAUDE.md`, skills, and MCP servers apply. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Tools run under one of two permission modes, the Channel note's `permissions`, or `Pero.md`'s:

- `ask` (the default): reading and editing files in the turn's folder runs freely, except editing the system folder and Claude Code's, Git's, and the shell's own files there, such as `.claude/` and `.git/`, even through a symlink or a `../` path; those edits, and any other tool that needs permission, such as a shell command or a web fetch, ask in the Channel: Pero posts what it wants to run with Allow and Deny buttons, which anyone in the chat may press, and marks the message with who answered. A request not answered within 10 minutes, whose turn ends, or still open when Pero stops is denied. Requests are not part of the Channel's history. A Workflow run has no one to ask, so it is refused such tools and can't change the system folder. Allow rules in your own Claude Code settings still apply before Pero is asked.
- `bypass`: every tool runs without asking, like `claude --dangerously-skip-permissions`. Claude Code refuses this mode when it runs as root unless `IS_SANDBOX=1` is set.

### With Codex

With `provider: codex`, Pero runs Codex through the Codex SDK, which bundles its own Codex CLI, signed in with the ChatGPT sign-in of the account running Pero (`codex login`, or `codex login --device-auth` on a headless host). Pero never passes `OPENAI_API_KEY` or `CODEX_API_KEY` on and forces the ChatGPT sign-in, so neither an environment variable nor a stored API-key login can switch you to API billing. A turn works in its folder like the Codex CLI does: your `~/.codex/config.toml` and the folder's `AGENTS.md` apply, and the turn's instructions are added as developer instructions. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Codex works only in a Git repository. For a folder that is not one, such as a notes vault, run `git init` there, or skip the check with `skip-git-repo-check: true` in the Channel's note; until then its turns are refused with that advice.

Codex runs each turn without a way to ask you, so the permission modes map to its sandbox instead:

- `ask`: Codex's `workspace-write` sandbox. A turn reads anywhere, and edits files and runs commands only in its own folder, without network access; anything else fails and Pero says why. It is never asked about, so Telegram approval buttons do not apply to Codex. On Linux the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict by default through AppArmor; there Codex `ask` turns cannot write at all until that is allowed (`codex sandbox -- true` checks it). The sandbox can't leave out a subfolder, so unlike Claude, Codex with `ask` edits the system folder without asking when its folder contains it; give a Codex Channel that must not change configuration a `working-directory` outside the system folder.
- `bypass`: no sandbox, like `codex --dangerously-bypass-approvals-and-sandbox`.

## Workflows

A Workflow is work Pero does on its own: a note in the system folder's `Workflows/` folder, whose text is the input each run sends. Its properties say when it runs and where its answer goes; the note's file name is its title, and its name is that title as a slug (`Evening review.md` is `evening-review`).

```markdown
---
hour: 21
channel: Coaching
max-attempts: 2
---
Review today's chats.
```

You can also ask Pero to write one ([Asking Pero](#asking-pero-to-change-settings)). `hour` (with `day` and `minute`), or `cron`, sets its schedule, in `Pero.md`'s `timezone` unless it sets its own; without one, it runs only by hand. Its runs use the note of its first `channel`, its instructions, model, and folder; without `channel`, `Default.md`'s. `enabled: false` stops its schedule. Edits apply from the next run, within about 10 seconds; the [configuration reference](./CONFIGURATION.md#workflow-notes) lists every property.

```sh
pero workflows                      # each Workflow's schedule, next run, and Channels
pero workflows show evening-review  # its note, Channel note, input, and schedule
pero workflows run evening-review   # run it now, whatever its schedule, and print the answer
```

### Schedules and runs

A schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run when it starts again, which records how many it stands for; so do times that come due while the previous run of the same schedule is still waiting to start. An edited schedule applies as soon as Pero reads the note, from its next time, catching nothing up; so does a renamed note, which starts a history window of its own too. A schedule whose Channel note is disabled passes its times without a run. Disabling or deleting a Workflow drops its schedule's saved times, so enabling it again catches nothing up, and cancels its runs waiting to start: those its schedule queued once it is disabled, all of them once it is deleted. A run under way finishes. Each run starts a provider conversation of its own, apart from every Channel's Session and history, with its Channel note's settings as they were when the run started. Nothing resumes it, so with Claude, Pero doesn't have Claude Code save its transcript; Codex still saves the run's thread in `~/.codex/sessions/`. At most `max-concurrent-runs` run at once (default 2), and one at a time per Workflow.

A run Pero stops before it finishes, by crashing or through `pero stop` once the shutdown timeout has passed, is recorded `interrupted` when Pero starts again. Its turn may already have changed files, so it is not started again unless the Workflow allows more than one attempt (`max-attempts`, at most 10); then it is queued again as a new run with the next attempt number, until it has started that often.

```sh
pero runs            # the latest runs
pero runs show 7     # how run 7 ended, the history it read, and whom it notified
pero runs retry 7    # run a failed, interrupted, or cancelled run 7 again
pero runs cancel 7   # cancel run 7
```

`pero runs cancel <id>` cancels a run: one waiting to start never does, and a running one has its turn stopped. `pero runs retry <id>` queues a failed, interrupted, or cancelled run again as a new run with the next attempt, whatever `max-attempts` allows, reading the same Channel history.

### Receiving files and results

Send a document or ZIP with a description of what you want done. `/files` shows the active limits; on a small server, a large audio recording can take several minutes. Pero posts a processing notice for large uploads and recordings, then their bytes and elapsed time. You can use other topics while it processes, or `/stop` to cancel processing in the current topic. The cloud Telegram API cannot download files over 20 MiB; receiving larger files requires a local Bot API configured by the server's owner.

Ask Pero to attach the result in the chat. Generated images appear inline, MP3/M4A files in the audio player, videos as video, and other files as downloadable documents. Static HTML/SVG designs get a screenshot and their source file when Chromium is installed. WAV/FLAC/AIFF results get an MP3 preview when ffmpeg can convert them. Results go to the topic that requested them. If delivery fails, Pero says so in the chat; a path alone does not count as delivery.

Agents request delivery with a standalone `<file>relative/path.ext</file>` line, or a standalone Markdown image/file link pointing to a local file. Use files inside the Channel's working directory or the data folder. Hidden/private files and paths outside those folders are refused. Up to ten files can be attached per answer. The same directives work for Workflow answers when their files are in the workspace or data folder.

### Reading chat history

A Workflow can read Channel history as its input, so Pero can review your chats on a schedule. With `history: true`, each run puts a transcript of the conversation, what people wrote and what Pero answered, since the previous successful run (the last 24 hours for the first) in place of `{{history}}` in its input, or after the input. The next run starts where that one ended, so each message is read once, and a retry reads the same messages as the run it retries. `history-hours` reads a fixed window instead.

By default a run reads the Channels its `channel` names; a Workflow without `channel` runs with `Default.md`, so it reads the General topics and direct chats `Default.md` answers. `history-channels` reads others: `current` for those, `default` for every Channel `Default.md` answers, `all` for every Channel, or Channels named as `channel` names them. A list can mix them, such as `[current, Health]`; `all` stands alone.

A run with no messages to read still runs, with `[No messages in this window]` as its transcript. To stay quiet then, say so in the note: *"If there are no messages, answer exactly NO_REPLY."* The longest transcripts keep their newest messages and say how many older ones they left out.

```markdown
---
hour: 21
history: true
channel: English
---
Suggest better English for: {{history}}
```

### Notifications

Each Channel a Workflow's `channel` names gets a Notification of each run that finishes, holding the run's answer under the Workflow's title, or why the run failed; an interrupted run that is retried leaves none, and its retry does. Cancelled runs notify no one, and neither does a run whose whole answer is `NO_REPLY`. That lets a check stay quiet when all is well:

```markdown
---
hour: 11
channel: Health
---
Read today's note in Journal/. If it has no breakfast entry, remind me to log breakfast. If breakfast is already logged, answer exactly NO_REPLY and nothing else.
```

The run still completes, with `NO_REPLY` as its answer in `pero runs`; a run that fails still notifies. `channel` names a topic by its Channel note's name, such as `Health`, which keeps working when the topic is renamed; `General` for a group's General topic, `<chat title>/General` when several groups have one; or a Channel ID from `pero channels` for a direct chat. The Channel must be one Pero has seen in an allowed chat: until then the note has an error, which `pero status` and `pero check` report.

Notifications are recorded together with the run's final status and delivered to the Channel within seconds. While Telegram can't be reached, delivery retries with a growing wait for about a day before the Notification is marked failed. A Notification to a chat that is no longer allowed fails at once. A delivered Notification joins the Channel's history as a `workflow` message, and the next message you send there reaches Pero with it, so you can reply to it: ask about a suggestion right where it was posted.

```sh
pero notifications --status failed   # Notifications that could not be delivered
pero notifications show 4            # its message, and what stands in the way of its delivery
pero notifications retry 4           # deliver Notification 4 now, or again with fresh attempts
```
