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

const M31_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 2,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 1,
} as const;

interface M31Proof {
  readonly pendingText: Record<string, string>;
  readonly receivedOrder: string[];
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
  bothInitialActivitiesObservedBeforeFirstTerminal: boolean;
}

type M31Phase = 'initial' | 'await-initial' | 'await-after' | 'falsifier' | 'finished' | 'failed';

interface M31State {
  phase: M31Phase;
  frameCount: number;
  first?: ActivityRef;
  second?: ActivityRef;
  after?: ActivityRef;
  firstCompleted: boolean;
  secondCompleted: boolean;
  afterCompleted: boolean;
  terminalCounts: Map<string, number>;
  lastSequences: Map<string, number>;
  falsifierReason?: string;
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
    name: 'm31-intelligence-port',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M31 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const client = createIntelligencePortClient('m31.host.interleaved', port, {
        limits: M31_LIMITS,
        createActivityId: () => {
          activityIdentityCalls += 1;
          return activityId(`m31-worker-activity-${activityIdentityCalls}`);
        },
        createSessionId: () => {
          sessionIdentityCalls += 1;
          return `m31-worker-session-${sessionIdentityCalls}`;
        },
      });
      ctx.provide('intelligence', client);
      ctx.effect(
        () => () => client.close(),
        'm31/intelligence-service',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm31-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const intelligence = ctx.intelligence as IntelligencePortClient | undefined;
      if (intelligence === undefined) throw new Error('M31 intelligence service was not provided');

      const proof: M31Proof = {
        pendingText: {},
        receivedOrder: [],
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
        bothInitialActivitiesObservedBeforeFirstTerminal: false,
      };
      const state: M31State = {
        phase: 'initial',
        frameCount: 0,
        firstCompleted: false,
        secondCompleted: false,
        afterCompleted: false,
        terminalCounts: new Map(),
        lastSequences: new Map(),
      };
      world.insertResource('m31IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm31-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.phase === 'falsifier') return;
        state.phase = 'failed';
        state.failure = reason;
        post('worker-failure', { reason });
      };

      const falsifierViolation = (reason: string): void => {
        if (!falsify) {
          fail(reason);
          return;
        }
        if (state.falsifierReason !== undefined) return;
        state.falsifierReason = reason;
        state.phase = 'falsifier';
        post('falsifier-caught', { reason });
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

      const activityLabel = (id: string): 'first' | 'second' | 'after' | undefined => {
        if (state.first !== undefined && id === String(state.first.id)) return 'first';
        if (state.second !== undefined && id === String(state.second.id)) return 'second';
        if (state.after !== undefined && id === String(state.after.id)) return 'after';
        return undefined;
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const firstId = state.first === undefined ? undefined : String(state.first.id);
        const secondId = state.second === undefined ? undefined : String(state.second.id);
        const afterId = state.after === undefined ? undefined : String(state.after.id);
        const sequenceProof =
          firstId !== undefined &&
          secondId !== undefined &&
          afterId !== undefined &&
          JSON.stringify(proof.perActivitySequences[firstId]) === JSON.stringify([1, 2, 3]) &&
          JSON.stringify(proof.perActivitySequences[secondId]) === JSON.stringify([1, 2, 3]) &&
          JSON.stringify(proof.perActivitySequences[afterId]) === JSON.stringify([1]);
        const firstTerminalIndex = proof.receivedOrder.findIndex((item) => item === 'first:completed');
        const firstTextIndex = proof.receivedOrder.findIndex((item) => item === 'first:text-delta');
        const secondTextIndex = proof.receivedOrder.findIndex((item) => item === 'second:text-delta');
        proof.bothInitialActivitiesObservedBeforeFirstTerminal =
          firstTerminalIndex >= 0 &&
          firstTextIndex >= 0 &&
          secondTextIndex >= 0 &&
          firstTextIndex < firstTerminalIndex &&
          secondTextIndex < firstTerminalIndex;
        const normalComplete =
          state.failure === undefined &&
          state.falsifierReason === undefined &&
          state.firstCompleted &&
          state.secondCompleted &&
          state.afterCompleted &&
          sequenceProof &&
          proof.bothInitialActivitiesObservedBeforeFirstTerminal &&
          proof.preTerminalMutationAttempts === 4 &&
          proof.prematureMutationCount === 0 &&
          proof.acceptedTerminalCount === 3 &&
          proof.authoritativeMutationCount === 3 &&
          firstId !== undefined &&
          secondId !== undefined &&
          afterId !== undefined &&
          proof.authoritativeOutputs[firstId] === 'first-ok' &&
          proof.authoritativeOutputs[secondId] === 'second-ok' &&
          proof.authoritativeOutputs[afterId] === 'after-ok';
        const result = {
          ok: falsify ? false : normalComplete,
          falsifierCaught: falsify && state.falsifierReason !== undefined,
          failure: state.failure ?? null,
          falsifierReason: state.falsifierReason ?? null,
          activityIdentityCalls,
          sessionIdentityCalls,
          frameCount: state.frameCount,
          proof: {
            ...proof,
            pendingText: { ...proof.pendingText },
            receivedOrder: [...proof.receivedOrder],
            perActivitySequences: Object.fromEntries(
              Object.entries(proof.perActivitySequences).map(([id, sequences]) => [id, [...sequences]]),
            ),
            authoritativeOutputs: { ...proof.authoritativeOutputs },
          },
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

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label = activityLabel(id);
        if (label === undefined) {
          falsifierViolation(`unexpected activity ${id}`);
          return;
        }
        const expectedSequence = (state.lastSequences.get(id) ?? 0) + 1;
        if (event.sequence !== expectedSequence) {
          falsifierViolation(
            `${label} sequence expected ${expectedSequence} but received ${event.sequence}`,
          );
          return;
        }
        state.lastSequences.set(id, event.sequence);
        (proof.perActivitySequences[id] ??= []).push(event.sequence);
        proof.receivedOrder.push(`${label}:${event.type}`);
        if (event.type === 'text-delta') {
          proof.preTerminalMutationAttempts += 1;
          proof.pendingText[id] = `${proof.pendingText[id] ?? ''}${event.text}`;
          return;
        }

        const terminalCount = (state.terminalCounts.get(id) ?? 0) + 1;
        state.terminalCounts.set(id, terminalCount);
        if (terminalCount !== 1) {
          falsifierViolation(`duplicate terminal event for ${label}`);
          return;
        }
        if (event.type !== 'completed') {
          falsifierViolation(`${label} produced ${event.type} instead of completed`);
          return;
        }
        proof.acceptedTerminalCount += 1;
        proof.authoritativeMutationCount += 1;
        proof.authoritativeOutputs[id] = event.output;
        if (label === 'first') state.firstCompleted = true;
        if (label === 'second') state.secondCompleted = true;
        if (label === 'after') state.afterCompleted = true;
      };

      const drive = (): void => {
        if (state.phase === 'failed' || state.phase === 'falsifier') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const first = submit('first');
          const second = submit('second');
          if (first === undefined || second === undefined) return;
          state.first = first;
          state.second = second;
          state.phase = 'await-initial';
          post('initial-submitted', {
            firstActivityId: String(first.id),
            secondActivityId: String(second.id),
            maxPollEvents: M31_LIMITS.maxPollEvents,
          });
          return;
        }
        if (state.phase === 'await-initial' && state.firstCompleted && state.secondCompleted) {
          if (state.first === undefined) {
            fail('first ActivityRef disappeared before recovery');
            return;
          }
          const after = submit('after terminal', state.first.session);
          if (after === undefined) return;
          state.after = after;
          state.phase = 'await-after';
          post('recovery-submitted', {
            activityId: String(after.id),
            sameSession: after.session.id === state.first.session.id,
          });
          return;
        }
        if (state.phase === 'await-after' && state.afterCompleted) finish();
      };

      const system = {
        name: 'm31-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of intelligence.poll()) recordEvent(event);
          if (state.frameCount > 240 && state.phase !== 'finished') {
            fail('M31 backlog did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm31/intelligence-system',
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
      }, 'm31/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
