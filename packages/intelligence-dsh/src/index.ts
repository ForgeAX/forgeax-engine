import {
  DeepSeekHarness,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client';
import type {
  ActivityId,
  ActivitySink,
  ActivitySubmission,
  IntelligenceError,
  IntelligenceProvider,
} from '@forgeax/engine-intelligence';
import { IntelligenceError as IntelligenceErrorValue } from '@forgeax/engine-intelligence';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface DshLaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly disposeEofGraceMs?: number;
  readonly disposeGraceMs?: number;
}

export interface DshIntelligenceProviderOptions {
  readonly launch: DshLaunchOptions;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /** Test/integration seam; production uses the pinned SDK client. */
  readonly createHarness?: (options: DshHarnessOptions) => DshHarness;
}

export interface DshHarnessOptions {
  readonly launch: DshLaunchOptions;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface DshRunResult {
  readonly finalResponse: string;
}

export interface DshHarness {
  run(
    input: string,
    options: {
      readonly sessionId: string;
      readonly onNotification: (notification: DshNotification) => void;
    },
  ): Promise<DshRunResult>;
  close(): Promise<void>;
}

export interface DshNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface DshActivity {
  readonly harness: DshHarness;
  readonly sink: ActivitySink;
  task: Promise<void>;
  cancelRequested: boolean;
  closeTask?: Promise<void>;
}

function closeActivity(activity: DshActivity): Promise<void> {
  if (activity.closeTask !== undefined) return activity.closeTask;
  activity.closeTask = (async () => {
    try {
      await activity.harness.close();
    } catch {
      try {
        await activity.harness.close();
      } catch {
        return;
      }
    }
  })();
  return activity.closeTask;
}

function textDelta(notification: DshNotification): string | undefined {
  if (notification.method !== 'session.event') return undefined;
  const event = notification.params.event;
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  if (Reflect.get(event, 'type') !== 'assistant/chunk') return undefined;
  const data = Reflect.get(event, 'data');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const chunk = Reflect.get(data, 'chunk');
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return undefined;
  if (Reflect.get(chunk, 'type') !== 'text-delta') return undefined;
  const text = Reflect.get(chunk, 'text');
  return typeof text === 'string' ? text : undefined;
}

function defaultHarness(options: DshHarnessOptions): DshHarness {
  const launch = {
    command: options.launch.command,
    ...(options.launch.args === undefined ? {} : { args: [...options.launch.args] }),
    ...(options.launch.env === undefined ? {} : { env: { ...options.launch.env } }),
    ...(options.launch.cwd === undefined ? {} : { cwd: options.launch.cwd }),
    ...(options.launch.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.launch.requestTimeoutMs }),
    ...(options.launch.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.launch.shutdownTimeoutMs }),
    ...(options.launch.disposeEofGraceMs === undefined
      ? {}
      : { disposeEofGraceMs: options.launch.disposeEofGraceMs }),
    ...(options.launch.disposeGraceMs === undefined
      ? {}
      : { disposeGraceMs: options.launch.disposeGraceMs }),
  } satisfies HarnessClientOptions;
  return new DeepSeekHarness({
    launch,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
}

/**
 * Create a Host-only DSH provider. Each Activity owns one runtime process.
 * DSH 0.1 has process close but no wire-level turn cancel; process-per-Activity
 * preserves honest cancellation without terminating unrelated work.
 */
export function createDshIntelligenceProvider(
  options: DshIntelligenceProviderOptions,
): IntelligenceProvider {
  const activities = new Map<ActivityId, DshActivity>();
  const createHarness = options.createHarness ?? defaultHarness;
  let closed = false;

  const provider: IntelligenceProvider = {
    id: 'deepseek-harness',
    start(submission, sink): Result<void, IntelligenceError> {
      if (closed) {
        return err(new IntelligenceErrorValue({ code: 'intelligence-closed', detail: {} }));
      }
      let harness: DshHarness;
      try {
        harness = createHarness({
          launch: options.launch,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        });
      } catch (cause) {
        return err(
          new IntelligenceErrorValue({
            code: 'intelligence-provider-failed',
            detail: { providerId: provider.id, cause },
          }),
        );
      }
      const activity: DshActivity = {
        harness,
        sink,
        task: Promise.resolve(),
        cancelRequested: false,
      };
      activities.set(submission.id, activity);
      activity.task = runActivity(submission, activity);
      return ok(undefined);
    },
    cancel(id): Result<void, IntelligenceError> {
      const activity = activities.get(id);
      if (activity === undefined) {
        return err(
          new IntelligenceErrorValue({
            code: 'intelligence-activity-not-found',
            detail: { activityId: id },
          }),
        );
      }
      activity.cancelRequested = true;
      void closeActivity(activity);
      return ok(undefined);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const current = [...activities.values()];
      for (const activity of current) {
        activity.cancelRequested = true;
      }
      const closeTasks = current.map(closeActivity);
      await Promise.allSettled(current.map((activity) => activity.task));
      await Promise.allSettled(closeTasks);
      activities.clear();
    },
  };

  async function runActivity(submission: ActivitySubmission, activity: DshActivity): Promise<void> {
    try {
      const result = await activity.harness.run(submission.input, {
        sessionId: submission.session.id,
        onNotification(notification: HarnessNotification) {
          if (activity.cancelRequested) return;
          const delta = textDelta(notification);
          if (delta !== undefined) activity.sink.text(delta);
        },
      });
      await closeActivity(activity);
      if (activity.cancelRequested) activity.sink.cancelled();
      else activity.sink.complete(result.finalResponse);
    } catch (cause) {
      await closeActivity(activity);
      if (activity.cancelRequested) activity.sink.cancelled();
      else activity.sink.fail(cause);
    } finally {
      activities.delete(submission.id);
    }
  }

  return provider;
}

export { textDelta as extractDshTextDelta };
