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
import { M30_LIMITS, M30_PROVIDER_A_ID, M30_PROVIDER_B_ID } from './m30-provider';

interface M30Proof {
  pendingA: string;
  pendingB: string;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  authoritativeMutationCount: number;
  authoritativeOutputs: Record<string, string>;
  mismatch?: {
    readonly code: string;
    readonly detail: unknown;
    readonly activityIdentityCalls: number;
    readonly sessionIdentityCalls: number;
    readonly authoritativeMutationCount: number;
  };
}

type M30Phase =
  | 'initial'
  | 'await-a-first'
  | 'await-b'
  | 'await-a-retry'
  | 'await-falsifier'
  | 'falsifier'
  | 'finished'
  | 'failed';

interface M30State {
  phase: M30Phase;
  frameCount: number;
  aFirst?: ActivityRef;
  bValid?: ActivityRef;
  aRetry?: ActivityRef;
  aFirstCompleted: boolean;
  bValidCompleted: boolean;
  aRetryCompleted: boolean;
  mismatchSeen: boolean;
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

function isMessagePort(value: unknown): value is MessagePort {
  if (typeof value !== 'object' || value === null) return false;
  const port = value as Partial<MessagePort>;
  return (
    typeof port.postMessage === 'function' &&
    typeof port.addEventListener === 'function' &&
    typeof port.close === 'function'
  );
}

function sameSession(left: ActivityRef, right: ActivityRef): boolean {
  return left.session.providerId === right.session.providerId && left.session.id === right.session.id;
}

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let providerBPort: MessagePort | undefined;
  let providerBClient: IntelligencePortClient | undefined;
  let activityIdentityCallsA = 0;
  let sessionIdentityCallsA = 0;
  let activityIdentityCallsB = 0;
  let sessionIdentityCallsB = 0;

