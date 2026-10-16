import type {
  ExecutionBootstrapEntry,
  ExecutionBootstrapHost,
  ExecutionBootstrapValue,
  Plugin,
} from '@forgeax/engine-app';
import {
  activityId,
  createIntelligencePortClient,
  type ActivityEvent,
  type ActivityRef,
  type IntelligencePortClient,
} from '@forgeax/engine-intelligence';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const M27_INPUT_LIMIT = 4;
const M27_LIMITS = {
  maxInputChars: M27_INPUT_LIMIT,
  maxOutputChars: 64,
  maxConcurrentActivities: 3,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 32,
} as const;

interface M27Proof {
  pendingText: string;
  exactOutput: string;
  siblingOutput: string;
  retryOutput: string;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
  authoritativeOutputs: string[];
}

type M27Phase = 'initial' | 'await-initial' | 'retry' | 'finished' | 'failed';

interface M27State {
  phase: M27Phase;
  frameCount: number;
  exact?: ActivityRef;
  sibling?: ActivityRef;
  retry?: ActivityRef;
  exactCompleted: boolean;
  siblingCompleted: boolean;
  retryCompleted: boolean;
  terminalCounts: Map<string, number>;
  completedEvents: number;
  failure?: string;
  emptyRejection?: Record<string, unknown>;
  overLimitRejection?: Record<string, unknown>;
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
  let activityIdentityCalls = 0;
  let sessionIdentityCalls = 0;

