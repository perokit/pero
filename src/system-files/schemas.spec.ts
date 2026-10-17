import { describe, expect, it } from 'vitest';
import type { ParsedNote } from './note.js';
import {
  type NoteResult,
  readChannelNote,
  readPeroNote,
  readTextNote,
  readWorkflowNote,
} from './schemas.js';

const PERO = 'Pero.md';
const CHANNEL = 'Channels/Health.md';
const WORKFLOW = 'Workflows/Weekly health report.md';

function note(
  properties: Record<string, unknown>,
  body: string | null = null,
): ParsedNote {
  return { properties, body };
}

function value<T>(result: NoteResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errors<T>(result: NoteResult<T>) {
  if (result.ok) throw new Error(`expected errors: ${JSON.stringify(result)}`);
  return result.errors;
}

/** The one error `properties` gives on `property`, as its message. */
function messageFor(
  read: (file: string, note: ParsedNote) => NoteResult<unknown>,
  file: string,
  properties: Record<string, unknown>,
  body: string | null = 'Body',
): string {
  const found = errors(read(file, note(properties, body)));
  expect(found).toHaveLength(1);
  expect(found[0]!.file).toBe(file);
  expect(found[0]!.property).toBe(Object.keys(properties)[0]);
  return found[0]!.message;
}

describe('readPeroNote', () => {
  const invalid = (properties: Record<string, unknown>) =>
    messageFor(readPeroNote, PERO, properties, null);

  it("takes Pero's defaults for everything left out", () => {
    expect(value(readPeroNote(PERO, note({})))).toEqual({
      provider: 'claude',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'ask',
      timezone: null,
      historyCarryover: 50,
      historyRetentionDays: null,
      maxConcurrentRuns: 2,
    });
  });

  it('reads every property', () => {
    expect(
      value(
        readPeroNote(
          PERO,
          note(
            {
              provider: 'codex',
              'claude-model': 'opus',
              'claude-effort': 'high',
              'codex-model': 'gpt-5.5',
              'codex-effort': 'minimal',
              permissions: 'bypass',
              timezone: 'europe/berlin',
              'history-carryover': 0,
              'history-retention-days': 90,
              'max-concurrent-runs': 10,
            },
            null,
          ),
        ),
      ),
    ).toEqual({
      provider: 'codex',
      providerDefaults: {
        claude: { model: 'opus', effort: 'high' },
        codex: { model: 'gpt-5.5', effort: 'minimal' },
      },
      permissions: 'bypass',
      timezone: 'Europe/Berlin',
      historyCarryover: 0,
      historyRetentionDays: 90,
      maxConcurrentRuns: 10,
    });
  });

  it('refuses a body: instructions belong in Instructions.md', () => {
    const result = readPeroNote(
      PERO,
      note({ provider: 'gemini' }, 'You are a calm assistant.'),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.property)).toEqual([
      'provider',
      null,
    ]);
    expect(!result.ok && result.errors[1]!.message).toMatch(
      /^holds settings only: move its text to Instructions.md or Persona.md/,
    );
  });

  it('treats a property left empty as not set', () => {
    expect(
      value(readPeroNote(PERO, note({ provider: null, timezone: null }))),
    ).toMatchObject({ provider: 'claude', timezone: null });
  });

  it('refuses invalid values', () => {
    expect(invalid({ provider: 'gemini' })).toBe('must be claude or codex');
    expect(invalid({ 'claude-model': '' })).toBe('must not be empty');
    expect(invalid({ 'claude-model': 4 })).toBe('must be text');
    expect(invalid({ 'claude-effort': 'minimal' })).toBe(
      'must be low, medium, high, xhigh, or max',
    );
    expect(invalid({ 'codex-effort': 'extreme' })).toMatch(/^must be minimal,/);
    expect(invalid({ permissions: 'yes' })).toBe('must be ask or bypass');
    expect(invalid({ timezone: 'Mars/Olympus' })).toBe(
      'must be an IANA time zone such as Europe/Berlin',
    );
    expect(invalid({ timezone: '+05:00' })).toBe(
      'must be an IANA time zone such as Europe/Berlin',
    );
    expect(invalid({ timezone: 1 })).toBe(
      'must be an IANA time zone such as Europe/Berlin',
    );
    expect(invalid({ 'main-agent': 'Main' })).toBe('unknown property');
    expect(invalid({ 'history-carryover': -1 })).toBe(
      'must be a whole number, 0 or more',
    );
    expect(invalid({ 'history-carryover': 1.5 })).toBe(
      'must be a whole number, 0 or more',
    );
    expect(invalid({ 'history-retention-days': 0 })).toBe(
      'must be a whole number from 1 to 36500',
    );
    expect(invalid({ 'max-concurrent-runs': 11 })).toBe(
      'must be a whole number from 1 to 10',
    );
    expect(invalid({ 'max-concurrent-runs': '2' })).toBe(
      'must be a whole number from 1 to 10',
    );
  });

  it('refuses Channel note properties, suggesting the right one', () => {
    expect(invalid({ model: 'opus' })).toBe('unknown property');
    expect(invalid({ 'claude-modle': 'opus' })).toBe(
      'unknown property (did you mean claude-model?)',
    );
  });

  it('reports every problem at once', () => {
    expect(
      errors(
        readPeroNote(
          PERO,
          note({ provider: 'gemini', modle: 'x', 'max-concurrent-runs': 0 }),
        ),
      ).map((error) => error.property),
    ).toEqual(['modle', 'provider', 'max-concurrent-runs']);
  });
});

