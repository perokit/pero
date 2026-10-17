import { describe, expect, it } from 'vitest';
import type { ChannelRef } from './schemas.js';
import {
  buildSnapshot,
  noteFor,
  type ResolvedChannel,
  type SnapshotContext,
  type TopicLookup,
  type TopicResolution,
} from './snapshot.js';

const CONTEXT: SnapshotContext = {
  workspace: '/home/me/workspace',
  homeDir: '/home/me',
  hostTimeZone: 'UTC',
};

const HEALTH_ID = 'telegram:-100123:5';

/** A snapshot of the notes in `files`, keyed by path. */
function snapshot(
  files: Record<string, string>,
  context: Partial<SnapshotContext> = {},
) {
  return buildSnapshot(
    Object.entries(files).map(([file, text]) => ({ file, text })),
    { ...CONTEXT, ...context },
  );
}

/** Each error as `file property: message`, for compact assertions. */
function errorsOf(files: Record<string, string>, context = {}) {
  return snapshot(files, context).errors.map(
    (error) => `${error.file} ${error.property ?? '-'}: ${error.message}`,
  );
}

const WEEKLY = `---
day: sunday
hour: 12
channel: Health
---
Create a weekly report.`;

describe('buildSnapshot', () => {
  it('has only defaults and no errors for an empty folder', () => {
    const result = snapshot({});
    expect(result.defaults).toEqual({
      provider: 'claude',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'ask',
      timezone: 'UTC',
      historyCarryover: 50,
      historyRetentionDays: null,
      maxConcurrentRuns: 2,
    });
    expect(result.persona).toBeNull();
    expect(result.instructions).toBeNull();
    expect(result.peroProperties.size).toBe(0);
    expect(result.channelNotes.size).toBe(0);
    expect(result.workflows.size).toBe(0);
    expect(result.errors).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('builds the example workspace', () => {
    const result = snapshot({
      'Pero.md': `---
provider: claude
claude-model: opus
permissions: ask
timezone: Europe/Berlin
---`,
      'Persona.md': 'You are calm and concise.',
      'Instructions.md': 'You help with everyday questions.',
      'Channels/Default.md': 'Keep it short here.',
      'Channels/Health.md': `---
channel-id: ${HEALTH_ID}
effort: high
---
You are my health coach.`,
      'Workflows/Weekly health report.md': WEEKLY,
    });
    expect(result.errors).toEqual([]);
    expect(result.persona).toBe('You are calm and concise.');
    expect(result.instructions).toBe('You help with everyday questions.');
    expect(result.channelNotes.get('default')).toMatchObject({
      name: 'default',
      title: 'Default',
      file: 'Channels/Default.md',
      channelId: null,
      provider: 'claude',
      model: 'opus',
      effort: null,
      permissions: 'ask',
      workingDirectory: '/home/me/workspace',
      instructions: 'Keep it short here.',
    });
    expect(result.channelNotes.get('health')).toMatchObject({
      channelId: HEALTH_ID,
      model: 'opus',
      effort: 'high',
      note: expect.objectContaining({ model: null, effort: 'high' }),
    });
    expect(result.boundChannels).toEqual(new Map([[HEALTH_ID, 'health']]));
    expect(result.workflows.get('weekly-health-report')).toEqual({
      name: 'weekly-health-report',
      title: 'Weekly health report',
      file: 'Workflows/Weekly health report.md',
      note: 'health',
      schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
      channels: ['Health'],
      history: null,
      resolved: null,
      maxAttempts: 1,
      enabled: true,
      script: null,
      input: 'Create a weekly report.',
    });
  });

  it('applies Pero.md defaults for the note’s own provider', () => {
    const result = snapshot({
      'Pero.md': `---
provider: codex
codex-model: gpt-5.5
codex-effort: minimal
claude-model: sonnet
permissions: bypass
---`,
      'Channels/Coder.md': '',
      'Channels/Writer.md': '---\nprovider: claude\npermissions: ask\n---',
    });
    expect(result.channelNotes.get('coder')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'minimal',
      permissions: 'bypass',
    });
    expect(result.channelNotes.get('writer')).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      effort: null,
      permissions: 'ask',
    });
  });

  it('resolves working directories against the workspace', () => {
    const folder = (path: string) =>
      snapshot({
        'Channels/Site.md': `---\nworking-directory: ${path}\n---`,
      }).channelNotes.get('site')!.workingDirectory;
    expect(folder('projects/site')).toBe('/home/me/workspace/projects/site');
    expect(folder('~/code')).toBe('/home/me/code');
    expect(folder('/srv/site')).toBe('/srv/site');
  });

  it('reads notes in subfolders and skips ignored ones', () => {
    const result = snapshot({
      'Channels/Coaches/Running.md': 'Run.',
      'Channels/_Template.md': '---\nmodle: broken\n---',
      'Channels/.draft.md': 'not read',
      '.obsidian/app.md': 'not read',
      'Channels/notes.txt': 'not read',
      'Workflows/_Ideas.md': '---\nhour: 99\n---',
    });
    expect(result.errors).toEqual([]);
    expect([...result.channelNotes.keys()]).toEqual(['running']);
    expect(result.channelNotes.get('running')!.file).toBe(
      'Channels/Coaches/Running.md',
    );
  });

  it('ignores notes outside the notes it reads', () => {
    expect(
      errorsOf({
        'Templates/Daily Journal.md': '---\nmodle: broken\n---',
        'Agents/Health.md': '---\ntopic: Health\n---',
        'Channel/Health.md': 'Hi',
        'Notes.md': 'Stray',
      }),
    ).toEqual([]);
  });

  it('reads Persona.md and Instructions.md as text only', () => {
    const files = {
      'Persona.md': '---\ntags: [pero]\n---\nBe kind.',
      'Instructions.md': '---\nmodel: opus\n---\nHelp.',
    };
    expect(snapshot(files).persona).toBe('Be kind.');
    expect(snapshot(files).instructions).toBeNull();
    expect(errorsOf(files)).toEqual([
      'Instructions.md model: unknown property',
    ]);
  });

  it('reports the properties Channel notes no longer take', () => {
    expect(
      errorsOf({
        'Channels/Health.md':
          '---\ntopic: Health\nskip-main-instructions: true\n---',
        'Pero.md': '---\nmain-agent: Main\n---',
        'Workflows/Report.md': '---\nagent: Main\n---\nGo',
      }),
    ).toEqual([
      'Channels/Health.md topic: unknown property',
      'Channels/Health.md skip-main-instructions: unknown property',
      'Pero.md main-agent: unknown property',
      'Workflows/Report.md agent: unknown property',
    ]);
  });

  it('keeps a channel-id off Default.md', () => {
    expect(
      errorsOf({ 'Channels/Default.md': `---\nchannel-id: ${HEALTH_ID}\n---` }),
    ).toEqual([
      'Channels/Default.md channel-id: must not be set: Default.md answers every General topic and direct chat',
    ]);
  });

  it('checks a channel-id’s form', () => {
    expect(
      errorsOf({
        'Channels/A.md': '---\nchannel-id: -100123\n---',
        'Channels/B.md': '---\nchannel-id: slack:C123\n---',
        'Channels/C.md': '---\nchannel-id: "telegram:"\n---',
      }),
    ).toEqual([
      'Channels/A.md channel-id: must be <integration>:<address>, such as telegram:-1001234567890:5',
      'Channels/B.md channel-id: must be <integration>:<address>, such as telegram:-1001234567890:5',
      'Channels/C.md channel-id: must be <integration>:<address>, such as telegram:-1001234567890:5',
    ]);
  });

  it('leaves out both notes of a duplicate name, and what depends on them', () => {
    const files = {
      'Channels/Health.md': 'One',
      'Channels/Old/health.md': 'Two',
      'Workflows/Report.md': '---\nchannel: Health\n---\nGo',
    };
    const result = snapshot(files);
    expect(result.channelNotes.size).toBe(0);
    expect(result.workflows.size).toBe(0);
    expect(result.unloadedNames).toEqual(
      new Map([['health', ['Channels/Health.md', 'Channels/Old/health.md']]]),
    );
    expect(errorsOf(files)).toEqual([
      'Channels/Health.md -: has the same name, health, as Channels/Old/health.md; rename one of them',
      'Channels/Old/health.md -: has the same name, health, as Channels/Health.md; rename one of them',
      'Workflows/Report.md channel: the notes Channels/Health.md and Channels/Old/health.md have errors',
    ]);
  });

  it('leaves out both notes bound to one Channel', () => {
    const files = {
      'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
      'Channels/Fitness.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
      'Channels/Sleep.md': 'Sleep.',
    };
    const result = snapshot(files);
    expect([...result.channelNotes.keys()]).toEqual(['sleep']);
    expect(result.unloadedChannels).toEqual(
      new Map([[HEALTH_ID, ['Channels/Health.md', 'Channels/Fitness.md']]]),
    );
    expect(errorsOf(files)).toEqual([
      `Channels/Fitness.md channel-id: ${HEALTH_ID} is also the channel-id of Channels/Health.md; keep it in only one of them`,
      `Channels/Health.md channel-id: ${HEALTH_ID} is also the channel-id of Channels/Fitness.md; keep it in only one of them`,
    ]);
  });

  it('lets a Channel note and a Workflow share a name', () => {
    const result = snapshot({
      'Channels/Review.md': 'Channel',
      'Workflows/Review.md': 'Workflow',
    });
    expect(result.errors).toEqual([]);
    expect(result.channelNotes.has('review')).toBe(true);
    expect(result.workflows.has('review')).toBe(true);
  });

  it('keeps a note loaded from its last good version out of unloaded ones', () => {
    const result = buildSnapshot(
      [
        {
          file: 'Channels/Health.md',
          text: `---\nchannel-id: ${HEALTH_ID}\nmodle: x\n---`,
          fallback: `---\nchannel-id: ${HEALTH_ID}\n---`,
        },
      ],
      CONTEXT,
    );
    expect(result.unloadedChannels.size).toBe(0);
    expect(result.boundChannels.get(HEALTH_ID)).toBe('health');
  });

  it('keeps the Channel notes when Pero.md is broken, with all defaults', () => {
    const files = {
      'Pero.md': '---\nprovider: gemini\ntimezone: Asia/Tokyo\n---',
      'Channels/Default.md': 'Hi',
    };
    const result = snapshot(files);
    expect(result.defaults).toMatchObject({
      provider: 'claude',
      timezone: 'UTC',
    });
    expect(result.channelNotes.has('default')).toBe(true);
    expect(errorsOf(files)).toEqual([
      'Pero.md provider: must be claude or codex',
    ]);
  });

  it('checks a note’s effort against its provider', () => {
    const files = {
      'Pero.md': '---\nprovider: codex\n---',
      'Channels/Deep.md': '---\neffort: ultra\n---',
      'Channels/Quick.md': '---\nprovider: claude\neffort: minimal\n---',
    };
    const result = snapshot(files);
    expect(result.channelNotes.get('deep')!.effort).toBe('ultra');
    expect(result.channelNotes.has('quick')).toBe(false);
    expect(errorsOf(files)).toEqual([
      'Channels/Quick.md effort: must be low, medium, high, xhigh, or max for claude',
    ]);
  });

  it('sorts errors by file', () => {
    expect(
      snapshot({
        'Workflows/B.md': '---\nhour: 30\n---\nGo',
        'Channels/A.md': '---\nmodle: x\n---',
        'Pero.md': '---\nprovidr: x\n---',
      }).errors.map((error) => error.file),
    ).toEqual(['Channels/A.md', 'Pero.md', 'Workflows/B.md']);
  });

  it('lists the properties Pero.md sets, leaving out empty ones', () => {
    const result = snapshot({
      'Pero.md': '---\nclaude-model: opus\ntimezone:\nprovider: codex\n---',
    });
    expect([...result.peroProperties].sort()).toEqual([
      'claude-model',
      'provider',
    ]);
  });

  it('lists no Pero.md properties while it is broken', () => {
    const result = snapshot({ 'Pero.md': '---\nprovider: gemini\n---' });
    expect(result.peroProperties.size).toBe(0);
  });
});