  const servicePlugin: Plugin = {
    name: 'm30-intelligence-ports',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M30 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const clientA = createIntelligencePortClient(M30_PROVIDER_A_ID, port, {
        limits: M30_LIMITS,
        createActivityId: () => {
          activityIdentityCallsA += 1;
          return activityId(`m30-worker-a-${activityIdentityCallsA}`);
        },
        createSessionId: () => {
          sessionIdentityCallsA += 1;
          return `m30-worker-session-a-${sessionIdentityCallsA}`;
        },
      });
      const setupListener = (event: MessageEvent<unknown>): void => {
        const message = event.data;
        if (typeof message !== 'object' || message === null) return;
        const value = message as { readonly kind?: unknown; readonly port?: unknown };
        if (value.kind !== 'm30-provider-b-port' || !isMessagePort(value.port)) return;
        if (providerBClient !== undefined) return;
        providerBPort = value.port;
        providerBClient = createIntelligencePortClient(M30_PROVIDER_B_ID, value.port, {
          limits: M30_LIMITS,
          createActivityId: () => {
            activityIdentityCallsB += 1;
            return activityId(`m30-worker-b-${activityIdentityCallsB}`);
          },
          createSessionId: () => {
            sessionIdentityCallsB += 1;
            return `m30-worker-session-b-${sessionIdentityCallsB}`;
          },
        });
      };
      port.addEventListener('message', setupListener);
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerBClient !== undefined) closes.push(providerBClient.close());
          else providerBPort?.close();
          return Promise.all(closes).then(() => undefined);
        },
        'm30/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm30-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M30 provider-A intelligence service was not provided');

      const proof: M30Proof = {
        pendingA: '',
        pendingB: '',
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        authoritativeMutationCount: 0,
        authoritativeOutputs: {},
      };
      const state: M30State = {
        phase: 'initial',
        frameCount: 0,
        aFirstCompleted: false,
        bValidCompleted: false,
        aRetryCompleted: false,
        mismatchSeen: false,
        terminalCounts: new Map(),
        lastSequences: new Map(),
      };
      world.insertResource('m30IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm30-worker-event', event, detail });
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

      const submit = (
        client: IntelligencePortClient,
        input: string,
        session?: ActivityRef['session'],
      ): ActivityRef | undefined => {
        const result =
          session === undefined ? client.submit({ input }) : client.submit({ input, session });
        if (!result.ok) {
          fail(`${input}: ${result.error.code}`);
          return undefined;
        }
        return result.value;
      };

      const activityLabel = (id: string): 'a-first' | 'b-valid' | 'a-retry' | undefined => {
        if (state.aFirst !== undefined && id === String(state.aFirst.id)) return 'a-first';
        if (state.bValid !== undefined && id === String(state.bValid.id)) return 'b-valid';
        if (state.aRetry !== undefined && id === String(state.aRetry.id)) return 'a-retry';
        return undefined;
      };

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label = activityLabel(id);
        if (label === undefined) {
          falsifierViolation(`unexpected provider-B event for activity ${id}`);
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
        if (event.type === 'text-delta') {
          proof.preTerminalMutationAttempts += 1;
          if (label === 'a-first') proof.pendingA += event.text;
          if (label === 'b-valid') proof.pendingB += event.text;
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
        proof.authoritativeMutationCount += 1;
        proof.authoritativeOutputs[id] = event.output;
        if (label === 'a-first') state.aFirstCompleted = true;
        if (label === 'b-valid') state.bValidCompleted = true;
        if (label === 'a-retry') state.aRetryCompleted = true;
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const aFirst = state.aFirst;
        const bValid = state.bValid;
        const aRetry = state.aRetry;
        const normalComplete =
          state.failure === undefined &&
          state.falsifierReason === undefined &&
          state.mismatchSeen &&
          state.aFirstCompleted &&
          state.bValidCompleted &&
          state.aRetryCompleted &&
          aFirst !== undefined &&
          bValid !== undefined &&
          aRetry !== undefined &&
          sameSession(aFirst, aRetry) &&
          proof.pendingA === 'a:' &&
          proof.pendingB === 'b:' &&
          proof.mismatch?.code === 'intelligence-session-provider-mismatch' &&
          proof.mismatch.detail !== undefined &&
          proof.authoritativeMutationCount === 3 &&
          proof.authoritativeOutputs[String(aFirst.id)] === 'a-first-ok' &&
          proof.authoritativeOutputs[String(bValid.id)] === 'b-valid-ok' &&
          proof.authoritativeOutputs[String(aRetry.id)] === 'a-retry-ok';
        const result = {
          ok: falsify ? false : normalComplete,
          falsifierCaught: falsify && state.falsifierReason !== undefined,
          failure: state.failure ?? null,
          falsifierReason: state.falsifierReason ?? null,
          activityIdentityCalls: {
            providerA: activityIdentityCallsA,
            providerB: activityIdentityCallsB,
          },
          sessionIdentityCalls: {
            providerA: sessionIdentityCallsA,
            providerB: sessionIdentityCallsB,
          },
          frameCount: state.frameCount,
          proof: {
            ...proof,
            authoritativeOutputs: { ...proof.authoritativeOutputs },
          },
          sameSession: aFirst !== undefined && aRetry !== undefined && sameSession(aFirst, aRetry),
        };
        state.phase = 'finished';
        post('worker-finished', result);
        const closeA = clientA.close();
        const closeAAgain = clientA.close();
        const closeTasks = [closeA];
        let closeB: Promise<void> | undefined;
        let closeBAgain: Promise<void> | undefined;
        if (providerBClient !== undefined) {
          closeB = providerBClient.close();
          closeBAgain = providerBClient.close();
          closeTasks.push(closeB);
        }
        post('close-requested', {
          clientClosePromiseSame: {
            providerA: closeA === closeAAgain,
            providerB: closeB !== undefined && closeB === closeBAgain,
          },
        });
        void Promise.all(closeTasks).then(
          () => post('clients-closed'),
          (cause: unknown) => post('client-close-failed', { cause: String(cause) }),
        );
      };

      const drive = (): void => {
        if (state.phase === 'failed' || state.phase === 'falsifier') {
          finish();
          return;
        }
        if (state.phase === 'initial') {
          const first = submit(clientA, 'a-first');
          if (first === undefined) return;
          state.aFirst = first;
          state.phase = 'await-a-first';
          post('provider-a-submitted', {
            activityId: String(first.id),
            session: first.session,
          });
          return;
        }
        if (state.phase === 'await-a-first' && state.aFirstCompleted) {
          const aFirst = state.aFirst;
          const clientB = providerBClient;
          if (aFirst === undefined || clientB === undefined) return;
          const mismatch = clientB.submit({ input: 'b-mismatch', session: aFirst.session });
          if (mismatch.ok) {
            fail('provider-B accepted the provider-A SessionRef');
            return;
          }
          proof.mismatch = {
            code: mismatch.error.code,
            detail: mismatch.error.detail,
            activityIdentityCalls: activityIdentityCallsB,
            sessionIdentityCalls: sessionIdentityCallsB,
            authoritativeMutationCount: proof.authoritativeMutationCount,
          };
          state.mismatchSeen = true;
          post('provider-mismatch-rejected', {
            code: mismatch.error.code,
            detail: mismatch.error.detail,
            activityIdentityCalls: activityIdentityCallsB,
            sessionIdentityCalls: sessionIdentityCallsB,
            authoritativeMutationCount: proof.authoritativeMutationCount,
          });
          if (falsify) {
            if (providerBPort === undefined) {
              fail('M30 falsifier could not access provider-B MessagePort');
              return;
            }
            const rawActivityId = activityId('m30-falsifier-activity');
            providerBPort.postMessage({
              kind: 'intelligence-submit',
              submission: { id: rawActivityId, input: 'b-mismatch', session: aFirst.session },
            });
            post('falsifier-injected', {
              bypassedClientGuard: true,
              activityId: String(rawActivityId),
              session: aFirst.session,
            });
            state.phase = 'await-falsifier';
            return;
          }
          const valid = submit(clientB, 'b-valid');
          if (valid === undefined) return;
          state.bValid = valid;
          state.phase = 'await-b';
          post('provider-b-submitted', {
            activityId: String(valid.id),
            session: valid.session,
          });
          return;
        }
        if (state.phase === 'await-b' && state.bValidCompleted) {
          const aFirst = state.aFirst;
          if (aFirst === undefined) {
            fail('provider-A SessionRef disappeared before retry');
            return;
          }
          const retry = submit(clientA, 'a-retry', aFirst.session);
          if (retry === undefined) return;
          state.aRetry = retry;
          state.phase = 'await-a-retry';
          post('provider-a-retry-submitted', {
            activityId: String(retry.id),
            sameSession: sameSession(aFirst, retry),
          });
          return;
        }
        if (state.phase === 'await-a-retry' && state.aRetryCompleted) finish();
      };

      const system = {
        name: 'm30-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of clientA.poll()) recordEvent(event);
          if (
            providerBClient !== undefined &&
            state.phase !== 'initial' &&
            state.phase !== 'await-a-first'
          ) {
            for (const event of providerBClient.poll()) recordEvent(event);
          }
          if (state.frameCount > 240 && state.phase !== 'finished') {
            fail('M30 provider mismatch journey did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm30/intelligence-system',
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
      }, 'm30/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
