import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AgentManager, TurnError } from '../agents/agent-manager.js';
import { MessageHistory } from '../history/message-history.service.js';
import {
  type RunStatus,
  WorkflowRun,
} from '../persistence/entities/workflow-run.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import type {
  ChannelNote,
  ResolvedWorkflow,
} from '../system-files/snapshot.js';
import { Definitions } from '../system/definitions.js';
import {
  type ExecutionSnapshot,
  executionSnapshot,
  snapshotRequest,
} from './execution-snapshot.js';
import { finishRun } from './finish-run.js';
import { readHistoryWindow } from './history-window.js';
import { queueRetryWithin } from './retry-run.js';
import { isScheduled } from './run-keys.js';
import {
  isNoData,
  NO_DATA,
  renderScriptInput,
  runScript,
  SCRIPT_TIMEOUT_MS,
  ScriptError,
} from './run-script.js';

/** A run the executor has claimed and marked `running`. */
interface ClaimedRun {
  runId: number;
  /** The name of its Workflow. */
  workflow: string;
  snapshot: ExecutionSnapshot;
}

/**
 * How a run ended: recorded, or `left` running for startup recovery when
 * Pero stopped it.
 */
type Outcome =
  | { status: 'completed'; text: string; providerSessionId: string | null }
  | { status: Extract<RunStatus, 'failed' | 'cancelled'>; error: string }
  | { status: 'left' };

/** Why a run Pero stopped did not finish. */
export const INTERRUPTED = 'Pero stopped before the run finished';

/** Why a run the owner cancelled did not finish. */
export const CANCELLED = 'Cancelled with pero runs cancel';

/**
 * The bounded in-process executor for Workflow Runs. SQLite holds the work:
 * the executor claims the oldest `pending` run while fewer than the
 * `max-concurrent-runs` setting are running, at most one per Workflow, and
 * runs it through `AgentManager` in a context of its own, away from every
 * Channel's Session. It never holds a transaction while a turn runs.
 *
 * A run Pero stops, by crashing or by aborting it on shutdown, stays
 * `running` until the next startup records it `interrupted` and, when its
 * Workflow allows another attempt, queues a retry.
 */
