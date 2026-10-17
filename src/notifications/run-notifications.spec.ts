import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { notificationText } from './run-notifications.js';

type FinishedRun = Pick<WorkflowRun, 'id' | 'status' | 'result' | 'errorText'>;

const run = (fields: Partial<FinishedRun>): FinishedRun => ({
  id: 7,
  status: 'completed',
  result: null,
  errorText: null,
  ...fields,
});

const english = { name: 'english', title: 'Evening English' };

describe('notificationText', () => {
  it("posts a completed run's answer under the Workflow's title", () => {
    const done = run({ result: { text: 'Say "went", not "goed".' } });

    expect(notificationText(done, english, false)).toBe(
      'Evening English\n\nSay "went", not "goed".',
    );
  });

  it('says when a completed run has no answer', () => {
    expect(
      notificationText(run({ result: { text: ' ' } }), english, false),
    ).toBe('Run 7 of Workflow english completed without an answer');
  });

  it('posts nothing for a run that answered just NO_REPLY', () => {
    expect(
      notificationText(run({ result: { text: 'NO_REPLY' } }), english, false),
    ).toBeNull();
    expect(
      notificationText(
        run({ result: { text: '\n NO_REPLY \n' } }),
        english,
        false,
      ),
    ).toBeNull();
    expect(
      notificationText(
        run({ result: { text: 'NO_REPLY: breakfast is logged' } }),
        english,
        false,
      ),
    ).toBe('Evening English\n\nNO_REPLY: breakfast is logged');
  });

  it('posts nothing for a run whose script found no data', () => {
    expect(
      notificationText(run({ result: { text: 'NO_DATA' } }), english, false),
    ).toBeNull();
  });

  it('posts why a run failed, or was interrupted and not retried', () => {
    expect(
      notificationText(
        run({ status: 'failed', errorText: 'The model is overloaded' }),
        english,
        false,
      ),
    ).toBe('Run 7 of Workflow english failed: The model is overloaded');
    const interrupted = run({
      status: 'interrupted',
      errorText: 'Pero stopped before the run finished; not retried',
    });
    expect(notificationText(interrupted, english, false)).toBe(
      'Run 7 of Workflow english interrupted: Pero stopped before the run finished; not retried',
    );
    // Its retry posts instead.
    expect(notificationText(interrupted, english, true)).toBeNull();
  });

  it('posts nothing for a cancelled run', () => {
    expect(
      notificationText(run({ status: 'cancelled' }), english, false),
    ).toBeNull();
  });
});
