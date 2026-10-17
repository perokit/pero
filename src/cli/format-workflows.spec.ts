import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  RunView,
  WorkflowChannelView,
  WorkflowView,
} from '../control/protocol.js';
import {
  noteWarning,
  formatWorkflowDetails,
  formatWorkflowList,
  runOutcome,
} from './format-workflows.js';

const english: WorkflowChannelView = {
  id: 5,
  integrationKind: 'telegram',
  key: '-100777:7',
  title: 'English',
};

const direct: WorkflowChannelView = {
  id: 9,
  integrationKind: 'telegram',
  key: '1234',
  title: null,
};

const review: WorkflowView = {
  name: 'evening-review',
  title: 'Evening review',
  file: 'data/System/Workflows/Evening review.md',
  note: 'coach',
  noteEnabled: true,
  inputTemplate: "Review today's chats.\nSuggest one improvement.",
  enabled: true,
  maxAttempts: 1,
  script: null,
  schedule: {
    cron: '0 21 * * *',
    timezone: 'Europe/Berlin',
    nextRunAt: '2026-09-28T19:00:00.000Z',
    lastRunAt: null,
  },
  channels: [english],
  history: null,
  errors: [],
};

describe('Workflow formatting', () => {
  const zone = process.env.TZ;

  // A fixed offset, so local time is provably not the recorded UTC.
  beforeAll(() => {
    process.env.TZ = 'Etc/GMT-5';
  });

  afterAll(() => {
    process.env.TZ = zone;
  });

  it('lists Workflows with their Channel note, schedule, next run, Channels, and note', () => {
    expect(
      formatWorkflowList([
        {
          ...review,
          name: 'brief',
          file: 'data/System/Workflows/Brief.md',
          noteEnabled: false,
          schedule: null,
          channels: [],
          errors: [{ property: 'channel', message: 'no topic titled "x"' }],
        },
        { ...review, channels: [english, direct] },
        { ...review, name: 'paused', enabled: false },
      ]),
    ).toBe(
      [
        'NAME            CHANNEL NOTE      SCHEDULE                    NEXT RUN          CHANNELS            STATE     NOTE',
        'brief !         coach (disabled)  by hand                     —                 —                   enabled   data/System/Workflows/Brief.md',
        'evening-review  coach             0 21 * * * (Europe/Berlin)  2026-09-29 00:00  English, Channel 9  enabled   data/System/Workflows/Evening review.md',
        'paused          coach             0 21 * * * (Europe/Berlin)  —                 English             disabled  data/System/Workflows/Evening review.md',
        '',
        '! its note has errors, so its last good version is in use; pero check lists them',
      ].join('\n'),
    );
  });

  it('says where to add the first Workflow', () => {
    expect(formatWorkflowList([])).toBe(
      'No Workflows yet. Add a note to the Workflows folder in the system folder.',
    );
  });

  it('shows a Workflow with its note, schedule, and the Channels it posts to', () => {
    expect(
      formatWorkflowDetails({
        ...review,
        channels: [english, direct],
        schedule: {
          ...review.schedule!,
          lastRunAt: '2026-09-27T19:00:00.000Z',
        },
      }),
    ).toBe(
      [
        'Workflow evening-review "Evening review"',
        '  note          data/System/Workflows/Evening review.md',
        '  channel note  coach',
        "  input         Review today's chats. (2 lines)",
        '  schedule      0 21 * * * (Europe/Berlin)',
        '  next run      2026-09-29 00:00',
        '  last run      2026-09-28 00:00',
        '  runs          one at a time',
        '  attempts      1 (a run Pero stops is not started again)',
        '  history       none',
        '  state         enabled',
        '',
        'Posts to',
        '  ID  CHANNEL             TITLE',
        '  5   telegram -100777:7  English',
        '  9   telegram 1234       —',
      ].join('\n'),
    );
  });

  it('shows the script a Workflow runs first', () => {
    expect(
      formatWorkflowDetails({ ...review, script: 'tsx scripts/check.ts' }),
    ).toContain(
      "  input         Review today's chats. (2 lines)\n" +
        '  script        tsx scripts/check.ts (NO_DATA skips the turn)\n',
    );
  });

  it("shows a Workflow's errors, and warns about a disabled Channel note", () => {
    expect(
      formatWorkflowDetails({
        ...review,
        noteEnabled: false,
        enabled: false,
        maxAttempts: 3,
        schedule: null,
        channels: [],
        history: {
          channels: [english, direct],
          hours: 12,
        },
        errors: [
          { property: 'channel', message: 'no topic titled "Helth"' },
          { property: null, message: 'the note has no text' },
        ],
      }),
    ).toBe(
      [
        'Workflow evening-review "Evening review"',
        '  note          data/System/Workflows/Evening review.md',
        '  channel note  coach (disabled)',
        "  input         Review today's chats. (2 lines)",
        '  schedule      none: it runs by hand, with pero workflows run',
        '  runs          one at a time',
        '  attempts      up to 3 (a run Pero stops starts again when Pero does)',
        '  history       messages in English, Channel 9 from the last 12 hours',
        '  state         disabled: it runs only by hand, with pero workflows run',
        '',
        'Its note has errors, so its last good version is in use:',
        '  channel: no topic titled "Helth"',
        '  the note has no text',
        '',
        'Warning: Channel note coach is disabled, so this Workflow cannot run until it is enabled again (enabled: true in that note).',
        '',
        'Posts to no Channel: name a Channel note in channel in its note to post its answers there.',
      ].join('\n'),
    );
    expect(noteWarning(review)).toBeNull();
  });

  it("gives a finished run's answer, or why there is none", () => {
    const run: RunView = {
      id: 7,
      workflow: 'evening-review',
      triggerKey: 'manual:0f8c',
      status: 'completed',
      attempt: 1,
      skippedCount: 0,
      createdAt: '2026-09-28T19:00:00.000Z',
      startedAt: '2026-09-28T19:00:01.000Z',
      finishedAt: '2026-09-28T19:00:09.000Z',
      result: 'Two suggestions.',
      error: null,
    };
    expect(runOutcome(run)).toEqual({ ok: true, text: 'Two suggestions.' });
    expect(
      runOutcome({
        ...run,
        status: 'failed',
        result: null,
        error: 'The model is overloaded',
      }),
    ).toEqual({
      ok: false,
      text: 'Run 7 of Workflow evening-review failed: The model is overloaded',
    });
    expect(
      runOutcome({ ...run, status: 'interrupted', result: null, error: null }),
    ).toEqual({
      ok: false,
      text: 'Run 7 of Workflow evening-review interrupted: no reason was recorded',
    });
  });
});
