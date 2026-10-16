import type {
  ExecutionBootstrapEntry,
  ExecutionBootstrapHost,
  ExecutionBootstrapValue,
  Plugin,
} from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  activityId,
  createIntelligencePortClient,
  type ActivityEvent,
  type ActivityRef,
  type IntelligencePortClient,
} from '@forgeax/engine-intelligence';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const M29_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 2,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 8,
} as const;

interface M29Proof {
  pendingText: string;
  keepOutput: string;
  retryOutput: string;
  preTerminalMutationAttempts: number;
  acceptedTerminalCount: number;
  rejectionTerminalCount: number;
  authoritativeMutationCount: number;
  authoritativeOutputs: string[];
  rejection?: Record<string, unknown>;
  cancelAfterRejection?: Record<string, unknown>;
}

type M29Phase =
  | 'initial'
  | 'await-activities'
  | 'await-retry'
  | 'finished'
  | 'failed';

interface M29State {
  phase: M29Phase;
  frameCount: number;
  keep?: ActivityRef;
  rejected?: ActivityRef;
  retry?: ActivityRef;
  keepCompleted: boolean;
  rejectionSeen: boolean;
  retryCompleted: boolean;
  terminalCounts: Map<string, number>;
  failure?: string;
}

function isFalsifierRequested(data: ExecutionBootstrapValue | undefined): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { readonly falsify?: unknown }).falsify === true
  );
}

