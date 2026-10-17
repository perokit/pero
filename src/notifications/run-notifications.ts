import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Notification } from '../persistence/entities/notification.entity.js';
import type { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import type { ResolvedWorkflow } from '../system-files/snapshot.js';
import { NO_DATA } from '../workflows/run-script.js';

/** What a Notification delivers: the rendered message. */
export const notificationPayloadSchema = z.object({ text: z.string().min(1) });

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

/**
 * The whole answer of a run that has nothing to report, such as a check
 * that found everything in order: it completes and notifies no one.
 */
export const SILENT_ANSWER = 'NO_REPLY';

/**
 * What a finished run tells the Channels its Workflow notifies: the
 * answer, headed by the Workflow's title, or why the run
 * failed. Null for a run that tells them nothing: one the owner cancelled,
 * one that answered just `NO_REPLY`, one whose script found no data, and
 * an interrupted one that is retried, whose retry tells them instead.
 */
export function notificationText(
  run: Pick<WorkflowRun, 'id' | 'status' | 'result' | 'errorText'>,
  workflow: Pick<ResolvedWorkflow, 'name' | 'title'>,
  retried: boolean,
): string | null {
  const label = `Run ${run.id} of Workflow ${workflow.name}`;
  switch (run.status) {
    case 'completed': {
      const text = run.result?.text;
      if (typeof text !== 'string' || text.trim() === '') {
        return `${label} completed without an answer`;
      }
      if (text.trim() === SILENT_ANSWER || text.trim() === NO_DATA) {
        return null;
      }
      return `${workflow.title}\n\n${text}`;
    }
    case 'failed':
      return `${label} failed: ${run.errorText ?? 'no reason was recorded'}`;
    case 'interrupted':
      return retried
        ? null
        : `${label} interrupted: ${run.errorText ?? 'no reason was recorded'}`;
    default:
      return null;
  }
}

/**
 * Creates the Notifications of `run`, which has just finished, one
 * `pending` per Channel its Workflow notifies now, due at once. Runs in the
 * caller's transaction, so they commit with the run's final status. Returns
 * how many it created.
 */
export async function createRunNotifications(
  manager: EntityManager,
  run: WorkflowRun,
  workflow: Pick<ResolvedWorkflow, 'name' | 'title' | 'resolved'>,
  retried: boolean,
): Promise<number> {
  const text = notificationText(run, workflow, retried);
  if (text === null) return 0;
  const { targets } = workflow.resolved;
  if (targets.length === 0) return 0;
  const payload: NotificationPayload = { text };
  await manager
    .getRepository(Notification)
    .createQueryBuilder()
    .insert()
    .values(
      targets.map((channelId) => ({
        workflowRunId: run.id,
        channelId,
        status: 'pending' as const,
        payload,
        attempt: 0,
        nextAttemptAt: run.finishedAt ?? new Date(),
      })),
    )
    // One per run and Channel, however often the run is finished.
    .orIgnore()
    .execute();
  return targets.length;
}
