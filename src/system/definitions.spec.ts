import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  type SystemSnapshot,
} from '../system-files/snapshot.js';
import { channelTopicLookup } from './channel-topics.js';
import { Definitions } from './definitions.js';
import type { SystemNotes } from './system-notes.service.js';

const FOLDERS = {
  workspace: '/home/me/workspace',
  dataFolder: '/home/me/workspace/data',
  systemFolder: '/home/me/workspace/data/System',
};

/** The Channels Pero has seen in the allowed chats. */
const TOPICS = channelTopicLookup([
  { id: 1, kind: 'telegram', key: '-100777', title: 'Home' },
  { id: 2, kind: 'telegram', key: '-100777:5', title: 'Health' },
  { id: 3, kind: 'telegram', key: '-100777:6', title: 'English' },
  { id: 4, kind: 'telegram', key: '1234', title: null },
]);

const HEALTH = '---\nchannel-id: telegram:-100777:5\n---\nCoach me.';
const ENGLISH = '---\nchannel-id: telegram:-100777:6\n---';

function snapshotOf(files: Record<string, string>): SystemSnapshot {
  return buildSnapshot(
    Object.entries(files).map(([file, text]) => ({ file, text })),
    {
      workspace: FOLDERS.workspace,
      homeDir: '/home/me',
      hostTimeZone: 'UTC',
      topics: TOPICS,
    },
  );
}

/** `Definitions` over the notes `files`; `change` swaps them. */
function definitionsOf(files: Record<string, string> | null) {
  let snapshot = files === null ? null : snapshotOf(files);
  const notesListeners = new Set<() => void>();
  const notes = {
    snapshot: () => snapshot,
    folders: () => FOLDERS,
    onChange: (listener: () => void) => {
      notesListeners.add(listener);
      return () => notesListeners.delete(listener);
    },
  } as unknown as SystemNotes;
  return {
    definitions: new Definitions(notes),
    change: (next: Record<string, string>) => {
      snapshot = snapshotOf(next);
      for (const listener of notesListeners) listener();
    },
  };
}