describe('noteFor', () => {
  const result = snapshot({
    'Channels/Default.md': 'Here.',
    'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
    'Channels/Sleep.md': 'Sleep.',
    'Channels/Здоровье.md': 'Привет.',
    'Channels/Garden.md': '---\nchannel-id: telegram:-100123:9\nmodle: x\n---',
    'Channels/Coach.md': '---\nmodle: x\n---',
  });
  const topic = (channelId: string, title: string | null) =>
    noteFor(result, { channelId, primary: false, title });

  it('gives every primary Channel Default.md', () => {
    expect(
      noteFor(result, {
        channelId: 'telegram:-100123',
        primary: true,
        title: 'Health',
      }),
    ).toMatchObject({ kind: 'note', note: { name: 'default' } });
    expect(
      noteFor(snapshot({}), {
        channelId: 'telegram:42',
        primary: true,
        title: null,
      }),
    ).toEqual({ kind: 'none', name: 'default' });
  });

  it('matches a bound note by its channel-id, whatever the title', () => {
    expect(topic(HEALTH_ID, 'Fitness')).toMatchObject({
      kind: 'note',
      note: { name: 'health' },
    });
  });

  it('offers an unbound note named as the title to bind', () => {
    expect(topic('telegram:-100123:6', ' SLEEP ')).toMatchObject({
      kind: 'bindable',
      note: { name: 'sleep' },
    });
    expect(topic('telegram:-100123:7', 'Zdorove')).toMatchObject({
      kind: 'bindable',
      note: { file: 'Channels/Здоровье.md' },
    });
  });

  it('gives a title whose note is bound elsewhere no note', () => {
    expect(topic('telegram:-100456:5', 'Health')).toEqual({
      kind: 'none',
      name: 'health',
    });
  });

  it('names the notes left out for a Channel', () => {
    expect(topic('telegram:-100123:9', 'Garden')).toEqual({
      kind: 'unloaded',
      files: ['Channels/Garden.md'],
    });
    expect(topic('telegram:-100123:10', 'Coach')).toEqual({
      kind: 'unloaded',
      files: ['Channels/Coach.md'],
    });
  });

  it('waits for a topic’s title', () => {
    expect(topic('telegram:-100123:11', null)).toEqual({ kind: 'untitled' });
  });

  it('never binds Default.md to a topic', () => {
    expect(topic('telegram:-100123:12', 'Default')).toEqual({
      kind: 'none',
      name: 'default',
    });
  });
});