  const servicePlugin: Plugin = {
    name: 'm27-intelligence-port',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M27 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const client = createIntelligencePortClient('m27.host.deterministic', port, {
        limits: M27_LIMITS,
        createActivityId: () => {
          activityIdentityCalls += 1;
          return activityId(`m27-worker-activity-${activityIdentityCalls}`);
        },
        createSessionId: () => {
          sessionIdentityCalls += 1;
          return `m27-worker-session-${sessionIdentityCalls}`;
        },
      });
      ctx.provide('intelligence', client);
      ctx.effect(
        () => () => client.close(),
        'm27/intelligence-service',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm27-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const intelligence = ctx.intelligence as IntelligencePortClient | undefined;
      if (intelligence === undefined) throw new Error('M27 intelligence service was not provided');

      const proof: M27Proof = {
        pendingText: '',
        exactOutput: '',
        siblingOutput: '',
        retryOutput: '',
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
        authoritativeOutputs: [],
      };
      const state: M27State = {
        phase: 'initial',
        frameCount: 0,
        exactCompleted: false,
        siblingCompleted: false,
        retryCompleted: false,
        terminalCounts: new Map(),
        completedEvents: 0,
      };
      world.insertResource('m27IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm27-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.phase === 'failed') return;
        state.phase = 'failed';
        state.failure = reason;
        post('worker-failure', { reason });
      };

      const summarizeRejection = (
        result: ReturnType<IntelligencePortClient['submit']>,
      ): Record<string, unknown> => {
        if (result.ok) {
          return { ok: true, activityId: String(result.value.id) };
        }
        return { ok: false, code: result.error.code, detail: result.error.detail };
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

      const recordTerminal = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        if (event.type === 'text-delta') {
          const isSibling = state.sibling !== undefined && id === String(state.sibling.id);
          if (!isSibling) {
            fail(`unexpected text-delta activity ${id}`);
            return;
          }
          proof.preTerminalMutationAttempts += 1;
          proof.pendingText += event.text;
          if (falsify && proof.prematureMutationCount === 0) {
            proof.prematureMutationCount = 1;
            proof.authoritativeOutputs.push(`premature:${event.text}`);
          }
          return;
        }

        const count = (state.terminalCounts.get(id) ?? 0) + 1;
        state.terminalCounts.set(id, count);
        if (count !== 1) {
          fail(`duplicate terminal event for ${id}`);
          return;
        }
        if (event.type === 'completed') {
          state.completedEvents += 1;
          proof.acceptedTerminalCount += 1;
          proof.authoritativeMutationCount += 1;
          proof.authoritativeOutputs.push(event.output);
          if (state.exact !== undefined && id === String(state.exact.id)) {
            state.exactCompleted = true;
            proof.exactOutput = event.output;
          } else if (state.sibling !== undefined && id === String(state.sibling.id)) {
            state.siblingCompleted = true;
            proof.siblingOutput = event.output;
          } else if (state.retry !== undefined && id === String(state.retry.id)) {
            state.retryCompleted = true;
            proof.retryOutput = event.output;
          } else {
            fail(`unexpected completed activity ${id}`);
          }
          return;
        }
        fail(`unexpected ${event.type} activity ${id}`);
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const invalidInputsCorrect =
          state.emptyRejection?.ok === false &&
          state.emptyRejection.code === 'intelligence-invalid-request' &&
          (state.emptyRejection.detail as { readonly field?: unknown } | undefined)?.field ===
            'input' &&
          state.overLimitRejection?.ok === false &&
          state.overLimitRejection.code === 'intelligence-invalid-request' &&
          (state.overLimitRejection.detail as { readonly field?: unknown } | undefined)?.field ===
            'input';
        const baseComplete =
          state.failure === undefined &&
          invalidInputsCorrect &&
          state.exactCompleted &&
          state.siblingCompleted &&
          state.retryCompleted &&
          state.completedEvents === 3 &&
          state.exact !== undefined &&
          state.retry !== undefined &&
          sameSession(state.exact, state.retry) &&
          proof.exactOutput === 'abcd' &&
          proof.siblingOutput === 'sibling-ok' &&
          proof.retryOutput === 'retry-ok' &&
          proof.preTerminalMutationAttempts > 0;
        const prematureMutation = proof.authoritativeOutputs.length !== proof.acceptedTerminalCount;
        const complete = baseComplete && !prematureMutation;
        const falsifierCaught =
          falsify &&
          baseComplete &&
          proof.prematureMutationCount === 1 &&
          prematureMutation;
        const result = {
          ok: falsify ? false : complete,
          falsifierCaught,
          failure: state.failure ?? null,
          inputLimit: M27_INPUT_LIMIT,
          invalidRequests: {
            empty: state.emptyRejection ?? null,
            overLimit: state.overLimitRejection ?? null,
          },
          activityIdentityCalls,
          sessionIdentityCalls,
          completedEvents: state.completedEvents,
          terminalCounts: Object.fromEntries(state.terminalCounts),
          proof: {
            ...proof,
            authoritativeOutputs: [...proof.authoritativeOutputs],
          },
        };
        state.phase = 'finished';
        post('worker-finished', result);
        const closeTask = intelligence.close();
        post('close-requested', { closePromiseSame: intelligence.close() === closeTask });
      };

      const drive = (): void => {
        if (state.phase === 'failed') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const exact = submit('abcd');
          const sibling = submit('sib');
          if (exact === undefined || sibling === undefined) return;
          state.exact = exact;
          state.sibling = sibling;
          const empty = intelligence.submit({ input: '' });
          const overLimit = intelligence.submit({ input: 'abcde' });
          state.emptyRejection = summarizeRejection(empty);
          state.overLimitRejection = summarizeRejection(overLimit);
          if (empty.ok || overLimit.ok) {
            fail('invalid input was accepted by the Worker client');
            return;
          }
          state.phase = 'await-initial';
          post('initial-submitted', {
            exactActivityId: String(exact.id),
            siblingActivityId: String(sibling.id),
            inputLimit: M27_INPUT_LIMIT,
            empty: state.emptyRejection,
            overLimit: state.overLimitRejection,
            activityIdentityCalls,
            sessionIdentityCalls,
          });
          return;
        }
        if (
          state.phase === 'await-initial' &&
          state.exactCompleted &&
          state.siblingCompleted &&
          state.exact !== undefined
        ) {
          const retry = submit('rtry', state.exact.session);
          if (retry === undefined) return;
          state.retry = retry;
          if (!sameSession(state.exact, retry)) {
            fail('valid retry did not retain the provider-scoped SessionRef');
            return;
          }
          state.phase = 'retry';
          post('retry-submitted', {
            activityId: String(retry.id),
            sameSession: true,
          });
          return;
        }
        if (state.phase === 'retry' && state.retryCompleted) finish();
      };

      const system = {
        name: 'm27-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of intelligence.poll()) recordTerminal(event);
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm27/intelligence-system',
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
      }, 'm27/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