describe('readChannelNote', () => {
  const invalid = (properties: Record<string, unknown>) =>
    messageFor(readChannelNote, CHANNEL, properties);

  it('leaves what it omits to Pero.md', () => {
    expect(value(readChannelNote(CHANNEL, note({})))).toEqual({
      channelId: null,
      provider: null,
      model: null,
      effort: null,
      permissions: null,
      workingDirectory: null,
      skipGitRepoCheck: false,
      enabled: true,
      instructions: null,
    });
  });

  it('reads every property, and the body as its instructions', () => {
    expect(
      value(
        readChannelNote(
          CHANNEL,
          note(
            {
              'channel-id': 'telegram:-1001234567890:5',
              provider: 'codex',
              model: 'gpt-5.5',
              effort: 'ultra',
              permissions: 'bypass',
              'working-directory': 'projects/site',
              'skip-git-repo-check': true,
              enabled: false,
              tags: ['pero'],
            },
            'You are my health coach.',
          ),
        ),
      ),
    ).toEqual({
      channelId: 'telegram:-1001234567890:5',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'ultra',
      permissions: 'bypass',
      workingDirectory: 'projects/site',
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'You are my health coach.',
    });
  });

  it('reads a channel-id, trimmed', () => {
    expect(
      value(
        readChannelNote(
          CHANNEL,
          note({ 'channel-id': ' telegram:123456789 ' }),
        ),
      ).channelId,
    ).toBe('telegram:123456789');
  });

  it('accepts any provider’s effort, to check once the provider is known', () => {
    expect(
      value(readChannelNote(CHANNEL, note({ effort: 'minimal' }))).effort,
    ).toBe('minimal');
    expect(
      value(readChannelNote(CHANNEL, note({ effort: 'max' }))).effort,
    ).toBe('max');
  });

  it('refuses invalid values', () => {
    expect(invalid({ 'channel-id': 'Health' })).toBe(
      'must be <integration>:<address>, such as telegram:-1001234567890:5',
    );
    expect(invalid({ 'channel-id': 5 })).toBe(
      'must be <integration>:<address>, such as telegram:-1001234567890:5',
    );
    expect(invalid({ provider: 'openai' })).toBe('must be claude or codex');
    expect(invalid({ model: '  ' })).toBe('must not be empty');
    expect(invalid({ effort: 'huge' })).toMatch(/^must be low, medium, high,/);
    expect(invalid({ permissions: 'always' })).toBe('must be ask or bypass');
    expect(invalid({ 'working-directory': 'a\0b' })).toBe(
      'must not contain a NUL byte',
    );
    expect(invalid({ 'skip-git-repo-check': 1 })).toBe('must be true or false');
    expect(invalid({ enabled: 'yes' })).toBe('must be true or false');
  });

  it('refuses unknown properties, suggesting the right one', () => {
    expect(invalid({ modle: 'sonnet' })).toBe(
      'unknown property (did you mean model?)',
    );
    expect(invalid({ topic: 'Health' })).toBe('unknown property');
    expect(invalid({ 'skip-main-instructions': true })).toBe(
      'unknown property',
    );
    expect(invalid({ 'claude-model': 'opus' })).toBe('unknown property');
  });
});

