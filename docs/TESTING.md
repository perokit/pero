# Testing Pero

## Test layers

| Command | What it runs | Where |
|---|---|---|
| `npm test` | Unit tests: services against a real temporary SQLite database, adapters against mocked SDKs and a mocked Bot API | CI |
| `npm run test:e2e` | Builds, then starts real daemons in-process on temporary workspaces, drives them through the control socket and the CLI, and talks to them through an in-process fake Telegram Bot API over HTTP. Turns use the echo runtime (`PERO_FAKE_RUNTIME=echo`), and fake `claude` and `codex` executables stand in for the sign-in checks. | CI |
| `npm run test:smoke` | Builds, then runs real Claude and Codex turns through the built runtime adapters. Each is skipped unless enabled, uses a little of the subscription, and never runs in CI. | By hand, on the host |
| `node scripts/check-doc-links.js` | Checks that every relative link in the committed Markdown files resolves, headings included | CI |
| `node bin/pero.js check --workspace examples/workspace` | Checks the [example workspace](../examples/workspace/) as committed, after the build | CI |
| `bash scripts/check-packed-install.sh` | Installs the `npm pack` artifact into a temporary global prefix and drives `pero` from a fresh home directory: `run` without a workspace, `init`, `run`, what Git commits, and a backup with the data folder restored into a `git clone` of the workspace | CI |

## Provider smoke tests under the service's account

Pero runs Claude and Codex with the sign-ins of the OS account its daemon runs as: Claude Code's under that account's `~/.claude`, and Codex's under its `~/.codex` (or `CODEX_HOME`). A smoke test proves those sign-ins work only when it runs as that same account, with that account's home directory and environment. On the owner's own account, run it as yourself. For a dedicated account, such as `pero`:

1. Put a checkout of the Pero version you run where that account can read it, and install its dependencies as that account:

   ```sh
   sudo -iu pero
   git clone https://github.com/perokit/pero.git ~/pero-src && cd ~/pero-src
   npm ci
   ```

   Use `sudo -iu` (or log in as the account), not `sudo -u` alone: without `-i`, `HOME` and the environment stay the caller's, and the test checks the wrong sign-ins. The login shell needs the same Node.js the service uses on its `PATH`.

2. Check the sign-ins the service will use:

   ```sh
   claude auth status
   npx codex login status
   ```

   Sign in there if either is missing: `claude auth login`, and `npx codex login` (`--device-auth` on a headless host).

3. Run the smoke tests, one provider at a time:

   ```sh
   PERO_SMOKE_CLAUDE=1 npm run test:smoke
   PERO_SMOKE_CODEX=1 npm run test:smoke
   ```

   `PERO_SMOKE_CODEX_MODEL` changes the model the resumed Codex turn switches to (`gpt-5.5` by default).

The Claude test creates a session that writes a file in a temporary folder, resumes it from another process with a different model and effort, checks that resuming a conversation Claude Code does not have is reported as lost (so Pero continues in a fresh Session), checks that an `ask` turn's shell command is refused, checks that an `ask` turn writes in its folder but is refused the system folder, and aborts a turn. The Codex test does the same with a thread, and also checks that a folder outside Git is refused unless the turn skips the check, that the `ask` sandbox confines writes to the folder, and that a signed-out Codex is reported as such.

When a test fails:
- **Signed out:** sign in again as the service account, not as yourself.
- **Running as root:** Claude Code refuses `bypass` there unless `IS_SANDBOX=1` is set; run the service, and the test, as an ordinary account.
- **Codex `ask` cannot write on Linux:** the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict through AppArmor. `npx codex sandbox -- true` shows whether it works; the smoke test skips that check where it cannot.

## Checking a real bot by hand

To see the Telegram path work end to end before any provider is set up, run Pero with the echo runtime, where every turn answers `echo: <message>`:

