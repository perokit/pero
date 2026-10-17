# Pero

**Your own always-on AI assistant, running on your server and reachable from Telegram. It uses the Claude or ChatGPT subscription you already pay for.**

Pero keeps Claude Code or Codex running on your VPS or home machine and puts it in your pocket. Chat with it from your phone, give each topic its own instructions, and let it work on a schedule: reviewing your day, summarizing notes, or checking on a project, then messaging you with what it found.

- **No API bills.** Pero uses the Claude Code or Codex sign-in on your machine, so it runs on your existing Claude or ChatGPT subscription. It never switches you to pay-per-token API billing.
- **One assistant, a topic per subject.** Every topic in your group is a separate conversation with its own instructions and model: one for your notes, one for a side project, one that coaches your English. Pero keeps one personality and set of instructions across all of them, and a new topic gets a note of its own.
- **It works where your files are.** Pero works in a folder you choose, such as a notes vault or a Git repository. They read and edit files there the way Claude Code or Codex does, with your `CLAUDE.md`, `AGENTS.md`, skills, and MCP servers.
- **It works while you're away.** Workflows run on a schedule, can read what you talked about during the day, and post their results to the topic you choose. You can reply to them right there.
- **Talk to it.** Send a voice message and Pero answers what you said; ask for an answer by voice and it records one. Speech runs on your server with free local models by default, or with ElevenLabs if you'd rather.
- **You stay in control.** By default, Pero asks before running a command: it posts the request in the chat with Allow and Deny buttons. Only chats you allow can reach it.
- **Configured by notes.** The personality, the instructions, each topic, and each Workflow are Markdown notes: their text is the prompt, and their properties set the model and schedule. Edit them in Obsidian on your phone, commit them to Git, or clone them onto a new server. Changes apply within seconds.
- **Easy to run.** Pero is one npm package and one background process, with its state in a single SQLite file. You don't need Docker, a database server, or an open network port, and a single command backs everything up.

## What you need