function sameSession(left: ActivityRef, right: ActivityRef): boolean {
  return (
    left.session.providerId === right.session.providerId && left.session.id === right.session.id
  );
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return { value: String(result) };
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  if (value.ok === true) return { ok: true };
  const error = value.error;
  if (typeof error !== 'object' || error === null) return { ok: false, error: String(error) };
  const structured = error as { readonly code?: unknown; readonly detail?: unknown };
  return {
    ok: false,
    error: {
      code: typeof structured.code === 'string' ? structured.code : undefined,
      detail: structured.detail,
    },
  };
}

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let activityIdentityCalls = 0;
  let sessionIdentityCalls = 0;

  const servicePlugin: Plugin = {
    name: 'm29-intelligence-port',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M29 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const client = createIntelligencePortClient('m29.host.rejection', port, {
        limits: M29_LIMITS,
        createActivityId: () => {
          activityIdentityCalls += 1;
          return activityId(`m29-worker-activity-${activityIdentityCalls}`);
        },
        createSessionId: () => {
          sessionIdentityCalls += 1;
          return `m29-worker-session-${sessionIdentityCalls}`;
        },
      });
      ctx.provide('intelligence', client);
      ctx.effect(
        () => () => client.close(),
        'm29/intelligence-service',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm29-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const intelligence = ctx.intelligence as IntelligencePortClient | undefined;
      if (intelligence === undefined) throw new Error('M29 intelligence service was not provided');

      const proof: M29Proof = {
        pendingText: '',
        keepOutput: '',
        retryOutput: '',
        preTerminalMutationAttempts: 0,
        acceptedTerminalCount: 0,
        rejectionTerminalCount: 0,
        authoritativeMutationCount: 0,
        authoritativeOutputs: [],
      };
      const state: M29State = {
        phase: 'initial',
        frameCount: 0,
        keepCompleted: false,
        rejectionSeen: false,
        retryCompleted: false,
        terminalCounts: new Map(),
      };
      world.insertResource('m29IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm29-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.phase === 'failed') return;
        state.phase = 'failed';
        state.failure = reason;
        post('worker-failure', { reason });
      };

      const submit = (input: string, session?: ActivityRef['session']): ActivityRef | undefined => {
        const result =
          session === undefined
            ? intelligence.submit({ input })
            : intelligence.submit({ input, session });
        if (!result.ok) {
          fail(`${input}: ${result.error.code}`);
          return undefined;
        }
        return result.value;
      };

      const terminalCount = (id: string): number => {
        const count = (state.terminalCounts.get(id) ?? 0) + 1;
        state.terminalCounts.set(id, count);
        return count;
      };

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        if (event.type === 'text-delta') {
          if (state.keep === undefined || id !== String(state.keep.id)) {
            fail(`unexpected text-delta activity ${id}`);
            return;
          }
          proof.preTerminalMutationAttempts += 1;
          proof.pendingText += event.text;
          return;
        }

        const count = terminalCount(id);
        if (count !== 1) {
          fail(`duplicate terminal event for ${id}`);
          return;
        }
        if (state.rejected !== undefined && id === String(state.rejected.id)) {
          if (event.type !== 'failed') {
            fail(`Host rejection activity ${id} produced ${event.type}`);
            return;
          }
          proof.rejectionTerminalCount += 1;
          const rejection = {
            code: event.error.code,
            detail: event.error.detail,
            activityId: id,
          };
          proof.rejection = rejection;
          state.rejectionSeen = true;
          const cancel = intelligence.cancel(state.rejected.id);
          proof.cancelAfterRejection = summarizeResult(cancel);
          post('host-rejection-observed', rejection);
          post('cancel-after-rejection', proof.cancelAfterRejection);
          if (cancel.ok) {
            fail('Host rejection did not release the Worker optimistic activity');
          }
          return;
        }

        if (event.type !== 'completed') {
          fail(`unexpected ${event.type} activity ${id}`);
          return;
        }
        if (state.keep !== undefined && id === String(state.keep.id)) {
          state.keepCompleted = true;
          proof.keepOutput = event.output;
          proof.acceptedTerminalCount += 1;
          proof.authoritativeMutationCount += 1;
          proof.authoritativeOutputs.push(event.output);
          post('keep-completed', { activityId: id, output: event.output });
          return;
        }
        if (state.retry !== undefined && id === String(state.retry.id)) {
          state.retryCompleted = true;
          proof.retryOutput = event.output;
          proof.acceptedTerminalCount += 1;
          proof.authoritativeMutationCount += 1;
          proof.authoritativeOutputs.push(event.output);
          post('retry-completed', { activityId: id, output: event.output });
          return;
        }
        fail(`unexpected completed activity ${id}`);
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const normalComplete =
          state.failure === undefined &&
          state.keepCompleted &&
          state.rejectionSeen &&
          state.retryCompleted &&
          state.keep !== undefined &&
          state.rejected !== undefined &&
          state.retry !== undefined &&
          sameSession(state.rejected, state.retry) &&
          proof.pendingText === 'keep:' &&
          proof.keepOutput === 'keep-ok' &&
          proof.retryOutput === 'retry-ok' &&
          proof.rejectionTerminalCount === 1 &&
          proof.rejection?.code === 'intelligence-capacity-exceeded' &&
          (proof.rejection.detail as { readonly limit?: unknown } | undefined)?.limit === 1 &&
          proof.cancelAfterRejection?.ok === false &&
          (proof.cancelAfterRejection.error as { readonly code?: unknown } | undefined)?.code ===
            'intelligence-activity-not-found' &&
          proof.authoritativeMutationCount === proof.acceptedTerminalCount;
        const falsifierCaught =
          falsify &&
          state.failure === undefined &&
          state.keepCompleted &&
          !state.rejectionSeen &&
          proof.keepOutput === 'keep-ok';
        const result = {
          ok: falsify ? false : normalComplete,
          falsifierCaught,
          failure: state.failure ?? null,
          activityIdentityCalls,
          sessionIdentityCalls,
          frameCount: state.frameCount,
          proof: {
            ...proof,
            authoritativeOutputs: [...proof.authoritativeOutputs],
          },
          sameSession:
            state.rejected !== undefined &&
            state.retry !== undefined &&
            sameSession(state.rejected, state.retry),
        };
        state.phase = 'finished';
        post('worker-finished', result);
        const closeTask = intelligence.close();
        post('close-requested', { closePromiseSame: intelligence.close() === closeTask });
        void closeTask.then(
          () => post('client-closed'),
          (cause: unknown) => post('client-close-failed', { cause: String(cause) }),
        );
      };

      const drive = (): void => {
        if (state.phase === 'failed') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const keep = submit('keep-live');
          const rejected = submit('host-reject');
          if (keep === undefined || rejected === undefined) return;
          state.keep = keep;
          state.rejected = rejected;
          state.phase = 'await-activities';
          post('initial-submitted', {
            keepActivityId: String(keep.id),
            rejectedActivityId: String(rejected.id),
            rejectedSession: rejected.session,
          });
          return;
        }
        if (state.phase === 'await-activities') {
          if (falsify && state.keepCompleted && !state.rejectionSeen) {
            finish();
            return;
          }
          if (state.keepCompleted && state.rejectionSeen && state.rejected !== undefined) {
            const retry = submit('retry', state.rejected.session);
            if (retry === undefined) return;
            state.retry = retry;
            state.phase = 'await-retry';
            post('retry-submitted', {
              activityId: String(retry.id),
              sameSession: sameSession(state.rejected, retry),
            });
          }
          return;
        }
        if (state.phase === 'await-retry' && state.retryCompleted) finish();
      };

      const system = {
        name: 'm29-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of intelligence.poll()) recordEvent(event);
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm29/intelligence-system',
      );

      const spawned = [
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: {} },
          )
          .unwrap(),
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 5] } },
            { component: Camera, data: { fov: 60, aspect: 16 / 9 } },
          )
          .unwrap(),
        world
          .spawn({
            component: DirectionalLight,
            data: { direction: [-0.4, -0.7, -1], color: [1, 1, 1], intensity: 1.2 },
          })
          .unwrap(),
      ];
      ctx.effect(() => {
        for (const entity of spawned.reverse()) world.despawn(entity);
      }, 'm29/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