@Injectable()
export class WorkflowExecutor
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Workflows');
  /** Each running run until its outcome is recorded, by run ID. */
  private readonly active = new Map<number, Promise<void>>();
  /** Workflows with a run in `active`, by name. */
  private readonly busyWorkflows = new Set<string>();
  /** Cancels each run in `active`, by run ID. */
  private readonly cancels = new Map<number, AbortController>();
  /** Runs the owner cancelled that have not recorded their outcome yet. */
  private readonly cancelRequested = new Set<number>();
  /** The latest pass over pending runs; passes run one at a time. */
  private pass: Promise<void> = Promise.resolve();
  /** A pass that has not begun yet, which later wakes share. */
  private queued: Promise<void> | null = null;
  private stopping = false;
  /** Stops every script still running once Pero is stopping. */
  private readonly stopScripts = new AbortController();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly agentManager: AgentManager,
    private readonly history: MessageHistory,
  ) {}

  /**
   * Records runs left `running` when Pero last stopped. Every module's
   * `onModuleInit` settles before any `onApplicationBootstrap`, so this
   * finishes before anything can claim a run.
   */
  onModuleInit(): Promise<void> {
    return this.recover();
  }

  /** Picks up runs left `pending` when Pero last stopped, and retries. */
  onApplicationBootstrap(): Promise<void> {
    return this.wake();
  }

  /**
   * Cancels a run this executor is running: aborts its turn, and
   * records it `cancelled` once the turn stops. False when the run is not
   * executing here, such as one that has just finished.
   */
  cancel(runId: number): boolean {
    const controller = this.cancels.get(runId);
    if (controller === undefined) return false;
    this.cancelRequested.add(runId);
    controller.abort();
    return true;
  }

  /**
   * Marks each run left `running` `interrupted`, since nothing runs it any
   * more, and queues a retry when its Workflow allows another attempt and
   * it and its Channel note are enabled. Each retry is a new run keyed by the one
   * it retries, so recovering twice queues it once, and it reads the same
   * history window.
   */
  async recover(): Promise<void> {
    const left = await this.dataSource.getRepository(WorkflowRun).find({
      select: { id: true },
      where: { status: 'running' },
      order: { id: 'ASC' },
    });
    for (const { id } of left) {
      if (this.active.has(id)) continue;
      try {
        await inTransaction(this.dataSource, (manager) =>
          this.recoverWithin(manager, id),
        );
      } catch (error) {
        this.logger.error(`Could not recover run ${id}: ${describe(error)}`);
      }
    }
  }

  private async recoverWithin(
    manager: EntityManager,
    id: number,
  ): Promise<void> {
    const run = await manager.getRepository(WorkflowRun).findOneBy({ id });
    if (run === null || run.status !== 'running') return;
    const name = run.workflowName;
    const { workflow, agent } = this.definitionsOf(name);
    let outcome: string;
    let retried = false;
    if (workflow === null) {
      outcome = `not retried: Workflow ${name} no longer exists`;
    } else if (run.attempt >= workflow.maxAttempts) {
      const attempts = `${workflow.maxAttempts} ${workflow.maxAttempts === 1 ? 'attempt' : 'attempts'}`;
      outcome = `not retried: Workflow ${workflow.name} allows ${attempts}`;
    } else if (!workflow.enabled) {
      outcome = `not retried: Workflow ${workflow.name} is disabled`;
    } else if (!agent!.enabled) {
      outcome = `not retried: Channel note ${agent!.name} is disabled`;
    } else {
      const retryId = await queueRetryWithin(manager, run);
      outcome = `run ${retryId} retries it (attempt ${run.attempt + 1} of ${workflow.maxAttempts})`;
      retried = true;
    }
    await finishRun(
      manager,
      run.id,
      workflow,
      { status: 'interrupted', errorText: `${INTERRUPTED}; ${outcome}` },
      { retried },
    );
    this.logger.warn(
      `Run ${run.id} of Workflow ${name} was interrupted; ${outcome}`,
    );
  }

  /**
   * The Workflow named `name` and the Channel note its runs use; null
   * while the Workflow is gone.
   */
  private definitionsOf(name: string): {
    workflow: ResolvedWorkflow | null;
    agent: ChannelNote | null;
  } {
    const workflow = this.definitions.workflow(name);
    const agent =
      workflow === null ? null : this.definitions.channelNote(workflow.note);
    return { workflow, agent };
  }

  /**
   * Starts pending runs while slots are free. Settles once they have
   * started, not finished.
   */
  wake(): Promise<void> {
    if (this.queued === null) {
      const next = this.pass
        .then(() => {
          this.queued = null;
          return this.fill();
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Could not start pending Workflow Runs: ${describe(error)}`,
          );
        });
      this.queued = next;
      this.pass = next;
    }
    return this.queued;
  }

  /** How many runs are executing now. */
  get running(): number {
    return this.active.size;
  }

  /** Settles once no run is executing and no pass is under way. */
  async idle(): Promise<void> {
    for (;;) {
      const pass = this.pass;
      await Promise.all([pass, ...this.active.values()]);
      if (this.pass === pass && this.active.size === 0) return;
    }
  }

  /**
   * Stops claiming runs, then lets running ones finish until the Agent
   * shutdown timeout aborts them, and records how each ended. Scripts are
   * stopped at once: a run's next attempt runs its script again.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.stopScripts.abort();
    await this.pass;
    await this.agentManager.drain();
    await Promise.all(this.active.values());
  }

  private async fill(): Promise<void> {
    while (!this.stopping) {
      const claimed = await inTransaction(this.dataSource, (manager) =>
        this.claimWithin(manager),
      );
      if (claimed === null) return;
      this.start(claimed);
    }
  }

  /**
   * Claims the oldest pending run of a Workflow with none running, if a
   * slot is free, and snapshots what it executes with, fixing its history
   * window. Retries go first, so a run queued before one reads after its
   * window. A run whose Workflow is gone, or whose Channel note was
   * disabled, since it was queued fails instead, as does one its schedule
   * queued once the Workflow is disabled.
   */
  private async claimWithin(
    manager: EntityManager,
  ): Promise<ClaimedRun | null> {
    // Read on every claim, so a changed limit applies without a restart.
    const defaults = this.definitions.defaults();
    const { maxConcurrentRuns, timezone } = defaults;
    if (this.stopping || this.active.size >= maxConcurrentRuns) return null;
    const runs = manager.getRepository(WorkflowRun);
    for (;;) {
      const query = runs
        .createQueryBuilder('run')
        .where('run.status = :status', { status: 'pending' });
      // In memory, not `running` rows: one left by a crash runs no longer.
      if (this.busyWorkflows.size > 0) {
        query.andWhere('run.workflowName NOT IN (:...busy)', {
          busy: [...this.busyWorkflows],
        });
      }
      const run = await query
        .orderBy('run.attempt', 'DESC')
        .addOrderBy('run.createdAt', 'ASC')
        .addOrderBy('run.id', 'ASC')
        .getOne();
      if (run === null) return null;
      const name = run.workflowName;
      const { workflow, agent } = this.definitionsOf(name);
      // A disabled Workflow still runs by hand.
      const paused =
        workflow !== null && !workflow.enabled && isScheduled(run.triggerKey);
      if (workflow === null || paused || agent === null || !agent.enabled) {
        const refused =
          workflow === null
            ? `Workflow ${name} no longer exists`
            : paused
              ? `Workflow ${name} was disabled before the run started`
              : `Channel note ${agent!.name} was disabled before the run started`;
        await finishRun(manager, run.id, workflow, {
          status: 'failed',
          errorText: refused,
        });
        this.logger.warn(`Run ${run.id} of Workflow ${name}: ${refused}`);
        continue;
      }
      const now = new Date();
      const history = await readHistoryWindow(manager, this.history, {
        workflow,
        inherited: run.executionConfig?.history,
        now,
        timeZone: timezone,
      });
      const snapshot = executionSnapshot(
        agent,
        this.agentManager.instructionDefaults(),
        history?.input ?? workflow.input,
        history?.read,
        workflow.script,
      );
      await runs.update(run.id, {
        status: 'running',
        startedAt: now,
        executionConfig: snapshot,
      });
      return {
        runId: run.id,
        workflow: workflow.name,
        snapshot,
      };
    }
  }

  private start(claimed: ClaimedRun): void {
    this.busyWorkflows.add(claimed.workflow);
    const controller = new AbortController();
    this.cancels.set(claimed.runId, controller);
    const done = this.execute(claimed, controller.signal)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not record the outcome of run ${claimed.runId}: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.active.delete(claimed.runId);
        this.cancels.delete(claimed.runId);
        this.cancelRequested.delete(claimed.runId);
        this.busyWorkflows.delete(claimed.workflow);
        void this.wake();
      });
    this.active.set(claimed.runId, done);
  }

  private async execute(
    claimed: ClaimedRun,
    signal: AbortSignal,
  ): Promise<void> {
    const { runId, workflow, snapshot } = claimed;
    const label = `Workflow ${workflow}, run ${runId}`;
    this.logger.log(`Run ${runId} of Workflow ${workflow} started`);
    let input = snapshot.input;
    let outcome: Outcome;
    try {
      const output =
        snapshot.script === undefined
          ? null
          : await runScript(snapshot.script, {
              cwd: snapshot.workingDirectory,
              env: { PERO_WORKFLOW: workflow, PERO_RUN_ID: String(runId) },
              signal: AbortSignal.any([signal, this.stopScripts.signal]),
              timeoutMs: SCRIPT_TIMEOUT_MS,
            });
      if (output !== null && isNoData(output)) {
        this.logger.log(
          `Run ${runId} of Workflow ${workflow}: its script found no data; no turn`,
        );
        outcome = {
          status: 'completed',
          text: NO_DATA,
          providerSessionId: null,
        };
      } else {
        if (output !== null) input = renderScriptInput(input, output);
        const { text, providerSessionId } = await this.agentManager.runIsolated(
          {
            note: snapshot.agentName,
            provider: snapshot.provider,
            request: snapshotRequest(snapshot),
            input,
            label,
            signal,
          },
        );
        outcome = { status: 'completed', text, providerSessionId };
      }
    } catch (error) {
      if (error instanceof ScriptError) {
        if (!error.aborted) this.logger.warn(`${label}: ${error.message}`);
      } else if (!(error instanceof TurnError)) {
        this.logger.error(`${label} failed: ${describe(error)}`);
      }
      // The owner's cancel wins over Pero stopping at the same time.
      outcome = this.cancelRequested.has(runId)
        ? { status: 'cancelled', error: CANCELLED }
        : (error instanceof TurnError && error.interrupted) ||
            (error instanceof ScriptError && error.aborted)
          ? { status: 'left' }
          : {
              status: 'failed',
              error:
                error instanceof TurnError || error instanceof ScriptError
                  ? error.message
                  : 'Pero failed to run it; see pero logs',
            };
    }
    if (outcome.status === 'left') {
      this.logger.warn(
        `Run ${runId} of Workflow ${workflow} stopped before it finished; the next start records it`,
      );
      return;
    }
    await inTransaction(this.dataSource, async (manager) =>
      // The Channels the Workflow notifies now, not when the run started.
      finishRun(manager, runId, this.definitions.workflow(workflow), {
        status: outcome.status,
        // What the turn was sent, with the script's output.
        ...(input === snapshot.input
          ? {}
          : { executionConfig: { ...snapshot, input } }),
        ...(outcome.status === 'completed'
          ? {
              result: {
                text: outcome.text,
                ...(outcome.providerSessionId === null
                  ? {}
                  : { providerSessionId: outcome.providerSessionId }),
              },
            }
          : { errorText: outcome.error }),
      }),
    );
    this.logger.log(`Run ${runId} of Workflow ${workflow} ${outcome.status}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
