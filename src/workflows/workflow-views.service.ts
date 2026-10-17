import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import type {
  WorkflowChannelView,
  WorkflowScheduleView,
  WorkflowView,
} from '../control/protocol.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  type ScheduleTimes,
  scheduleStatesWithin,
  stateOf,
} from '../scheduler/schedule-state.js';
import { findWorkflowNote, shownPath } from '../system-files/note-paths.js';
import type {
  ChannelNote,
  ResolvedWorkflow,
} from '../system-files/snapshot.js';
import { Definitions } from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';

/**
 * Workflows as the CLI shows them: their note, their Channel note, when they run
 * next, and the Channels they name.
 */
@Injectable()
export class WorkflowViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly notes: SystemNotes,
  ) {}

  /** Every Workflow, by name. */
  list(): Promise<WorkflowView[]> {
    return this.views(this.definitions.workflows());
  }

  /**
   * The Workflow named `name`; `NotFoundError` if none, naming its note
   * when that has errors and never loaded.
   */
  async details(name: string): Promise<WorkflowView> {
    const workflow = this.definitions.workflow(name);
    if (workflow === null) throw missingWorkflow(this.notes, name);
    const [view] = await this.views([workflow]);
    if (view === undefined) throw missingWorkflow(this.notes, name);
    return view;
  }

  private views(workflows: ResolvedWorkflow[]): Promise<WorkflowView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const ids = new Set(
        workflows.flatMap(({ history, resolved }) => [
          ...resolved.targets,
          ...(history === null || resolved.history === 'all'
            ? []
            : resolved.history),
        ]),
      );
      const channels = new Map(
        (await manager.getRepository(Channel).findBy({ id: In([...ids]) })).map(
          (channel) => [channel.id, channelView(channel)],
        ),
      );
      const states = await scheduleStatesWithin(
        manager,
        workflows.length === 1 ? workflows[0]!.name : undefined,
      );
      return workflows
        .map((workflow) =>
          this.view(
            workflow,
            this.definitions.channelNote(workflow.note),
            channels,
            states,
          ),
        )
        .filter((view) => view !== null);
    });
  }

  /** `workflow` as the CLI shows it; null when a rescan since removed its note. */
  private view(
    workflow: ResolvedWorkflow,
    agent: ChannelNote,
    channels: ReadonlyMap<number, WorkflowChannelView>,
    states: ReadonlyMap<string, ScheduleTimes>,
  ): WorkflowView | null {
    const note = this.note(workflow.name);
    if (note === null) return null;
    const named = (ids: readonly number[]) =>
      ids.flatMap((id) => {
        const channel = channels.get(id);
        return channel === undefined ? [] : [channel];
      });
    const { history, resolved } = workflow;
    return {
      name: workflow.name,
      title: workflow.title,
      ...note,
      note: workflow.note,
      noteEnabled: agent.enabled,
      inputTemplate: workflow.input,
      enabled: workflow.enabled,
      maxAttempts: workflow.maxAttempts,
      script: workflow.script,
      schedule: scheduleView(workflow, states),
      channels: named(resolved.targets),
      history:
        history === null
          ? null
          : {
              channels:
                resolved.history === 'all' ? 'all' : named(resolved.history),
              hours: history.hours,
            },
    };
  }

  /** The note of the Workflow named `name`, and its errors; null if none. */
  private note(name: string): Pick<WorkflowView, 'file' | 'errors'> | null {
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    const note = snapshot?.workflows.get(name);
    if (snapshot === null || note === undefined) return null;
    return {
      file: shownPath(folders.workspace, join(folders.systemFolder, note.file)),
      errors: snapshot.errors
        .filter((error) => error.file === note.file)
        .map(({ property, message }) => ({ property, message })),
    };
  }
}

/**
 * Why there is no Workflow named `name`: its note has errors and never
 * loaded, or there is no such note.
 */
export function missingWorkflow(
  notes: SystemNotes,
  name: string,
): NotFoundError {
  const snapshot = notes.snapshot();
  const folders = notes.folders();
  if (snapshot !== null) {
    const broken = findWorkflowNote(
      snapshot.errors.map((error) => error.file),
      name,
    );
    if (broken !== null) {
      const file = shownPath(
        folders.workspace,
        join(folders.systemFolder, broken),
      );
      return new NotFoundError(
        `Workflow ${name} isn't loaded: ${file} has errors; pero check lists them`,
      );
    }
  }
  return new NotFoundError(`No Workflow named ${name}`);
}

function channelView(channel: Channel): WorkflowChannelView {
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
  };
}

/** `workflow`'s schedule, with where `states` say it stands; null if none. */
function scheduleView(
  { name, schedule }: ResolvedWorkflow,
  states: ReadonlyMap<string, ScheduleTimes>,
): WorkflowScheduleView | null {
  if (schedule === null) return null;
  const times = stateOf(states, name, schedule);
  return {
    cron: schedule.cron,
    timezone: schedule.timezone,
    nextRunAt: times?.nextRunAt?.toISOString() ?? null,
    lastRunAt: times?.lastRunAt?.toISOString() ?? null,
  };
}
