import type {
  RunView,
  WorkflowChannelView,
  WorkflowScheduleView,
  WorkflowView,
} from '../control/protocol.js';
import { localDateTime } from './format-channels.js';
import { table } from './format-status.js';
import { preview } from './preview.js';

/** `pero workflows ls`: one row per Workflow. */
export function formatWorkflowList(workflows: readonly WorkflowView[]): string {
  if (workflows.length === 0) {
    return 'No Workflows yet. Add a note to the Workflows folder in the system folder.';
  }
  const lines = table([
    [
      'NAME',
      'CHANNEL NOTE',
      'SCHEDULE',
      'NEXT RUN',
      'CHANNELS',
      'STATE',
      'NOTE',
    ],
    ...workflows.map((workflow) => [
      `${workflow.name}${workflow.errors.length > 0 ? ' !' : ''}`,
      channelNote(workflow),
      workflow.schedule === null ? 'by hand' : schedule(workflow.schedule),
      workflow.schedule === null ? '—' : nextRun(workflow, workflow.schedule),
      workflow.channels.map(channelLabel).join(', ') || '—',
      state(workflow.enabled),
      workflow.file,
    ]),
  ]);
  if (workflows.some((workflow) => workflow.errors.length > 0)) {
    lines.push(
      '',
      '! its note has errors, so its last good version is in use; pero check lists them',
    );
  }
  return lines.join('\n');
}

/** `pero workflows show`: the definition, then the Channels it posts to. */
export function formatWorkflowDetails(workflow: WorkflowView): string {
  const lines = [
    `Workflow ${workflow.name} "${workflow.title}"`,
    ...table([
      ['note', workflow.file],
      ['channel note', channelNote(workflow)],
      ['input', preview(workflow.inputTemplate)],
      ...(workflow.script === null
        ? []
        : [['script', `${workflow.script} (NO_DATA skips the turn)`]]),
      ...(workflow.schedule === null
        ? [['schedule', 'none: it runs by hand, with pero workflows run']]
        : [
            ['schedule', schedule(workflow.schedule)],
            ['next run', nextRun(workflow, workflow.schedule)],
            [
              'last run',
              workflow.schedule.lastRunAt === null
                ? 'never'
                : localDateTime(new Date(workflow.schedule.lastRunAt)),
            ],
          ]),
      ['runs', 'one at a time'],
      ['attempts', attempts(workflow.maxAttempts)],
      ['history', history(workflow.history)],
      [
        'state',
        workflow.enabled
          ? 'enabled'
          : 'disabled: it runs only by hand, with pero workflows run',
      ],
    ]).map((row) => `  ${row}`),
  ];
  if (workflow.errors.length > 0) {
    lines.push(
      '',
      'Its note has errors, so its last good version is in use:',
      ...workflow.errors.map(
        ({ property, message }) =>
          `  ${property === null ? '' : `${property}: `}${message}`,
      ),
    );
  }
  const warning = noteWarning(workflow);
  if (warning !== null) lines.push('', warning);
  lines.push('');
  if (workflow.channels.length === 0) {
    lines.push(
      'Posts to no Channel: name a Channel note in channel in its note to post its answers there.',
    );
  } else {
    lines.push(
      'Posts to',
      ...table([
        ['ID', 'CHANNEL', 'TITLE'],
        ...workflow.channels.map((channel) => [
          String(channel.id),
          `${channel.integrationKind} ${channel.key}`,
          channel.title ?? '—',
        ]),
      ]).map((row) => `  ${row}`),
    );
  }
  return lines.join('\n');
}

/**
 * What a finished run leaves the owner: its answer, or why there
 * is none.
 */
export function runOutcome(run: RunView): { ok: boolean; text: string } {
  if (run.status === 'completed') {
    return {
      ok: true,
      text: run.result ?? '',
    };
  }
  return {
    ok: false,
    text:
      `Run ${run.id} of Workflow ${run.workflow} ${run.status}: ` +
      (run.error ?? 'no reason was recorded'),
  };
}

/** How a Workflow treats a run Pero stopped before it finished. */
function attempts(maxAttempts: number): string {
  return maxAttempts === 1
    ? '1 (a run Pero stops is not started again)'
    : `up to ${maxAttempts} (a run Pero stops starts again when Pero does)`;
}

/**
 * The Channel history a Workflow's runs read, such as `messages in
 * Channels 3, 5 since the previous run`.
 */
function history(config: WorkflowView['history']): string {
  if (config === null) return 'none';
  const channels =
    config.channels === 'all'
      ? 'all Channels'
      : config.channels.length === 0
        ? 'no Channels Pero has seen yet'
        : config.channels.map(channelLabel).join(', ');
  const window =
    config.hours === null
      ? 'since the previous run'
      : `from the last ${config.hours === 1 ? 'hour' : `${config.hours} hours`}`;
  return `messages in ${channels} ${window}`;
}

/** Why the Workflow cannot run; null when it can. */
export function noteWarning(workflow: WorkflowView): string | null {
  if (workflow.noteEnabled) return null;
  return (
    `Warning: Channel note ${workflow.note} is disabled, so this Workflow ` +
    'cannot run until it is enabled again (enabled: true in that note).'
  );
}

/** `0 12 * * 0 (Europe/Berlin)`. */
function schedule(one: WorkflowScheduleView): string {
  return `${one.cron} (${one.timezone})`;
}

function nextRun(workflow: WorkflowView, one: WorkflowScheduleView): string {
  if (!workflow.enabled) return '—';
  return one.nextRunAt === null
    ? 'none'
    : localDateTime(new Date(one.nextRunAt));
}

/** A topic by its title, or a Channel without one by its ID. */
function channelLabel(channel: WorkflowChannelView): string {
  return channel.title ?? `Channel ${channel.id}`;
}

function channelNote(workflow: WorkflowView): string {
  return workflow.noteEnabled ? workflow.note : `${workflow.note} (disabled)`;
}

function state(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}