describe('readWorkflowNote', () => {
  const read = (properties: Record<string, unknown>, body = 'Do the thing') =>
    value(readWorkflowNote(WORKFLOW, note(properties, body)));
  const invalid = (properties: Record<string, unknown>) =>
    messageFor(readWorkflowNote, WORKFLOW, properties);

  it('runs only by hand without a time', () => {
    expect(read({})).toEqual({
      schedule: null,
      channels: [],
      history: null,
      maxAttempts: 1,
      enabled: true,
      script: null,
      input: 'Do the thing',
    });
  });

  it('reads the weekly report from the overview', () => {
    expect(
      read(
        {
          day: 'sunday',
          hour: 12,
          minute: 0,
          channel: 'Health',
        },
        '# Workflow Instruction\nCreate a weekly report…',
      ),
    ).toEqual({
      schedule: { cron: '0 12 * * 0', timezone: null },
      channels: ['Health'],
      history: null,
      maxAttempts: 1,
      enabled: true,
      script: null,
      input: '# Workflow Instruction\nCreate a weekly report…',
    });
  });

  it('turns day, hour, and minute into a schedule', () => {
    const cron = (properties: Record<string, unknown>) =>
      read(properties).schedule?.cron;
    expect(cron({ hour: 7 })).toBe('0 7 * * *');
    expect(cron({ day: 'weekdays', hour: [9, 18] })).toBe('0 9,18 * * 1-5');
    expect(cron({ day: 'Sunday', hour: 12, minute: 30 })).toBe('30 12 * * 0');
    expect(cron({ day: ['monday', 'friday'], hour: 8 })).toBe('0 8 * * 1,5');
    expect(cron({ day: 'daily', hour: [18, 9, 9] })).toBe('0 9,18 * * *');
    expect(cron({ day: 'weekends', hour: 10 })).toBe('0 10 * * 0,6');
  });

  it('takes cron for anything else, nicknames too', () => {
    expect(read({ cron: '*/15 9-17 * * 1-5' }).schedule).toEqual({
      cron: '*/15 9-17 * * 1-5',
      timezone: null,
    });
    expect(read({ cron: '@Daily' }).schedule?.cron).toBe('@daily');
  });

  it('keeps its own time zone', () => {
    expect(read({ hour: 9, timezone: 'Asia/Tokyo' }).schedule).toEqual({
      cron: '0 9 * * *',
      timezone: 'Asia/Tokyo',
    });
  });

  it('keeps the schedule of a disabled Workflow, which then does not run', () => {
    expect(read({ enabled: false, day: 'sunday', hour: 12 })).toMatchObject({
      schedule: { cron: '0 12 * * 0', timezone: null },
      enabled: false,
    });
  });

  it('reads channels and limits', () => {
    expect(
      read({
        channel: ['Health', 'Home/General', 5],
        'max-attempts': 3,
        enabled: false,
      }),
    ).toMatchObject({
      channels: ['Health', 'Home/General', 5],
      maxAttempts: 3,
      enabled: false,
    });
    expect(read({ channel: 'General' }).channels).toEqual(['General']);
  });

  it('reads chat history as input only when history is true', () => {
    expect(read({ history: true }).history).toEqual({
      channels: { current: true, default: false, named: [] },
      hours: null,
    });
    expect(
      read({
        history: true,
        'history-channels': ['English', 7, 'Default'],
        'history-hours': 24,
      }).history,
    ).toEqual({
      channels: { current: false, default: true, named: ['English', 7] },
      hours: 24,
    });
    expect(
      read({ history: true, 'history-channels': 'current' }).history,
    ).toEqual({
      channels: { current: true, default: false, named: [] },
      hours: null,
    });
    expect(
      read({ history: true, 'history-channels': 'All' }).history?.channels,
    ).toBe('all');
    expect(
      read({ history: false, 'history-hours': 24, 'history-channels': 'X' })
        .history,
    ).toBeNull();
  });

  it('reads the script each run runs first', () => {
    expect(read({ script: '  tsx scripts/check.ts ' }).script).toBe(
      'tsx scripts/check.ts',
    );
    expect(invalid({ script: ' ' })).toBe('must not be empty');
    expect(invalid({ script: ['tsx', 'check.ts'] })).toBe('must be text');
    expect(invalid({ scripts: 'tsx check.ts' })).toMatch(/script/);
  });

  it('needs a body', () => {
    expect(errors(readWorkflowNote(WORKFLOW, note({ hour: 9 })))).toEqual([
      {
        file: WORKFLOW,
        property: null,
        message: 'the note has no text: write what each run asks',
      },
    ]);
    expect(
      errors(readWorkflowNote(WORKFLOW, note({ hour: 25 }))).map(
        (error) => error.property,
      ),
    ).toEqual(['hour', null]);
  });

  it('refuses cron together with day, hour, or minute', () => {
    for (const time of [{ day: 'sunday' }, { hour: 9 }, { minute: 5 }]) {
      expect(invalid({ cron: '0 9 * * *', ...time })).toBe(
        'replaces day, hour, and minute; use one or the other',
      );
    }
  });

  it('needs an hour for a schedule', () => {
    expect(invalid({ hour: undefined, day: 'sunday' })).toBe(
      'must be set when day or minute is',
    );
    expect(invalid({ hour: undefined, minute: 30 })).toBe(
      'must be set when day or minute is',
    );
  });

  it('refuses invalid values', () => {
    expect(invalid({ day: 'funday', hour: 9 })).toBe(
      'must be a weekday such as sunday, or daily, weekdays, or weekends',
    );
    expect(invalid({ day: ['monday', 'mon'], hour: 9 })).toBe(
      'must be a weekday such as sunday, or daily, weekdays, or weekends (item 2)',
    );
    expect(invalid({ hour: 24 })).toBe('must be a whole number from 0 to 23');
    expect(invalid({ hour: [9, '18'] })).toBe(
      'must be a whole number from 0 to 23 (item 2)',
    );
    expect(invalid({ hour: '12:00' })).toBe(
      'must be a whole number from 0 to 23',
    );
    expect(invalid({ minute: 60, hour: 9 })).toBe(
      'must be a whole number from 0 to 59',
    );
    expect(invalid({ cron: '0 9 * *' })).toMatch(
      /^must be a cron expression of five fields/,
    );
    expect(invalid({ cron: '0 25 * * *' })).toMatch(
      /^must be a cron expression of five fields/,
    );
    expect(invalid({ timezone: 'Nowhere' })).toBe(
      'must be an IANA time zone such as Europe/Berlin',
    );
    expect(invalid({ channel: ['Health', ''] })).toBe(
      'must not be empty (item 2)',
    );
    expect(invalid({ channel: ['Health', true] })).toBe(
      'must be a Channel note name or a Channel ID (item 2)',
    );
    expect(invalid({ channel: -5 })).toBe(
      'must be a Channel note name or a Channel ID',
    );
    expect(invalid({ agent: 'Health' })).toBe('unknown property');
    expect(invalid({ history: 'yes' })).toBe('must be true or false');
    expect(invalid({ 'history-channels': [] })).toBe(
      'must name at least one Channel; leave it out to read the current ones',
    );
    expect(invalid({ 'history-channels': ['all', 'Health'] })).toBe(
      'all reads every Channel; leave the others out',
    );
    expect(invalid({ 'history-channels': -5 })).toBe(
      'must be all, current, default, a Channel note name, or a Channel ID',
    );
    expect(invalid({ 'history-messages': 'all' })).toBe('unknown property');
    expect(invalid({ 'history-hours': 721 })).toBe(
      'must be a whole number from 1 to 720',
    );
    expect(invalid({ 'run-when-empty': true })).toBe('unknown property');
    expect(invalid({ 'max-attempts': 11 })).toBe('must be at most 10');
    expect(invalid({ enabled: 0 })).toBe('must be true or false');
  });

  it('refuses unknown properties, suggesting the right one', () => {
    expect(invalid({ chanel: 'Health' })).toBe(
      'unknown property (did you mean channel?)',
    );
    expect(invalid({ topics: ['Health'] })).toBe('unknown property');
    // `enabled: false` is what runs it only by hand.
    expect(invalid({ trigger: 'manual', hour: 9 })).toBe('unknown property');
  });
});

describe('readTextNote', () => {
  it('reads the body, allowing only Obsidian’s properties', () => {
    expect(
      value(readTextNote('Persona.md', note({ tags: ['pero'] }, 'Be kind.'))),
    ).toBe('Be kind.');
    expect(value(readTextNote('Persona.md', note({})))).toBeNull();
    expect(messageFor(readTextNote, 'Instructions.md', { model: 'opus' })).toBe(
      'unknown property',
    );
  });
});
