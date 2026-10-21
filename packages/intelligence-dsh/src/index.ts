import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
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

export interface DshLaunchOptions extends Readonly<Omit<HarnessClientOptions, 'args' | 'env'>> {
  readonly args?: readonly string[];
  readonly env?: Readonly<NonNullable<HarnessClientOptions['env']>>;
}

export interface DshHarnessOptions extends Readonly<Omit<DeepSeekHarnessOptions, 'launch'>> {
  readonly launch: DshLaunchOptions;
}

export interface DshIntelligenceProviderOptions extends DshHarnessOptions {
  /** Test/integration seam; production uses the pinned SDK client. */
  readonly createHarness?: (options: DshHarnessOptions) => DshHarness;
}

export type DshRunResult = Readonly<
  Pick<Awaited<ReturnType<DeepSeekHarness['run']>>, 'finalResponse'>
>;

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

export type DshNotification = Readonly<HarnessNotification>;

interface DshActivity {
  readonly harness: DshHarness;
  readonly sink: ActivitySink;
  readonly task: Promise<void>;
  cancelRequested: boolean;
  closeTask?: Promise<void>;
}

function closeActivity(activity: DshActivity): Promise<void> {
  if (activity.closeTask !== undefined) return activity.closeTask;
  activity.closeTask = Promise.resolve().then(async () => {
    try {
      await activity.harness.close();
    } catch {
      try {
        await activity.harness.close();
      } catch {
        return;
      }
    }
  });
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
  const { args, env, ...launch } = options.launch;
  return new DeepSeekHarness({
    ...options,
    launch: {
      ...launch,
      ...(args === undefined ? {} : { args: [...args] }),
      ...(env === undefined ? {} : { env: { ...env } }),
    },
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
  let closeTask: Promise<void> | undefined;

  const provider: IntelligenceProvider = {
    id: 'deepseek-harness',
    start(submission, sink): Result<void, IntelligenceError> {
      if (closeTask !== undefined) {
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
        task: Promise.resolve().then(() => runActivity(submission, activity)),
        cancelRequested: false,
      };
      activities.set(submission.id, activity);
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
    close(): Promise<void> {
      if (closeTask !== undefined) return closeTask;
      const current = [...activities.values()];
      closeTask = Promise.resolve().then(async () => {
        const closeTasks = current.map(closeActivity);
        await Promise.allSettled(current.map((activity) => activity.task));
        await Promise.allSettled(closeTasks);
      });
      for (const activity of current) activity.cancelRequested = true;
      return closeTask;
    },
  };

  async function runActivity(submission: ActivitySubmission, activity: DshActivity): Promise<void> {
    try {
      if (activity.cancelRequested) {
        await closeActivity(activity);
        activity.sink.cancelled();
        return;
      }
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
      if (activities.get(submission.id) === activity) activities.delete(submission.id);
    }
  }

  return provider;
}

export { textDelta as extractDshTextDelta };
