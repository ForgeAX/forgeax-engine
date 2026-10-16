import type {
  ExecutionBootstrapEntry,
  ExecutionBootstrapValue,
  ExecutionBootstrapHost,
  Plugin,
} from '@forgeax/engine-app';
import {
  createIntelligencePortClient,
  type ActivityEvent,
  type ActivityRef,
  type IntelligencePortClient,
} from '@forgeax/engine-intelligence';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const M26_OUTPUT_LIMIT = 8;
const M26_LIMITS = {
  maxConcurrentActivities: 2,
  maxOutputChars: M26_OUTPUT_LIMIT,
  maxPendingEventsPerActivity: 32,
  maxPollEvents: 32,
} as const;

interface M26WorldProof {
  pendingText: string;
  exactLimitOutput: string;
  streamPartialText: string;
  streamPartialDeltaCount: number;
  streamPreTerminalMutationAttempts: number;
  streamFailedTerminalCount: number;
  streamLateDeltaEvents: number;
  streamLateCompletionEvents: number;
  streamFailure?: {
    readonly code: 'intelligence-output-overflow';
    readonly detail: {
      readonly activityId: ActivityRef['id'];
      readonly bound: 'output-chars';
      readonly limit: number;
    };
  };
  completionPreTerminalMutationAttempts: number;
  completionFailedTerminalCount: number;
  completionLateDeltaEvents: number;
  completionLateCompletionEvents: number;
  completionFailure?: {
    readonly code: 'intelligence-output-overflow';
    readonly detail: {
      readonly activityId: ActivityRef['id'];
      readonly bound: 'output-chars';
      readonly limit: number;
    };
  };
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
  authoritativeOutputs: string[];
  lateDeltaEvents: number;
}

type M26Phase =
  | 'initial'
  | 'await-initial'
  | 'cancel-pair'
  | 'await-late'
  | 'fresh'
  | 'exact-limit'
  | 'output-await'
  | 'output-late'
  | 'output-retry'
  | 'finished'
  | 'failed';