describe('Workflows', () => {
  it('take their note from their first channel, or Default.md', () => {
    const noteOf = (channel: string | null) =>
      snapshot({
        'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
        'Channels/Sleep.md': '---\nchannel-id: telegram:-100123:6\n---',
        'Workflows/Report.md':
          channel === null ? 'Go' : `---\nchannel: ${channel}\n---\nGo`,
      }).workflows.get('report')!.note;
    expect(noteOf('Health')).toBe('health');
    expect(noteOf('[sleep, Health]')).toBe('sleep');
    expect(noteOf('General')).toBe('default');
    expect(noteOf('Home/General')).toBe('default');
    expect(noteOf(null)).toBe('default');
    expect(noteOf('5')).toBeNull();
  });

  it('run with a disabled note', () => {
    const result = snapshot({
      'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\nenabled: false\n---`,
      'Workflows/Report.md': '---\nchannel: Health\n---\nGo',
    });
    expect(result.workflows.get('report')!.note).toBe('health');
  });

  it('report a note that is missing, or Default.md', () => {
    const files = {
      'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
      'Channels/Sleep.md': 'Sleep.',
      'Workflows/Report.md': `---
channel: [Helth, Sleep, Default]
history: true
history-channels: Nope
---
Go`,
    };
    expect(snapshot(files).workflows.size).toBe(0);
    expect(errorsOf(files)).toEqual([
      'Workflows/Report.md channel: no Channel note named "Helth"; Channel notes: Health, Sleep',
      'Workflows/Report.md channel: "Default" answers every General topic and direct chat; write General, <chat title>/General, or a Channel ID',
      'Workflows/Report.md history-channels: no Channel note named "Nope"; Channel notes: Health, Sleep',
    ]);
  });

  it('take their schedule time zone from Pero.md or the host', () => {
    const zone = (files: Record<string, string>) =>
      snapshot({
        'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
        'Workflows/Report.md': WEEKLY,
        ...files,
      }).workflows.get('report')!.schedule!.timezone;
    expect(zone({})).toBe('UTC');
    expect(zone({ 'Pero.md': '---\ntimezone: Asia/Tokyo\n---' })).toBe(
      'Asia/Tokyo',
    );
    expect(
      zone({
        'Workflows/Report.md': `---\nhour: 9\ntimezone: America/New_York\n---\nGo`,
      }),
    ).toBe('America/New_York');
  });

  describe('with a lookup', () => {
    const channel = (
      id: number,
      channelId: string,
      primary: boolean,
      title: string,
    ): ResolvedChannel => ({ id, channelId, primary, title });
    const byKey = new Map<string, ResolvedChannel>([
      [HEALTH_ID, channel(3, HEALTH_ID, false, 'Fitness')],
      ['telegram:-100123:8', channel(8, 'telegram:-100123:8', false, 'Sleep')],
    ]);
    const refs: Record<string, TopicResolution> = {
      general: {
        kind: 'ok',
        channel: channel(1, 'telegram:-100123', true, 'General'),
      },
      '7': { kind: 'ok', channel: channel(7, 'telegram:42', true, 'General') },
      '8': { kind: 'ok', channel: byKey.get('telegram:-100123:8')! },
      '9': {
        kind: 'ok',
        channel: channel(9, 'telegram:-100123:9', false, 'New'),
      },
      'work/general': { kind: 'none' },
    };
    const topics: TopicLookup = {
      resolve: (ref: ChannelRef) =>
        refs[String(ref).toLowerCase()] ?? { kind: 'none' },
      byChannelId: (channelId) => byKey.get(channelId) ?? null,
      topicsNamed: (name) =>
        [...byKey.values()].filter(
          (found) => found.title.toLowerCase() === name,
        ),
      primaryChannels: () =>
        [refs.general!, refs['7']!].map(
          (found) => (found as { channel: ResolvedChannel }).channel,
        ),
    };
    const files = {
      'Channels/Health.md': `---\nchannel-id: ${HEALTH_ID}\n---`,
      'Channels/Sleep.md': 'Sleep.',
      'Channels/Away.md': '---\nchannel-id: telegram:-100999:1\n---',
    };

    it('posts to the Channels the notes are bound to', () => {
      const result = snapshot(
        {
          ...files,
          'Workflows/Report.md':
            '---\nchannel: [Health, 7, General, health]\nhistory: true\nhistory-channels: [7, Health]\n---\nGo',
          'Workflows/All.md':
            '---\nhistory: true\nhistory-channels: all\n---\nGo',
        },
        { topics },
      );
      expect(result.workflows.get('report')).toMatchObject({
        note: 'health',
        resolved: { targets: [3, 7, 1], history: [3, 7] },
      });
      expect(result.workflows.get('all')!.resolved).toEqual({
        targets: [],
        history: 'all',
      });
    });

    it("reads its own Channels' history, or Default.md's", () => {
      const historyOf = (properties: string) =>
        snapshot(
          { ...files, 'Workflows/Report.md': `---\n${properties}\n---\nGo` },
          { topics },
        ).workflows.get('report')!.resolved!.history;
      expect(historyOf('channel: [Sleep, Health]\nhistory: true')).toEqual([
        3, 8,
      ]);
      // Without a channel, its runs use Default.md, whose Channels these are.
      expect(historyOf('history: true')).toEqual([1, 7]);
      expect(
        historyOf(
          'channel: Health\nhistory: true\nhistory-channels: [default, Current]',
        ),
      ).toEqual([1, 3, 7]);
      expect(
        historyOf(
          'channel: Health\nhistory: true\nhistory-channels: [8, DEFAULT]',
        ),
      ).toEqual([1, 7, 8]);
    });

    it('takes the note of a Channel named by ID', () => {
      const noteOf = (ref: number) =>
        snapshot(
          { ...files, 'Workflows/Report.md': `---\nchannel: ${ref}\n---\nGo` },
          { topics },
        ).workflows.get('report')!.note;
      expect(noteOf(7)).toBe('default');
      expect(noteOf(8)).toBe('sleep');
      expect(noteOf(9)).toBe('new');
    });

    it('posts a note without a channel-id to the topic of its title', () => {
      const result = snapshot(
        { ...files, 'Workflows/Report.md': '---\nchannel: Sleep\n---\nGo' },
        { topics },
      );
      expect(result.workflows.get('report')).toMatchObject({
        note: 'sleep',
        resolved: { targets: [8] },
      });
      const unseen = {
        ...files,
        'Channels/Garden.md': 'Garden.',
        'Workflows/Report.md': '---\nchannel: Garden\n---\nGo',
      };
      expect(errorsOf(unseen, { topics })).toEqual([
        'Workflows/Report.md channel: Pero hasn\'t seen a topic titled "Garden" for Channels/Garden.md; write something there first',
      ]);
    });

    it('reports Channels it hasn’t seen', () => {
      const report = {
        ...files,
        'Workflows/Report.md': `---
channel: [Away, 99, Work/General]
---
Go`,
      };
      expect(snapshot(report, { topics }).workflows.size).toBe(0);
      expect(errorsOf(report, { topics })).toEqual([
        "Workflows/Report.md channel: Pero hasn't seen the Channel telegram:-100999:1 of Channels/Away.md; write something there first",
        'Workflows/Report.md channel: no Channel has the ID 99',
        'Workflows/Report.md channel: no General topic in "Work" Pero has seen yet; write something there first',
      ]);
    });
  });
});