describe('Definitions', () => {
  it('reads the defaults from Pero.md and the data folder from config.yaml', () => {
    const { definitions } = definitionsOf({
      'Pero.md':
        '---\nprovider: codex\ncodex-model: gpt-5.5\nhistory-carryover: 10\nmax-concurrent-runs: 3\ntimezone: Europe/Berlin\n---',
      'Persona.md': 'Be calm.',
      'Instructions.md': 'Be brief.',
    });
    expect(definitions.defaults()).toEqual({
      provider: 'codex',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: 'gpt-5.5', effort: null },
      },
      permissions: 'ask',
      timezone: 'Europe/Berlin',
      historyCarryover: 10,
      historyRetentionDays: null,
      maxConcurrentRuns: 3,
      dataFolder: FOLDERS.dataFolder,
      systemFolder: FOLDERS.systemFolder,
      guideFile: '/home/me/workspace/.pero/guide.md',
      persona: 'Be calm.',
      instructions: 'Be brief.',
    });
  });

  it("uses Pero's own defaults while Pero.md is broken", () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nprovider: gemini\n---',
    });
    expect(definitions.defaults()).toMatchObject({
      provider: 'claude',
      persona: null,
      instructions: null,
    });
  });

  it('gives each Channel note with the defaults applied, or the defaults alone', () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nclaude-model: opus\nclaude-effort: high\n---',
      'Channels/Health.md':
        '---\neffort: low\nworking-directory: projects/health\npermissions: bypass\n---\nCoach me.',
      'Channels/Home/Default.md': 'Help.',
    });
    expect(definitions.channelNote('HEALTH')).toMatchObject({
      name: 'health',
      title: 'Health',
      file: 'Channels/Health.md',
      provider: 'claude',
      model: 'opus',
      effort: 'low',
      permissions: 'bypass',
      workingDirectory: '/home/me/workspace/projects/health',
      instructions: 'Coach me.',
      skipGitRepoCheck: false,
      enabled: true,
    });
    expect(definitions.channelNote('default')).toMatchObject({
      file: 'Channels/Home/Default.md',
      workingDirectory: FOLDERS.workspace,
      note: { workingDirectory: null },
    });
    expect(definitions.channelNote('Garden')).toMatchObject({
      name: 'garden',
      title: 'Garden',
      file: null,
      model: 'opus',
      effort: 'high',
      instructions: null,
    });
    expect(definitions.channelNotes().map((note) => note.name)).toEqual([
      'default',
      'health',
    ]);
  });

  it('has no Channel notes before the notes could be read', () => {
    const { definitions } = definitionsOf(null);
    expect(definitions.channelNotes()).toEqual([]);
    expect(definitions.defaults().dataFolder).toBe(FOLDERS.dataFolder);
  });

  describe('route', () => {
    const query = (key: string, title: string | null) => ({
      channelId: `telegram:${key}`,
      primary: !key.includes(':'),
      title,
    });

    it('answers primary Channels with Default.md, written or not', () => {
      expect(
        definitionsOf({ 'Channels/Default.md': 'Hi.' }).definitions.route(
          query('-100777', 'Home'),
        ),
      ).toMatchObject({
        kind: 'answered',
        match: 'note',
        note: { name: 'default', instructions: 'Hi.' },
      });
      expect(
        definitionsOf({}).definitions.route(query('1234', null)),
      ).toMatchObject({
        kind: 'answered',
        match: 'none',
        note: { name: 'default', title: 'Default', file: null },
      });
    });

    it('answers a topic with its bound note, or one named as its title', () => {
      const { definitions } = definitionsOf({
        'Channels/Health.md': HEALTH,
        'Channels/Sleep.md': 'Sleep.',
      });
      expect(definitions.route(query('-100777:5', 'Fitness'))).toMatchObject({
        kind: 'answered',
        match: 'note',
        note: { name: 'health' },
      });
      expect(definitions.route(query('-100777:7', 'Sleep'))).toMatchObject({
        kind: 'answered',
        match: 'bindable',
        note: { name: 'sleep' },
      });
      expect(definitions.route(query('-100777:8', 'Garden'))).toMatchObject({
        kind: 'answered',
        match: 'none',
        note: { name: 'garden', title: 'Garden', file: null },
      });
    });

    it('says why Pero does not answer', () => {
      const { definitions } = definitionsOf({
        'Channels/Health.md':
          '---\nchannel-id: telegram:-100777:5\nenabled: false\n---',
        'Channels/Sleep.md': '---\nmodle: x\n---',
      });
      expect(definitions.route(query('-100777:5', 'Health'))).toEqual({
        kind: 'unanswered',
        reason: { kind: 'disabled', file: 'data/System/Channels/Health.md' },
      });
      expect(definitions.route(query('-100777:7', 'Sleep'))).toEqual({
        kind: 'unanswered',
        reason: { kind: 'unloaded', files: ['data/System/Channels/Sleep.md'] },
      });
      expect(definitions.route(query('-100777:9', null))).toEqual({
        kind: 'unanswered',
        reason: { kind: 'untitled' },
      });
    });
  });

  it('gives each Workflow its note with the Channels it names by ID', () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\ntimezone: Europe/Berlin\n---',
      'Channels/Health.md': HEALTH,
      'Channels/English.md': ENGLISH,
      'Workflows/Weekly report.md':
        '---\nday: sunday\nhour: 12\nchannel: [Health, Home/General, 4]\nhistory: true\nhistory-channels: [English, Health]\nhistory-hours: 24\nmax-attempts: 2\n---\nWrite the weekly report.',
      'Workflows/Brief.md': '---\nhour: 9\nenabled: false\n---\nBrief me.',
    });
    expect(definitions.workflow('WEEKLY-REPORT')).toEqual({
      name: 'weekly-report',
      title: 'Weekly report',
      file: 'Workflows/Weekly report.md',
      note: 'health',
      input: 'Write the weekly report.',
      channels: ['Health', 'Home/General', 4],
      history: {
        channels: {
          current: false,
          default: false,
          named: ['English', 'Health'],
        },
        hours: 24,
      },
      resolved: { targets: [2, 1, 4], history: [2, 3] },
      maxAttempts: 2,
      schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
      enabled: true,
      script: null,
    });
    expect(definitions.workflow('brief')).toMatchObject({
      note: 'default',
      history: null,
      resolved: { targets: [], history: 'all' },
      schedule: { cron: '0 9 * * *', timezone: 'Europe/Berlin' },
      enabled: false,
    });
    expect(definitions.workflows().map((workflow) => workflow.name)).toEqual([
      'brief',
      'weekly-report',
    ]);
    expect(definitions.workflow('nope')).toBeNull();
  });

  it('leaves out a Workflow whose Channel note is unknown', () => {
    const { definitions } = definitionsOf({
      'Workflows/Report.md': '---\nchannel: Helth\n---\nReport.',
    });
    expect(definitions.workflow('report')).toBeNull();
    expect(definitions.workflows()).toEqual([]);
  });

  it('tells listeners of changed notes', () => {
    const { definitions, change } = definitionsOf({});
    const listener = vi.fn();
    const stop = definitions.onChange(listener);
    change({ 'Channels/Default.md': 'Hi' });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    change({});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