- A Linux or macOS machine that stays on, such as a small VPS
- Node.js 22.17+ or 24.11+
- A Claude subscription signed in with Claude Code (`claude auth login`), a ChatGPT subscription signed in with Codex (`codex login`), or both
- A Telegram account
- Optional: an [Obsidian](https://obsidian.md) vault for Pero to work in (see [below](#tip-use-an-obsidian-vault))

## Get started

1. **Install and start Pero:**

   ```sh
   npm install -g @perokit/pero
   mkdir ~/workspace && cd ~/workspace
   pero run
   ```

   `~/workspace` is your workspace: the folder Pero runs in, with the data folder where it keeps notes in `data/` and Pero's own state in `.pero/`. In a folder that isn't a workspace yet, `pero run` offers to make it one, and asks which of the folders already there is your data folder, such as an existing notes vault; it suggests `data/`, creating it when missing, and can create a new folder you name. On the first start it has you pick the provider Pero uses, Claude or Codex, among the CLIs it finds, and doesn't start until that CLI is signed in; then whether its tools ask you before running (`ask`) or run without asking (`bypass`). Then it asks for what it still needs, such as your Telegram bot token, and offers to install Pero as a service that starts with the machine. You can stop at any step and run `pero run` again later to continue. Commands find `~/workspace` from your home folder and from any folder inside it.

   To make a workspace without starting Pero, such as from a script with no terminal, run `pero init <dir>`. It only writes what's missing, so it also fills in a cloned workspace.

2. **Create a Telegram bot** with [@BotFather](https://t.me/BotFather), then paste its token when `pero run` asks for it.

3. **Create a private Telegram group,** turn on **Topics** in its settings, and add your bot as an **administrator**. Keep the group private: anyone who can write there can talk to Pero, and Pero can run code on your machine.

4. **Allow the group.** Write anything in it. While `pero run` waits for that message, the bot replies that you can confirm the chat in the terminal, and `pero run` offers to allow it. Otherwise the bot replies with the command that allows it: `pero telegram allow <chat-id>`. A group's chat ID is negative, such as `-1001234567890`; keep the minus sign. Once the chat is allowed, the bot posts your first steps there: where to give Pero its personality and instructions, how topics work, and where the defaults and Workflows live.

5. **Create a topic and start chatting.** Send `/topic <name>` in the group, or ask Pero to create one for you; give the bot **Manage Topics** permission. Each new topic gets a note of its own, named after the topic: Pero writes it in `data/System/Channels/`, and its text is that topic's own instructions. The General topic uses `Channels/Default.md`.

You can also message the bot directly and allow your user ID the same way. That chat uses `Default.md` too, in a conversation of its own, apart from the group's General topic. You can use both: `pero run` only offers to allow the first chat, so allow the other with `pero telegram allow <chat-id>`.

To start from a complete setup instead, with a Health topic and two Workflows, copy the [example workspace](./examples/workspace/).

### Tip: use an Obsidian vault

Pero keeps its notes, plans, and results as files in the data folder. Make that folder an [Obsidian](https://obsidian.md) vault, and everything it writes becomes plain Markdown notes that you can browse, search, and edit on your desktop and phone.

1. Use the workspace's `data/` folder as the vault, or point Pero at another folder with `data: ~/notes` in `.pero/config.yaml` and restart it.
2. Sync it to your devices with a tool that works on a headless server, such as [Syncthing](https://syncthing.net) or Git with the [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin.
3. Open the synced folder as a vault in Obsidian on your desktop and phone.

Codex only works inside a Git repository. Pero works in the workspace, so make it one with `git init` if it isn't already.

## Everyday use

```sh
pero status                # is Pero running, and is everything connected?
pero logs -f               # follow the logs
pero channels              # topics and chats, and the note each is answered with
pero settings              # the defaults in effect
pero check                 # any mistakes in the notes?
pero stop
```

### Pero is configured by notes

Pero's personality is `data/System/Persona.md`, and its general instructions are `data/System/Instructions.md`: every topic starts with both. Each topic then adds its own note in `data/System/Channels/`, which Pero writes the first time you write there. `Channels/Health.md` answers in the Health topic with its own model:

```markdown
---
channel-id: telegram:-1001234567890:5
provider: codex
model: gpt-5.5
---
You are my health coach. My training log is in Health/Log.md.
```

`channel-id` is how Pero keeps the note with its topic, even when you rename the topic. The General topic and direct chats use `Channels/Default.md`.

Or ask Pero: *"create a Workflow that…"* or *"be less formal"*. Pero knows where its notes are and how its settings work, asks what it needs, and writes the note once you allow it. The welcome Pero posts in a new topic names that topic's note.

Defaults for every topic, such as the provider, model, and time zone, are properties of `data/System/Pero.md`. Pero reads the notes every 10 seconds, so the next message uses your edit. A note with a mistake doesn't stop Pero: it keeps the note's last good version, and tells you in the chat what's wrong. [Configuring Pero](./docs/CONFIGURATION.md) lists every property.

### Scheduled workflows

A Workflow is a task Pero does on its own, on a schedule or on demand: a note in `Workflows/`. For example, `data/System/Workflows/English review.md` reviews the day's chats every evening and posts suggestions to the English topic, with that topic's note's instructions and model:

```markdown
---
hour: 21
history: true
channel: English
---
Suggest better English for: {{history}}
```

`pero workflows` lists the Workflows and when each runs next, and `pero workflows run english-review` runs one now. A Workflow with `script: tsx scripts/check.ts` runs that check first and only calls the agent when it prints something other than `NO_DATA` ([script triggers](./docs/USER_GUIDE.md#script-triggers)).

`pero runs` shows what ran and how it went.

### Keep it running and back it up

`pero run` keeps Pero running after you close the terminal. To start it with the machine and restart it after a crash, run `pero service install` (a systemd user service on Linux, a launchd agent on macOS); the first `pero run` offers to. [Operating Pero](./docs/OPERATIONS.md) covers other service managers.

```sh
pero backup ~/backups/pero.tgz     # while Pero runs; --include-data adds the data folder
pero restore ~/backups/pero.tgz    # into a workspace without a database, such as a fresh clone, while Pero is stopped
pero upgrade                       # install the latest version and restart Pero on it
```

## Learn more

- [User guide](./docs/USER_GUIDE.md): Telegram, topics and permissions, and Workflows in detail
- [Configuring Pero](./docs/CONFIGURATION.md): the workspace, and every file and property
- [Operating Pero](./docs/OPERATIONS.md): running as a service, upgrades, credentials, data, backup, and moving to a new machine
- [CLI reference](./docs/CLI.md): every command and option
- [Development](./docs/DEVELOPMENT.md): building, testing, and contributing to Pero

## License

[MIT](./LICENSE)
