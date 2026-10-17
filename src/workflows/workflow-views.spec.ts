import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../common/errors.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { reconcileSchedulesWithin } from '../scheduler/schedule-state.js';
import { SystemNotes } from '../system/system-notes.service.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { WorkflowViews } from './workflow-views.service.js';
import { WorkflowsModule } from './workflows.module.js';

describe('WorkflowViews', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let views: WorkflowViews;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-workflow-views-');
    await ws.pero({ timezone: 'Europe/Berlin' });
    await ws.channel('Health', { 'channel-id': 'telegram:-100777:5' });
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        WorkflowsModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    ws.use(moduleRef);
    views = moduleRef.get(WorkflowViews);
  });

  afterEach(async () => {
    await moduleRef.close();
    ws.delete();
  });

  /** A Channel Pero has seen at `key`, in a chat that is allowed. */
  async function seen(key: string, title: string | null): Promise<Channel> {
    const [chat, topic] = key.split(':') as [string, string | undefined];
    moduleRef.get(HostConfigService).allow(chat, null);
    const channels = ds.getRepository(Channel);
    return channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: key,
        address:
          topic === undefined
            ? { chatId: chat }
            : { chatId: chat, topicId: topic },
        title,
      }),
    );
  }

  it('shows a note Workflow: its note, Channel note, schedule, and the Channels it names', async () => {
    const home = await seen('-100777', 'Home');
    const health = await seen('-100777:5', 'Health');
    await ws.workflow(
      'Weekly report',
      {
        day: 'sunday',
        hour: 12,
        channel: 'Health',
        history: true,
        'history-channels': ['Health', 'General'],
      },
      'Write the weekly report.',
    );
    await ds.transaction((manager) =>
      reconcileSchedulesWithin(
        manager,
        [
          {
            workflow: 'weekly-report',
            schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
          },
        ],
        new Date('2026-09-28T00:00:00Z'),
      ),
    );

    const view = await views.details('Weekly-Report');
    expect(view).toEqual({
      name: 'weekly-report',
      title: 'Weekly report',
      file: 'data/System/Workflows/Weekly report.md',
      note: 'health',
      noteEnabled: true,
      inputTemplate: 'Write the weekly report.',
      enabled: true,
      maxAttempts: 1,
      script: null,
      schedule: {
        cron: '0 12 * * 0',
        timezone: 'Europe/Berlin',
        nextRunAt: '2026-10-04T10:00:00.000Z',
        lastRunAt: null,
      },
      channels: [
        {
          id: health.id,
          integrationKind: 'telegram',
          key: '-100777:5',
          title: 'Health',
        },
      ],
      history: {
        channels: [
          expect.objectContaining({ id: home.id, title: 'Home' }),
          expect.objectContaining({ id: health.id }),
        ],
        hours: null,
      },
      errors: [],
    });
    expect(await views.list()).toEqual([view]);
  });

  it('shows a Workflow of Default.md with no schedule', async () => {
    await ws.workflow('Brief', {});

    expect(await views.details('brief')).toMatchObject({
      note: 'default',
      noteEnabled: true,
      schedule: null,
      channels: [],
      history: null,
    });
  });

  it('shows the schedule of a disabled Workflow, never due', async () => {
    await ws.workflow('Brief', { hour: 9, timezone: 'UTC', enabled: false });

    expect(await views.details('brief')).toMatchObject({
      enabled: false,
      schedule: {
        cron: '0 9 * * *',
        timezone: 'UTC',
        nextRunAt: null,
        lastRunAt: null,
      },
    });
  });

  it("resolves a Channel once Pero has seen it, until then reporting the note's error", async () => {
    await ws.workflow('Report', { channel: 'Health' });
    expect(await views.list()).toEqual([]);
    await expect(views.details('report')).rejects.toThrow(
      new NotFoundError(
        "Workflow report isn't loaded: data/System/Workflows/Report.md has errors; pero check lists them",
      ),
    );
    expect(moduleRef.get(SystemNotes).snapshot()!.errors).toEqual([
      {
        file: 'Workflows/Report.md',
        property: 'channel',
        message:
          "Pero hasn't seen the Channel telegram:-100777:5 of Channels/Health.md; write something there first",
      },
    ]);

    const health = await seen('-100777:5', 'Health');
    await ws.rescan();

    expect(await views.details('report')).toMatchObject({
      note: 'health',
      channels: [expect.objectContaining({ id: health.id })],
    });
    expect(moduleRef.get(SystemNotes).snapshot()!.errors).toEqual([]);
  });

  it('refuses a Workflow no note defines', async () => {
    await expect(views.details('nope')).rejects.toThrow(
      new NotFoundError('No Workflow named nope'),
    );
    expect(await ds.getRepository(ScheduleState).count()).toBe(0);
  });
});