1. `pero init ~/pero-check && cd ~/pero-check`, then `PERO_FAKE_RUNTIME=echo pero run`, and follow the [recommended Telegram setup](./USER_GUIDE.md#set-up-telegram) until the group is allowed.
2. Create a topic. Pero writes its note, `data/System/Channels/<Topic title>.md`, with the topic's `channel-id`, and posts a welcome naming the note; a message there gets its echo.
3. Create a second topic and write in both; `pero channels` lists a Channel for each, each with its own note.
4. Write in the General topic and in a direct chat with the bot. Both are answered from `Channels/Default.md`, and `pero channels` shows them as separate Channels.
5. Type `/` in a topic: Telegram's menu lists Pero's commands. `/status` names the topic and its note (`Config:`); press New session, then Yes, start over, and the menu changes in place. The next message's echo has no `[Earlier conversation` part.
6. `pero stop`, then `PERO_FAKE_RUNTIME=echo pero run` again, and write in each Channel: every one answers, and `pero channels show <channel>` says its next turn resumes its Session.
7. Add `provider: codex` to the properties of one topic's note, wait 10 seconds, then write in that topic: the echo starts with `[Earlier conversation in this chat`, the Channel's recent messages.
8. Break that note, such as with `provider: codx`: within about 20 seconds, the topic gets one message naming the error, and Pero keeps answering there with the note's last good version. `pero check` lists the error.
9. Stop Pero and start it without `PERO_FAKE_RUNTIME` to use the real providers.

## Checking a release on a fresh machine

Before merging a PR that bumps the version, walk through the README's [Get started](../README.md#get-started) as a new owner would: on a fresh VPS, with a real bot and a real provider, and with the package that PR publishes. Copy the steps into the PR as a checklist.

1. **Install the package from the PR's branch**, under an ordinary account with a supported Node.js:

   ```sh
   git clone --branch <branch> https://github.com/perokit/pero.git ~/pero-src && cd ~/pero-src
   npm ci && npm pack
   npm install -g ./perokit-pero-<version>.tgz && cd
   pero -v          # the new version
   ```

2. **`mkdir ~/workspace && cd ~/workspace && pero run`.** It offers to make the folder a workspace, asks which provider to use when both CLIs are installed and waits until it is signed in, then asks for the bot token. It offers to install Pero as a service: accept, and it ends with `pero status` showing the service's Pero, with Telegram and the provider ready. `systemctl --user status pero` (or `launchctl print gui/$(id -u)/com.perokit.pero` on macOS) shows it running, and after a reboot `pero status` shows it running again.
3. **Allow a group.** Create a private group with Topics turned on, add the bot as an administrator, and write in it: `pero run` offers to allow that chat, and once allowed the bot posts the first steps in the General topic.
4. **Onboard a topic.** Create one: Pero writes `data/System/Channels/<Topic title>.md`, bound to it by `channel-id`, and posts a welcome naming the note. A message there gets the provider's answer, and a second one continues the conversation. Ask it to create a Workflow: it reads `.pero/guide.md` without asking, asks about the schedule and topic, and asks with Allow and Deny before writing the note, which `pero workflows` then lists.
5. **Send images and files.** Send a photo with a question about it, then an album of two photos, then a short PDF, a long PDF (over 20 pages), and a CSV, each with a question: each gets one answer that shows the provider saw or read the file, and `ls .pero/attachments/*/` lists them, the documents under the names they were sent with. With Claude, the long PDF is read with `Read` without asking, even in a Channel whose folder isn't the workspace. Then run `pero speech`: it offers setup; choose Local for both, when it lists ffmpeg, whisper.cpp, or Piper missing, choose *Install them now* and give sudo your password: it installs ffmpeg, builds whisper.cpp in `.pero/tools/` (or installs it with Homebrew), and installs Piper there; then let it download the models, after which it says both directions are ready. Run `pero speech configure` and switch recording to ElevenLabs with a key: it lists your voices, and `.env` and `config.yaml` change without editing either. Send a voice message: the answer follows what you said, and `pero channels history` shows the transcript. Ask for an answer by voice: a voice message arrives, and its words are in the history under `[Voice message]`.
6. **Edit a note.** Change that note's instructions, wait 10 seconds, and write in the topic: the answer follows the edit. Break the note, such as with `provider: codx`: the topic gets one message naming the error, and `pero check` lists it. Fix it again.
7. **Use the commands.** Type `/` in the topic: Telegram lists Pero's commands. `/status` names the topic's note (`Config:`) and, with Claude, how full its context is. Press Effort, then a level: the message changes in place and the note gets `effort`. Send a long request and `/stop`: the answer stops without a failure message. `/new`, then a message: the answer doesn't know what came before.
8. **Run a Workflow.** Copy [Evening review](../examples/workspace/data/System/Workflows/Evening%20review.md) into `data/System/Workflows/`, with `channel` set to the name of the topic's note, which is the topic's title. `pero workflows` shows its next run, and `pero workflows run evening-review` prints the answer and posts it in the topic. In the topic, `/run` offers the Workflow as a button, and pressing it queues a run that `/runs` lists.
9. **Back up.** Commit the workspace to Git (`git init && git add -A && git commit -m Workspace`): `git show --stat HEAD` lists `.pero/config.yaml` and the notes, but not `.env`, the database, `logs/`, or `run/`. Then `mkdir -p ~/backups && pero backup ~/backups/pero.tgz`.
10. **Restore into a clone** at the same path, as [Moving to a fresh machine](./OPERATIONS.md#moving-to-a-fresh-machine) does:

   ```sh
   pero stop
   mv ~/workspace ~/workspace-old && git clone ~/workspace-old ~/workspace && cd ~/workspace
   pero restore ~/backups/pero.tgz
   pero telegram token   # paste the bot token again
   pero run
   ```

   `pero channels show <channel>` says the topic's next turn resumes its Session, and a message there continues the conversation.

## Where each behavior is verified

The tests that matter most guard the boundaries that could lose or misroute work. `test/interactive.e2e-spec.ts` walks through the interactive path in one story with the fake Bot API and the echo runtime.

### The daemon and the CLI

| Behavior | Verified by |
|---|---|
| `pero run` in a new folder, or `pero init ~/workspace` then `pero run`, sets up a working Pero with its state in `.pero/` and its token in `.env` | `src/cli/setup/first-run.spec.ts`: the offer to make a workspace; `test/cli.e2e-spec.ts`: `init` and a run from home, and the token in `.env`; `test/daemon.e2e-spec.ts`: the state in `.pero/`; `scripts/check-packed-install.sh` |
| Pero is ready without Telegram or providers, and keeps running when they fail | `test/control.e2e-spec.ts` |
| One daemon runs per workspace, and a killed one never blocks the next start | `test/lifecycle.e2e-spec.ts`; `test/control.e2e-spec.ts` |
| `pero upgrade` installs the latest version only over npm's global install, and restarts Pero on it, through its service when the service runs it | `src/cli/upgrade.spec.ts`: version order, the npm calls, and refusing a checkout or an `npm link`; `src/cli/system-service.spec.ts`: the service's pid and starting it again; by hand, a packed older version installed under a temporary `NPM_CONFIG_PREFIX` and upgraded from npm while running |
| A CLI command never loads the database stack or the Telegram client | `test/cli.e2e-spec.ts`, with `test/fixtures/deny-daemon-deps.mjs` preloaded |
| One migration creates a schema that holds only state | `src/persistence/persistence.module.spec.ts`: a fresh database matches the entities, and the migration reverts cleanly; `src/persistence/entities/domain-entities.spec.ts`: no Channel note, Workflow, or settings table, and the constraints on each state table |

### Conversations

| Behavior | Verified by |
|---|---|
| The first interactive `pero run` refuses to start without an installed, signed-in provider CLI, and writes the provider picked to `Pero.md` | `src/cli/setup/first-run.spec.ts`; `src/system-files/note-writer.spec.ts`: the empty `provider` property `pero init` writes is filled in |
| `pero service install` writes a systemd user unit or launchd agent that runs `pero run --foreground`, and starts it | `src/cli/system-service.spec.ts`, against recorded `systemctl`, `loginctl`, and `launchctl` calls |
| Creating a topic in an allowed forum group writes a Channel note bound to it, and Pero answers there with it | `test/interactive.e2e-spec.ts`; onboarding edge cases in `src/channels/note-channels.spec.ts` and `src/channels/channel-onboarding.spec.ts` |
| Two topics keep separate contexts while working in the same shared folder | `test/interactive.e2e-spec.ts`: separate notes, Sessions, and provider sessions, both in the default folder |
| A Channel whose note names its own folder works there | `test/interactive.e2e-spec.ts`; `test/channel-notes.e2e-spec.ts` |
| The General topic and a direct chat are answered from `Default.md` in separate Sessions | `test/interactive.e2e-spec.ts` |
| A follow-up resumes the right provider session after a restart | `test/interactive.e2e-spec.ts`: each of four Channels resumes its own provider session in a new daemon; real resume from another process in both smoke tests |
| A new provider or folder starts a fresh Session that carries over recent messages; a new model or effort continues it, as does a `channel-id` moved to another note | `test/interactive.e2e-spec.ts`; `test/channel-notes.e2e-spec.ts`; `test/channels.e2e-spec.ts` for a `channel-id` moved to another note |
| `/status`, `/new`, `/stop`, and `/help` are answered by Pero itself, not by a turn, and stay out of the history; their buttons edit the menu in place; an unknown command is answered by a turn | `test/telegram.e2e-spec.ts`; `src/channels/commands/channel-commands.spec.ts`; `src/channels/commands/screens.spec.ts`; `src/telegram/telegram-adapter.spec.ts`; parsing in `src/telegram/telegram-updates.spec.ts` |
| A message carries a 👀 reaction from when its turn is accepted until the turn has ended and its answer or failure notice is out, also when it is stopped; a chat that refuses the reaction is answered all the same, and commands get none | `src/agents/agent-manager.spec.ts`; `src/telegram/telegram-adapter.spec.ts` |
| `/new` starts a fresh Session that carries nothing over from before it; `/stop` ends the running turn silently and drops the waiting ones | `test/telegram.e2e-spec.ts`; `src/agents/agent-manager.spec.ts`; `src/channels/commands/channel-commands.spec.ts` |
| `/model` and `/effort` show the Channel's value with a button per choice, and set or remove it in its note, keeping the note's comments | `src/channels/commands/channel-commands.spec.ts`; `src/system-files/note-writer.spec.ts` |
| `/workflows`, `/run`, `/runs`, `/cancel`, and `/retry` show and manage Workflows and runs, offering a menu when no Workflow or run, or an unknown one, is named | `src/channels/commands/workflow-commands.spec.ts`; `test/telegram.e2e-spec.ts` |
| `/status` shows how full a Claude conversation's context is | `src/runtimes/claude/claude-events.spec.ts`; `src/agents/agent-manager.spec.ts`; `src/channels/commands/screens.spec.ts` |
| A photo, a file of any type, or an album is saved under `.pero/attachments/`, named in the message's text, and shown to the turn: images and short PDFs inline for Claude, which reads the rest without asking; images as local images for Codex; one Telegram can't hand over is reported without a turn | `src/telegram/telegram-adapter.spec.ts`; `src/telegram/telegram-updates.spec.ts`; `src/telegram/media-groups.spec.ts`; `src/channels/channel-router.spec.ts`; `src/runtimes/claude/claude-runtime.spec.ts`; `src/runtimes/claude/pdf-pages.spec.ts`; `src/runtimes/claude/edit-policy.spec.ts`; `src/runtimes/codex/codex-runtime.spec.ts`; `src/history/history-retention.spec.ts`: deleted with older history |
| A voice message, audio file, or video message is saved and transcribed, and the turn gets its transcript, not the recording; one that can't be transcribed is reported, answering only a caption; `<voice>` blocks of a reply or a Workflow's answer are recorded and sent as voice messages in order, or as text saying why, and the history keeps their words; the turn's instructions say how only while Pero can record | `src/telegram/telegram-updates.spec.ts`; `src/telegram/telegram-adapter.spec.ts`; `src/channels/channel-router.spec.ts`; `src/agents/agent-manager.spec.ts`; `src/agents/agent-request.spec.ts`; `src/notifications/notification-delivery.spec.ts`; `src/speech/voice-reply.spec.ts` |
| The `local` speech engine runs ffmpeg, whisper.cpp, and Piper with the right arguments and reports a missing or failing program; the `elevenlabs` engine sends the right requests and never shows its key; `speech` in `config.yaml` and the `speech` component | `src/speech/local-engine.spec.ts`; `src/speech/elevenlabs-engine.spec.ts`; `src/speech/speech.service.spec.ts`; `src/speech/speech-setup.spec.ts`; `src/config/host-config.spec.ts` |
| `pero speech` offers setup when a direction can't work, and `pero speech configure` asks the engine for each direction, stores a checked ElevenLabs key in `.env`, picks a voice, installs the missing local programs or checks them again, downloads the models, and writes `config.yaml` keeping comments; the first `pero run` offers it; `pero speech voice` lists, picks, or sets an ElevenLabs voice by name or ID, takes an ID as given when the key can't list voices, and names the permission a restricted key lacks | `src/cli/setup/configure-speech.spec.ts`; `src/speech/install-programs.spec.ts`; `src/config/host-config.spec.ts` (`setSpeech`); `src/speech/elevenlabs-engine.spec.ts` |
| Each Channel's history holds the text sent and received there, and nothing else | `test/interactive.e2e-spec.ts`; `test/channels.e2e-spec.ts`; `src/agents/agent-manager.spec.ts` |
| A chat that is not allowed invokes no runtime, creates no Channel or note, and gets only the pairing hint | `test/interactive.e2e-spec.ts`; `test/telegram.e2e-spec.ts`; `src/channels/channel-router.spec.ts` |
| While `pero run` waits for a chat to pair, that chat is told to confirm in the terminal | `test/telegram.e2e-spec.ts`; `src/channels/channel-router.spec.ts`; `src/channels/pairing-requests.spec.ts` |
| Codex and Claude subscription sign-ins each have a documented SDK smoke test under the service's account | `test/smoke/claude-runtime.smoke-spec.ts` and `test/smoke/codex-runtime.smoke-spec.ts`, run as in [the section above](#provider-smoke-tests-under-the-services-account) |

### Notes and configuration

| Behavior | Verified by |
|---|---|
| `pero check` validates any workspace with or without Pero, including in CI | `test/check.e2e-spec.ts`: without Pero, including `--json`; `test/system-notes.e2e-spec.ts`: Workflow Channels against the topics the daemon has seen; `src/system-files/check.spec.ts` and `src/system-files/snapshot.spec.ts`; the CI step that checks the example workspace |
| The running daemon keeps an up-to-date snapshot of the notes, and `pero status` reports broken ones | `src/system-files/reload.spec.ts`: an edit within one scan, a note caught mid-write, last good versions, and 500 notes; `src/system/system-notes.service.spec.ts` and `test/system-notes.e2e-spec.ts`: the `system` component |
| Runtime code reads definitions synchronously, loaded before anything reads them | `src/system/definitions.spec.ts`; `src/system/system-notes.service.spec.ts`: the notes load before the startup of modules that read them |
| Pero's personality and instructions, Channel notes, defaults, and which topic each note answers are configured only by notes, and changes apply within 10 seconds | `test/channel-notes.e2e-spec.ts`: edits of the body, model, effort, provider, folder, `Pero.md`, `Persona.md`, and `Instructions.md`, and a `channel-id` moved to another note; `src/channels/note-channels.spec.ts`: `Default.md` for primary Channels, binding by `channel-id` and by title, and why Pero doesn't answer; `test/cli.e2e-spec.ts`: no command changes them |
| New topics create notes | `src/channels/note-channels.spec.ts`: one note when the topic's creation and first message race, the template, numbering, a note of the topic's title bound instead, and renames that keep the note; `test/example-workspace.e2e-spec.ts` |
| State refers to Channel notes and Workflows by name | `src/persistence/entities/domain-entities.spec.ts`: Sessions, messages, and runs name notes and Workflows that no row holds, and one schedule row per Workflow name |
| Claude with `ask` can't change configuration without asking | `src/runtimes/claude/edit-policy.spec.ts`: an edit under the system folder, through a symlink or `../`, asks; `src/runtimes/claude/claude-runtime.spec.ts`: refused in a Workflow run; the Claude smoke test |
| Broken notes are reported in Telegram once | `src/notifications/broken-note-reports.spec.ts`: once per broken version, nothing for a fix, one message per Channel, and only logs at startup; `test/workflows.e2e-spec.ts`: in the Workflow's Channel |
| Allowed chats can be changed by editing `config.yaml` | `src/host-config/host-config.service.spec.ts`: chats added or removed by hand are served or turned away from the next look, and a broken edit keeps the last valid version; `test/cli.e2e-spec.ts`: `telegram allow` and `deny` edit the file while Pero is stopped, and an invalid file stops startup |
| Committing the workspace commits `config.yaml` and nothing secret | `scripts/check-packed-install.sh`: `git add -A` in a running workspace stages `config.yaml` and the notes, not `.env`, the database, logs, or `run/`; `test/cli.e2e-spec.ts` and `src/config/env-file.spec.ts`: `pero status` reports a `.env` Git would commit |

### Workflows and Notifications

| Behavior | Verified by |
|---|---|
| Workflows, their schedules, prompts, and targets are configured only by notes | `test/workflows.e2e-spec.ts`: Workflows served from their notes, each edit applying, across a restart; `test/cli.e2e-spec.ts`: no command changes them |
| Schedule edits apply within 10 seconds without spurious catch-up runs | `src/scheduler/schedule-tick.spec.ts`: an edit moves the next run at once, a changed schedule catches nothing up, and a renamed note starts afresh; `test/workflows.e2e-spec.ts` |
| A missed scheduled run is found after restart | `test/workflows.e2e-spec.ts`: one catch-up run for the times a schedule missed while Pero was down; `src/scheduler/schedule-tick.spec.ts`: missed times, and catch-up only for notes that still exist and are enabled |
| Duplicate polls create one run per trigger occurrence | `src/scheduler/schedule-tick.spec.ts`: one run per time however often it polls, and when polls overlap |
| An interrupted run is visibly recorded and handled according to its policy | `test/workflows.e2e-spec.ts`: a run Pero stopped is recorded interrupted and retried as its Workflow allows, and cancellation; `src/workflows/workflow-runs.spec.ts` |
| A scheduled Workflow reads each message in its Channel history window exactly once across runs | `src/workflows/workflow-runs.spec.ts`: adjacent windows across consecutive runs, and a retry reading the window of the run it retries; `test/restore.e2e-spec.ts` across a restore |
| A Workflow's script decides whether its run needs a turn | `src/workflows/workflow-runs.spec.ts`: `NO_DATA` completes the run with no turn or Notification, other output reaches the input and the answer is notified, a failing script fails the run and notifies, and cancelling stops it; `src/workflows/run-script.spec.ts`: the working directory, environment, timeout, and output in the input |
| A Workflow can notify a configured topic | `test/workflows.e2e-spec.ts`: notifies the Channels a Workflow names; `src/notifications/run-notifications.spec.ts` |
| A daily Workflow can review the previous day's chats and deliver suggestions to a chosen topic, where the owner can reply to them | `test/restore.e2e-spec.ts`: a Workflow reading every Channel's history notifies a topic, and the next message there receives its suggestion; `test/workflows.e2e-spec.ts`: the next turn receives a delivered Notification |
| A temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs | `test/workflows.e2e-spec.ts`: delivers a Notification once Telegram is back, and keeps Notifications across a restart; `src/notifications/notification-delivery.spec.ts`: retries after backoff without another run |

### Backup and restore

| Behavior | Verified by |
|---|---|
| Restore brings back definitions and resumable Sessions | `test/restore.e2e-spec.ts`, which follows the drill in [Operating Pero](./OPERATIONS.md#moving-to-a-fresh-machine): the notes come back with the cloned workspace and the state with the backup, every Channel resumes its provider session, and a Channel whose provider conversation is gone continues in a fresh Session with its history |
| Backups restore into a cloned workspace | `test/restore.e2e-spec.ts`: a workspace restored into a fresh clone at its path, with its data folder; `test/cli.e2e-spec.ts`: a clone keeps its `config.yaml` and data files; `src/cli/restore.spec.ts`; `scripts/check-packed-install.sh`: a `git clone` |