interface M26State {
  phase: M26Phase;
  frameCount: number;
  sibling?: ActivityRef;
  startFault?: ActivityRef;
  startRetry?: ActivityRef;
  cancelTarget?: ActivityRef;
  cancelSibling?: ActivityRef;
  fresh?: ActivityRef;
  exactLimit?: ActivityRef;
  streamOverflow?: ActivityRef;
  completionOverflow?: ActivityRef;
  outputSibling?: ActivityRef;
  streamRetry?: ActivityRef;
  siblingCompleted: boolean;
  retryCompleted: boolean;
  targetCancelled: boolean;
  cancelSiblingCompleted: boolean;
  freshCompleted: boolean;
  exactLimitCompleted: boolean;
  streamOverflowFailed: boolean;
  completionOverflowFailed: boolean;
  outputSiblingCompleted: boolean;
  streamRetryCompleted: boolean;
  outputLateWaitFrames: number;
  outputRetrySameSession: boolean;
  cancelAttempts: number;
  cancelRetryWaitFrames: number;
  lateWaitFrames: number;
  failedProviderEvents: number;
  failedProviderDetails: Array<{
    readonly activityId: string;
    readonly code: string;
    readonly providerId: string;
    readonly cause: string;
  }>;
  cancelledEvents: number;
  completedEvents: number;
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

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  const servicePlugin: Plugin = {
    name: 'm26-intelligence-port',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M26 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const client = createIntelligencePortClient('m26.host.deterministic', port, {
        limits: M26_LIMITS,
      });
      ctx.provide('intelligence', client);
      ctx.effect(
        () => () => client.close(),
        'm26/intelligence-service',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm26-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const intelligence = ctx.intelligence as IntelligencePortClient | undefined;
      if (intelligence === undefined) throw new Error('M26 intelligence service was not provided');

      const proof: M26WorldProof = {
        pendingText: '',
        exactLimitOutput: '',
        streamPartialText: '',
        streamPartialDeltaCount: 0,
        streamPreTerminalMutationAttempts: 0,
        streamFailedTerminalCount: 0,
        streamLateDeltaEvents: 0,
        streamLateCompletionEvents: 0,
        completionPreTerminalMutationAttempts: 0,
        completionFailedTerminalCount: 0,
        completionLateDeltaEvents: 0,
        completionLateCompletionEvents: 0,
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
        authoritativeOutputs: [],
        lateDeltaEvents: 0,
      };
      const state: M26State = {
        phase: 'initial',
        frameCount: 0,
        siblingCompleted: false,
        retryCompleted: false,
        targetCancelled: false,
        cancelSiblingCompleted: false,
        freshCompleted: false,
        exactLimitCompleted: false,
        streamOverflowFailed: false,
        completionOverflowFailed: false,
        outputSiblingCompleted: false,
        streamRetryCompleted: false,
        outputLateWaitFrames: 0,
        outputRetrySameSession: false,
        cancelAttempts: 0,
        cancelRetryWaitFrames: 0,
        lateWaitFrames: 0,
        failedProviderEvents: 0,
        failedProviderDetails: [],
        cancelledEvents: 0,
        completedEvents: 0,
        terminalCounts: new Map(),
      };
      world.insertResource('m26IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm26-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.phase === 'failed') return;
        state.phase = 'failed';
        state.failure = reason;
        post('worker-failure', { reason });
      };

      const submit = (
        input: string,
        session?: ActivityRef['session'],
      ): ActivityRef | undefined => {
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

      const recordTerminal = (event: ActivityEvent): boolean => {
        if (event.type === 'text-delta') return true;
        const id = String(event.activityId);
        const count = (state.terminalCounts.get(id) ?? 0) + 1;
        state.terminalCounts.set(id, count);
        if (count !== 1) {
          fail(`duplicate terminal event for ${id}`);
          return false;
        }
        if (event.type === 'completed') {
          state.completedEvents += 1;
          proof.acceptedTerminalCount += 1;
          proof.authoritativeMutationCount += 1;
          proof.authoritativeOutputs.push(event.output);
        } else if (event.type === 'cancelled') {
          state.cancelledEvents += 1;
        }
        return true;
      };

      const beginOutputPair = (): void => {
        if (state.streamOverflow !== undefined || state.phase === 'failed') return;
        const stream = submit('stream-output-overflow');
        const sibling = submit('output-sibling');
        if (stream === undefined || sibling === undefined) return;
        state.streamOverflow = stream;
        state.outputSibling = sibling;
        state.phase = 'output-await';
        post('stream-output-submitted', {
          streamActivityId: String(stream.id),
          siblingActivityId: String(sibling.id),
          providerId: stream.session.providerId,
          outputCharsLimit: M26_OUTPUT_LIMIT,
          pendingEventsLimit: M26_LIMITS.maxPendingEventsPerActivity,
          expectedStreamPartialText: '12345678',
          expectedStreamCrossingText: '!',
        });
      };

      const beginCompletionOverflow = (): void => {
        if (
          state.completionOverflow !== undefined ||
          state.streamOverflow === undefined ||
          state.phase === 'failed'
        ) {
          return;
        }
        const completion = submit('completion-output-overflow');
        if (completion === undefined) return;
        state.completionOverflow = completion;
        post('output-submitted', {
          streamActivityId: String(state.streamOverflow.id),
          completionActivityId: String(completion.id),
          siblingActivityId: String(state.outputSibling?.id),
          providerId: state.streamOverflow.session.providerId,
          outputCharsLimit: M26_OUTPUT_LIMIT,
          pendingEventsLimit: M26_LIMITS.maxPendingEventsPerActivity,
          expectedStreamPartialText: '12345678',
          expectedStreamCrossingText: '!',
          expectedCompletionLength: M26_OUTPUT_LIMIT + 1,
        });
      };

      const beginCancelPair = (): void => {
        if (state.cancelTarget !== undefined || state.phase === 'failed') return;
        const target = submit('late-cancel');
        const sibling = submit('cancel-sibling');
        if (target === undefined || sibling === undefined) return;
        state.cancelTarget = target;
        state.cancelSibling = sibling;
        state.phase = 'cancel-pair';
        post('cancel-pair-submitted', {
          targetActivityId: String(target.id),
          siblingActivityId: String(sibling.id),
        });
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const prematureMutation = proof.authoritativeOutputs.length !== proof.acceptedTerminalCount;
        const baseComplete =
          state.failure === undefined &&
          state.failedProviderEvents === 1 &&
          state.completedEvents === 7 &&
          state.cancelledEvents === 1 &&
          proof.preTerminalMutationAttempts > 0 &&
          proof.lateDeltaEvents === 0 &&
          state.cancelAttempts === 2 &&
          state.siblingCompleted &&
          state.retryCompleted &&
          state.targetCancelled &&
          state.cancelSiblingCompleted &&
          state.freshCompleted &&
          state.exactLimitCompleted &&
          state.streamOverflowFailed &&
          state.completionOverflowFailed &&
          state.outputSiblingCompleted &&
          state.streamRetryCompleted &&
          proof.streamPartialText === '12345678' &&
          proof.streamPartialDeltaCount === M26_OUTPUT_LIMIT &&
          proof.streamPreTerminalMutationAttempts === M26_OUTPUT_LIMIT &&
          proof.streamFailedTerminalCount === 1 &&
          proof.streamLateDeltaEvents === 0 &&
          proof.streamLateCompletionEvents === 0 &&
          proof.completionFailedTerminalCount === 1 &&
          proof.completionLateDeltaEvents === 0 &&
          proof.completionLateCompletionEvents === 0 &&
          proof.exactLimitOutput === '12345678' &&
          state.outputRetrySameSession;
        const complete = baseComplete && !prematureMutation;
        const falsifierCaught =
          falsify &&
          proof.prematureMutationCount === 1 &&
          proof.streamLateDeltaEvents === 0 &&
          proof.streamLateCompletionEvents === 0 &&
          proof.completionLateDeltaEvents === 0 &&
          proof.completionLateCompletionEvents === 0;
        const failedProviderDetails = [...state.failedProviderDetails];
        const terminalCounts = Object.fromEntries(state.terminalCounts);
        const proofSnapshot = {
          ...proof,
          authoritativeOutputs: [...proof.authoritativeOutputs],
        };
        const result = {
          ok: falsify ? false : complete,
          falsifierCaught,
          failure: state.failure ?? null,
          failedProviderEvents: state.failedProviderEvents,
          failedProviderDetails,
          completedEvents: state.completedEvents,
          cancelledEvents: state.cancelledEvents,
          outputLimit: M26_OUTPUT_LIMIT,
          pendingEventsLimit: M26_LIMITS.maxPendingEventsPerActivity,
          terminalCounts,
          closePromiseSame: true,
          proof: proofSnapshot,
        };
        state.phase = 'finished';
        post('worker-finished', result);
        const closeTask = intelligence.close();
        const closePromiseSame = intelligence.close() === closeTask;
        post('close-requested', { closePromiseSame });
      };

      const observe = (event: ActivityEvent): void => {
        if (!recordTerminal(event)) return;
        const id = String(event.activityId);
        if (event.type === 'text-delta') {
          const isStreamOverflow =
            state.streamOverflow !== undefined && id === String(state.streamOverflow.id);
          const isCompletionOverflow =
            state.completionOverflow !== undefined && id === String(state.completionOverflow.id);
          const isLateTarget = state.targetCancelled && id === String(state.cancelTarget?.id);
          if (isLateTarget) proof.lateDeltaEvents += 1;

          if (isStreamOverflow) {
            if (state.streamOverflowFailed) {
              proof.streamLateDeltaEvents += 1;
              fail('post-stream-overflow late delta reached the Worker consumer');
              return;
            }
            proof.streamPartialDeltaCount += 1;
            proof.streamPartialText += event.text;
            proof.streamPreTerminalMutationAttempts += 1;
          } else if (isCompletionOverflow && state.completionOverflowFailed) {
            proof.completionLateDeltaEvents += 1;
            fail('post-completion-overflow late delta reached the Worker consumer');
            return;
          }

          const authoritativeBefore = proof.authoritativeOutputs.length;
          proof.preTerminalMutationAttempts += 1;
          proof.pendingText += event.text;
          if (falsify && isStreamOverflow && proof.prematureMutationCount === 0) {
            proof.prematureMutationCount += 1;
            proof.authoritativeOutputs.push(`premature:${event.text}`);
          }
          if (proof.authoritativeOutputs.length < authoritativeBefore) {
            fail('pre-terminal World mutation lost authoritative state');
          }
          if (
            state.phase === 'cancel-pair' &&
            state.cancelTarget !== undefined &&
            id === String(state.cancelTarget.id) &&
            state.cancelAttempts === 0
          ) {
            const cancelled = intelligence.cancel(state.cancelTarget.id);
            if (!cancelled.ok) {
              fail(`cancel request rejected locally: ${cancelled.error.code}`);
              return;
            }
            state.cancelAttempts = 1;
            state.cancelRetryWaitFrames = 3;
            post('cancel-requested', { activityId: id, attempt: 1 });
          }
          return;
        }

        if (event.type === 'failed') {
          const isStreamOverflow =
            state.streamOverflow !== undefined && id === String(state.streamOverflow.id);
          const isCompletionOverflow =
            state.completionOverflow !== undefined && id === String(state.completionOverflow.id);
          if (isStreamOverflow || isCompletionOverflow) {
            if (event.error.code !== 'intelligence-output-overflow') {
              fail(`output overflow failure was not structured: ${event.error.code}`);
              return;
            }
            if (
              event.error.detail.bound !== 'output-chars' ||
              event.error.detail.limit !== M26_OUTPUT_LIMIT ||
              String(event.error.detail.activityId) !== id
            ) {
              fail('output overflow failure carried the wrong bound or limit');
              return;
            }
            const detail = {
              code: event.error.code,
              detail: event.error.detail,
            };
            if (isStreamOverflow) {
              proof.streamFailedTerminalCount += 1;
              proof.streamFailure = detail;
              state.streamOverflowFailed = true;
              post('stream-overflow-failed', {
                activityId: id,
                code: event.error.code,
                bound: event.error.detail.bound,
                limit: event.error.detail.limit,
              });
              beginCompletionOverflow();
            } else {
              proof.completionFailedTerminalCount += 1;
              proof.completionFailure = detail;
              state.completionOverflowFailed = true;
              post('completion-overflow-failed', {
                activityId: id,
                code: event.error.code,
                bound: event.error.detail.bound,
                limit: event.error.detail.limit,
              });
            }
            return;
          }
          if (id !== String(state.startFault?.id)) {
            fail(`unexpected failed activity ${id}: ${event.error.code}`);
            return;
          }
          if (event.error.code !== 'intelligence-provider-failed') {
            fail(`start failure was not structured: ${event.error.code}`);
            return;
          }
          state.failedProviderEvents += 1;
          state.failedProviderDetails.push({
            activityId: id,
            code: event.error.code,
            providerId: event.error.detail.providerId,
            cause: event.error.detail.cause,
          });
          if (state.failedProviderEvents !== 1 || state.startFault === undefined) {
            fail('provider start failure was duplicated');
            return;
          }
          const retry = submit('start-fault', state.startFault.session);
          if (retry === undefined) return;
          state.startRetry = retry;
          state.phase = 'await-initial';
          post('start-retried', {
            activityId: String(retry.id),
            sameSession: sameSession(state.startFault, retry),
          });
          return;
        }

        if (event.type === 'completed') {
          if (state.sibling !== undefined && id === String(state.sibling.id)) {
            state.siblingCompleted = true;
          } else if (state.startRetry !== undefined && id === String(state.startRetry.id)) {
            state.retryCompleted = true;
            if (state.startFault === undefined || !sameSession(state.startFault, state.startRetry)) {
              fail('retry did not preserve the provider-scoped SessionRef');
              return;
            }
          } else if (state.cancelSibling !== undefined && id === String(state.cancelSibling.id)) {
            state.cancelSiblingCompleted = true;
          } else if (state.fresh !== undefined && id === String(state.fresh.id)) {
            state.freshCompleted = true;
          } else if (state.exactLimit !== undefined && id === String(state.exactLimit.id)) {
            state.exactLimitCompleted = true;
            proof.exactLimitOutput = event.output;
          } else if (state.outputSibling !== undefined && id === String(state.outputSibling.id)) {
            state.outputSiblingCompleted = true;
          } else if (state.streamRetry !== undefined && id === String(state.streamRetry.id)) {
            state.streamRetryCompleted = true;
            if (state.streamOverflow === undefined || !sameSession(state.streamOverflow, state.streamRetry)) {
              fail('output retry did not retain the provider-scoped SessionRef');
              return;
            }
            state.outputRetrySameSession = true;
          } else {
            fail(`unexpected completed activity ${id}`);
          }
          return;
        }

        if (event.type === 'cancelled') {
          if (state.cancelTarget === undefined || id !== String(state.cancelTarget.id)) {
            fail(`unexpected cancelled activity ${id}`);
            return;
          }
          state.targetCancelled = true;
        }
      };

      const drive = (): void => {
        if (state.phase === 'failed') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const sibling = submit('sibling');
          const startFault = submit('start-fault');
          if (sibling === undefined || startFault === undefined) return;
          state.sibling = sibling;
          state.startFault = startFault;
          const capacity = intelligence.submit({ input: 'capacity-overflow' });
          if (capacity.ok || capacity.error.code !== 'intelligence-capacity-exceeded') {
            fail('capacity refusal was not reported at the Worker boundary');
            return;
          }
          state.phase = 'await-initial';
          post('initial-submitted', {
            siblingActivityId: String(sibling.id),
            startFaultActivityId: String(startFault.id),
            capacityError: capacity.error.code,
          });
          return;
        }
        if (
          state.phase === 'await-initial' &&
          state.siblingCompleted &&
          state.retryCompleted
        ) {
          beginCancelPair();
          return;
        }
        if (state.phase === 'cancel-pair') {
          if (state.cancelAttempts === 1) {
            if (state.cancelRetryWaitFrames > 0) {
              state.cancelRetryWaitFrames -= 1;
            } else if (state.cancelTarget !== undefined) {
              const retried = intelligence.cancel(state.cancelTarget.id);
              if (!retried.ok) {
                fail(`cancel retry rejected locally: ${retried.error.code}`);
                return;
              }
              state.cancelAttempts = 2;
              post('cancel-requested', {
                activityId: String(state.cancelTarget.id),
                attempt: 2,
              });
            }
          }
          if (state.targetCancelled && state.cancelSiblingCompleted) {
            state.phase = 'await-late';
            state.lateWaitFrames = 8;
          }
          return;
        }
        if (state.phase === 'await-late') {
          if (proof.lateDeltaEvents > 0) {
            fail('post-cancel late delta reached the Worker consumer');
            return;
          }
          if (state.lateWaitFrames > 0) {
            state.lateWaitFrames -= 1;
            return;
          }
          const fresh = submit('fresh');
          if (fresh === undefined) return;
          state.fresh = fresh;
          state.phase = 'fresh';
          post('fresh-submitted', { activityId: String(fresh.id) });
          return;
        }
        if (state.phase === 'fresh' && state.freshCompleted) {
          const exact = submit('exact-limit');
          if (exact === undefined) return;
          state.exactLimit = exact;
          state.phase = 'exact-limit';
          post('exact-limit-submitted', {
            activityId: String(exact.id),
            outputCharsLimit: M26_OUTPUT_LIMIT,
          });
          return;
        }
        if (state.phase === 'exact-limit' && state.exactLimitCompleted) {
          beginOutputPair();
          return;
        }
        if (
          state.phase === 'output-await' &&
          state.streamOverflowFailed &&
          state.completionOverflowFailed &&
          state.outputSiblingCompleted
        ) {
          state.phase = 'output-late';
          state.outputLateWaitFrames = 8;
          return;
        }
        if (state.phase === 'output-late') {
          if (
            proof.streamLateDeltaEvents > 0 ||
            proof.streamLateCompletionEvents > 0 ||
            proof.completionLateDeltaEvents > 0 ||
            proof.completionLateCompletionEvents > 0
          ) {
            fail('post-overflow provider output escaped the terminal boundary');
            return;
          }
          if (state.outputLateWaitFrames > 0) {
            state.outputLateWaitFrames -= 1;
            return;
          }
          if (state.streamOverflow === undefined) {
            fail('stream overflow ActivityRef was lost before retry');
            return;
          }
          const retry = submit('stream-output-retry', state.streamOverflow.session);
          if (retry === undefined) return;
          state.streamRetry = retry;
          state.outputRetrySameSession = sameSession(state.streamOverflow, retry);
          if (!state.outputRetrySameSession) {
            fail('output retry did not retain the provider-scoped SessionRef');
            return;
          }
          state.phase = 'output-retry';
          post('output-retried', {
            activityId: String(retry.id),
            sameSession: state.outputRetrySameSession,
          });
          return;
        }
        if (state.phase === 'output-retry' && state.streamRetryCompleted) finish();
      };

      const system = {
        name: 'm26-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of intelligence.poll()) observe(event);
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm26/intelligence-system',
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
      }, 'm26/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
