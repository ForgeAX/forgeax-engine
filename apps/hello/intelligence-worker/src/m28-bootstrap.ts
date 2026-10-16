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

const M28_LIMITS = {
  maxInputChars: 64,
  maxOutputChars: 128,
  maxConcurrentActivities: 2,
  maxPendingEventsPerActivity: 16,
  maxPollEvents: 16,
} as const;

interface M28Proof {
  pendingText: string;
  terminalOutput: string;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
  authoritativeOutputs: string[];
}

type M28Phase = 'initial' | 'await-terminal' | 'hold-submitted' | 'finished' | 'failed';

interface M28State {
  phase: M28Phase;
  frameCount: number;
  terminal?: ActivityRef;
  hold?: ActivityRef;
  terminalCompleted: boolean;
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

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let activityIdentityCalls = 0;
  let sessionIdentityCalls = 0;

  const servicePlugin: Plugin = {
    name: 'm28-intelligence-port',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M28 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const client = createIntelligencePortClient('m28.host.close-rejection', port, {
        limits: M28_LIMITS,
        createActivityId: () => {
          activityIdentityCalls += 1;
          return activityId(`m28-worker-activity-${activityIdentityCalls}`);
        },
        createSessionId: () => {
          sessionIdentityCalls += 1;
          return `m28-worker-session-${sessionIdentityCalls}`;
        },
      });
      ctx.provide('intelligence', client);
      ctx.effect(
        () => () => client.close(),
        'm28/intelligence-service',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm28-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const intelligence = ctx.intelligence as IntelligencePortClient | undefined;
      if (intelligence === undefined) throw new Error('M28 intelligence service was not provided');

      const proof: M28Proof = {
        pendingText: '',
        terminalOutput: '',
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
        authoritativeOutputs: [],
      };
      const state: M28State = {
        phase: 'initial',
        frameCount: 0,
        terminalCompleted: false,
      };
      world.insertResource('m28IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm28-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.phase === 'failed') return;
        state.phase = 'failed';
        state.failure = reason;
      };

      const submit = (input: string): ActivityRef | undefined => {
        const result = intelligence.submit({ input });
        if (!result.ok) {
          fail(`${input}: ${result.error.code}`);
          return undefined;
        }
        return result.value;
      };

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        if (event.type === 'text-delta') {
          if (state.terminal === undefined || id !== String(state.terminal.id)) {
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
        if (event.type !== 'completed') {
          fail(`unexpected ${event.type} activity ${id}`);
          return;
        }
        if (state.terminal === undefined || id !== String(state.terminal.id)) {
          fail(`unexpected completed activity ${id}`);
          return;
        }
        proof.acceptedTerminalCount += 1;
        proof.authoritativeMutationCount += 1;
        proof.authoritativeOutputs.push(event.output);
        proof.terminalOutput = event.output;
        state.terminalCompleted = true;
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const prematureMutation = proof.authoritativeOutputs.length !== proof.acceptedTerminalCount;
        const baseComplete =
          state.failure === undefined &&
          state.terminalCompleted &&
          state.hold !== undefined &&
          proof.terminalOutput === 'terminal-ok' &&
          proof.pendingText === 'pending:' &&
          proof.preTerminalMutationAttempts > 0;
        const complete = baseComplete && !prematureMutation;
        const falsifierCaught =
          falsify && baseComplete && proof.prematureMutationCount === 1 && prematureMutation;
        const result = {
          ok: falsify ? false : complete,
          falsifierCaught,
          failure: state.failure ?? null,
          activityIdentityCalls,
          sessionIdentityCalls,
          frameCount: state.frameCount,
          proof: {
            ...proof,
            authoritativeOutputs: [...proof.authoritativeOutputs],
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

      const drive = (): void => {
        if (state.phase === 'failed') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const terminal = submit('terminal');
          if (terminal === undefined) return;
          state.terminal = terminal;
          state.phase = 'await-terminal';
          post('terminal-submitted', { activityId: String(terminal.id) });
          return;
        }
        if (state.phase === 'await-terminal' && state.terminalCompleted) {
          const hold = submit('hold-open');
          if (hold === undefined) return;
          state.hold = hold;
          state.phase = 'hold-submitted';
          post('hold-submitted', { activityId: String(hold.id) });
          finish();
        }
      };

      const system = {
        name: 'm28-intelligence-worker-consumer',
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
        'm28/intelligence-system',
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
      }, 'm28/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
