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
  type IntelligenceMessagePort,
  type IntelligencePortClient,
} from '@forgeax/engine-intelligence';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  M33_LIMITS,
  M33_PROVIDER_A_ID,
  M33_PROVIDER_B_ID,
  M33_PROVIDER_C_ID,
} from './m33-provider';

interface M33HostCloseDetail {
  readonly origin: 'host-binding.close';
  readonly pollOutstandingAtClose: number;
  readonly notificationAttempted: boolean;
  readonly notificationForwarded: boolean;
  readonly notificationThrowInjected: boolean;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
  readonly portCloseSuppressed: boolean;
}

interface M33BProbe {
  readonly noPostCloseHostEffects: boolean;
  readonly activityIdentityCallsBefore: number;
  readonly activityIdentityCallsAfter: number;
  readonly sessionIdentityCallsBefore: number;
  readonly sessionIdentityCallsAfter: number;
  readonly commandCountBefore: number;
  readonly commandCountAfter: number;
}

interface M33Proof {
  readonly pendingText: Record<string, string>;
  readonly receivedOrder: string[];
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
}

type M33Phase =
  | 'wait-provider-b'
  | 'await-host-close'
  | 'await-fresh-port'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M33State {
  phase: M33Phase;
  frameCount: number;
  survivor?: ActivityRef;
  closing?: ActivityRef;
  fresh?: ActivityRef;
  survivorCompleted: boolean;
  freshCompleted: boolean;
  freshRequested: boolean;
  bProbe?: M33BProbe;
  hostCloseObserved: boolean;
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

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let providerBPort: MessagePort | undefined;
  let providerBClient: IntelligencePortClient | undefined;
  let providerCPort: MessagePort | undefined;
  let providerCClient: IntelligencePortClient | undefined;
  let hostCloseDetail: M33HostCloseDetail | undefined;
  let activityIdentityCallsA = 0;
  let sessionIdentityCallsA = 0;
  let activityIdentityCallsB = 0;
  let sessionIdentityCallsB = 0;
  let activityIdentityCallsC = 0;
  let sessionIdentityCallsC = 0;
  const providerBCommands: string[] = [];

  const wrapPort = (port: MessagePort, commandTrace?: string[]): IntelligenceMessagePort => ({
    postMessage(message) {
      if (commandTrace !== undefined && message.kind.startsWith('intelligence-')) {
        commandTrace.push(message.kind);
      }
      port.postMessage(message);
    },
    addEventListener(type, listener) {
      port.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type, listener) {
      port.removeEventListener(type, listener as EventListener);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  });

  const servicePlugin: Plugin = {
    name: 'm33-intelligence-ports',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M33 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const clientA = createIntelligencePortClient(M33_PROVIDER_A_ID, port, {
        limits: M33_LIMITS,
        createActivityId: () => {
          activityIdentityCallsA += 1;
          return activityId(`m33-worker-a-${activityIdentityCallsA}`);
        },
        createSessionId: () => {
          sessionIdentityCallsA += 1;
          return `m33-worker-session-a-${sessionIdentityCallsA}`;
        },
      });
      const setupListener = (event: MessageEvent<unknown>): void => {
        const message = event.data;
        if (typeof message !== 'object' || message === null) return;
        const value = message as {
          readonly kind?: unknown;
          readonly port?: unknown;
          readonly origin?: unknown;
          readonly pollOutstandingAtClose?: unknown;
          readonly notificationAttempted?: unknown;
          readonly notificationForwarded?: unknown;
          readonly notificationThrowInjected?: unknown;
          readonly hostCloseSettled?: unknown;
          readonly hostCloseRejected?: unknown;
          readonly physicalCloseCalls?: unknown;
          readonly portCloseSuppressed?: unknown;
        };
        if (value.kind === 'm33-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined) return;
          providerBPort = value.port;
          providerBClient = createIntelligencePortClient(
            M33_PROVIDER_B_ID,
            wrapPort(value.port, providerBCommands),
            {
              limits: M33_LIMITS,
              createActivityId: () => {
                activityIdentityCallsB += 1;
                return activityId(`m33-worker-b-${activityIdentityCallsB}`);
              },
              createSessionId: () => {
                sessionIdentityCallsB += 1;
                return `m33-worker-session-b-${sessionIdentityCallsB}`;
              },
            },
          );
          return;
        }
        if (
          value.kind === 'm33-host-binding-closed' &&
          value.origin === 'host-binding.close' &&
          typeof value.pollOutstandingAtClose === 'number' &&
          typeof value.notificationAttempted === 'boolean' &&
          typeof value.notificationForwarded === 'boolean' &&
          typeof value.notificationThrowInjected === 'boolean' &&
          typeof value.hostCloseSettled === 'boolean' &&
          typeof value.hostCloseRejected === 'boolean' &&
          typeof value.physicalCloseCalls === 'number' &&
          typeof value.portCloseSuppressed === 'boolean'
        ) {
          hostCloseDetail = {
            origin: value.origin,
            pollOutstandingAtClose: value.pollOutstandingAtClose,
            notificationAttempted: value.notificationAttempted,
            notificationForwarded: value.notificationForwarded,
            notificationThrowInjected: value.notificationThrowInjected,
            hostCloseSettled: value.hostCloseSettled,
            hostCloseRejected: value.hostCloseRejected,
            physicalCloseCalls: value.physicalCloseCalls,
            portCloseSuppressed: value.portCloseSuppressed,
          };
          providerBPort?.postMessage({
            kind: 'intelligence-submit',
            submission: {
              id: activityId('m33-unauthorized-after-close'),
              session: { providerId: M33_PROVIDER_B_ID, id: 'm33-unauthorized-session' },
              input: 'unauthorized',
            },
          });
          providerBPort?.postMessage({
            kind: 'intelligence-cancel',
            activityId: activityId('m33-unauthorized-cancel'),
          });
          providerBPort?.postMessage({ kind: 'intelligence-poll', maxEvents: 1 });
          return;
        }
        if (value.kind === 'm33-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          providerCPort = value.port;
          providerCClient = createIntelligencePortClient(
            M33_PROVIDER_C_ID,
            wrapPort(value.port),
            {
              limits: M33_LIMITS,
              createActivityId: () => {
                activityIdentityCallsC += 1;
                return activityId(`m33-worker-c-${activityIdentityCallsC}`);
              },
              createSessionId: () => {
                sessionIdentityCallsC += 1;
                return `m33-worker-session-c-${sessionIdentityCallsC}`;
              },
            },
          );
        }
      };
      port.addEventListener('message', setupListener);
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          else providerCPort?.close();
          return Promise.all(closes).then(() => undefined);
        },
        'm33/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm33-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M33 provider-A intelligence service was not provided');
      const proof: M33Proof = {
        pendingText: {},
        receivedOrder: [],
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
      };
      const state: M33State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        survivorCompleted: false,
        freshCompleted: false,
        freshRequested: false,
        hostCloseObserved: false,
      };
      world.insertResource('m33IntelligenceProof', proof);

      const post = (event: string, detail: Record<string, unknown> = {}): void => {
        evidencePort?.postMessage({ kind: 'm33-worker-event', event, detail });
      };

      const fail = (reason: string): void => {
        if (state.phase === 'finished' || state.failure !== undefined) return;
        state.failure = reason;
        state.phase = 'failed';
        post('worker-failure', { reason });
      };

      const violation = (reason: string): void => {
        if (!falsify) {
          fail(reason);
          return;
        }
        if (state.falsifierReason !== undefined) return;
        state.falsifierReason = reason;
        post('falsifier-caught', { reason });
      };

      const submit = (client: IntelligencePortClient, input: string): ActivityRef | undefined => {
        const result = client.submit({ input });
        if (!result.ok) {
          fail(`${input}: ${result.error.code}`);
          return undefined;
        }
        return result.value;
      };

      const recordPrimaryEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label =
          state.survivor !== undefined && id === String(state.survivor.id)
            ? 'survivor'
            : state.fresh !== undefined && id === String(state.fresh.id)
              ? 'fresh'
              : undefined;
        if (label === undefined) {
          violation(`unexpected primary activity ${id}`);
          return;
        }
        const expectedSequence = (proof.perActivitySequences[id]?.at(-1) ?? 0) + 1;
        if (event.sequence !== expectedSequence) {
          violation(`${label} sequence expected ${expectedSequence} but received ${event.sequence}`);
          return;
        }
        (proof.perActivitySequences[id] ??= []).push(event.sequence);
        proof.receivedOrder.push(`${label}:${event.type}`);
        if (event.type === 'text-delta') {
          proof.preTerminalMutationAttempts += 1;
          proof.pendingText[id] = `${proof.pendingText[id] ?? ''}${event.text}`;
          return;
        }
        if (event.type !== 'completed') {
          violation(`${label} produced ${event.type} instead of completed`);
          return;
        }
        proof.acceptedTerminalCount += 1;
        proof.authoritativeMutationCount += 1;
        proof.authoritativeOutputs[id] = event.output;
        if (label === 'survivor') state.survivorCompleted = true;
        if (label === 'fresh') state.freshCompleted = true;
      };

      const finish = (): void => {
        if (state.phase === 'finished') return;
        const survivor = state.survivor;
        const closing = state.closing;
        const fresh = state.fresh;
        const probe = state.bProbe;
        const closeDetail = hostCloseDetail;
        const normalComplete =
          state.failure === undefined &&
          state.falsifierReason === undefined &&
          closeDetail?.origin === 'host-binding.close' &&
          closeDetail.pollOutstandingAtClose === 1 &&
          closeDetail.notificationAttempted &&
          !closeDetail.notificationForwarded &&
          closeDetail.notificationThrowInjected &&
          closeDetail.hostCloseSettled &&
          !closeDetail.hostCloseRejected &&
          closeDetail.physicalCloseCalls === 1 &&
          !closeDetail.portCloseSuppressed &&
          state.survivorCompleted &&
          state.freshCompleted &&
          survivor !== undefined &&
          closing !== undefined &&
          fresh !== undefined &&
          probe !== undefined &&
          probe.noPostCloseHostEffects &&
          proof.preTerminalMutationAttempts === 2 &&
          proof.prematureMutationCount === 0 &&
          proof.acceptedTerminalCount === 2 &&
          proof.authoritativeMutationCount === 2 &&
          proof.pendingText[String(survivor.id)] === 'survivor:' &&
          proof.pendingText[String(fresh.id)] === 'fresh:' &&
          proof.authoritativeOutputs[String(survivor.id)] === 'survivor-ok' &&
          proof.authoritativeOutputs[String(fresh.id)] === 'fresh-ok';
        const result = {
          ok: falsify ? false : normalComplete,
          falsifierCaught: falsify && state.falsifierReason !== undefined,
          failure: state.failure ?? null,
          falsifierReason: state.falsifierReason ?? null,
          activityIdentityCalls: {
            providerA: activityIdentityCallsA,
            providerB: activityIdentityCallsB,
            providerC: activityIdentityCallsC,
          },
          sessionIdentityCalls: {
            providerA: sessionIdentityCallsA,
            providerB: sessionIdentityCallsB,
            providerC: sessionIdentityCallsC,
          },
          frameCount: state.frameCount,
          hostClose: closeDetail ?? null,
          survivorId: survivor === undefined ? null : String(survivor.id),
          closingId: closing === undefined ? null : String(closing.id),
          freshId: fresh === undefined ? null : String(fresh.id),
          providerBCommands: [...providerBCommands],
          proof: {
            ...proof,
            pendingText: { ...proof.pendingText },
            receivedOrder: [...proof.receivedOrder],
            perActivitySequences: Object.fromEntries(
              Object.entries(proof.perActivitySequences).map(([id, sequences]) => [id, [...sequences]]),
            ),
            authoritativeOutputs: { ...proof.authoritativeOutputs },
          },
          bProbe: probe ?? null,
        };
        state.phase = 'finished';
        post('worker-finished', result);
        const closeA = clientA.close();
        const closeAAgain = clientA.close();
        const closeC = providerCClient?.close();
        const closeCAgain = providerCClient?.close();
        post('cleanup-requested', {
          clientClosePromiseSame: {
            providerA: closeA === closeAAgain,
            providerC: closeC !== undefined && closeC === closeCAgain,
          },
          providerBClientClose: 'not-requested-after-physical-host-release',
        });
        const closes = [closeA];
        if (closeC !== undefined) closes.push(closeC);
        void Promise.all(closes).then(
          () => post('clients-closed'),
          (cause: unknown) => post('client-close-failed', { cause: String(cause) }),
        );
      };

      const requestFreshPort = (): void => {
        if (state.freshRequested) return;
        state.freshRequested = true;
        evidencePort?.postMessage({ kind: 'm33-fresh-port-request' });
        post('fresh-port-requested');
      };

      const startCloseProbe = (): void => {
        if (state.bProbe !== undefined) return;
        const closing = state.closing;
        if (closing === undefined || hostCloseDetail === undefined) {
          fail('M33 Host close arrived without provider-B state');
          return;
        }
        const activityIdentityCallsBefore = activityIdentityCallsB;
        const sessionIdentityCallsBefore = sessionIdentityCallsB;
        const commandCountBefore = providerBCommands.length;
        const noPostCloseHostEffects =
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          !hostCloseDetail.portCloseSuppressed &&
          activityIdentityCallsB === activityIdentityCallsBefore &&
          sessionIdentityCallsB === sessionIdentityCallsBefore &&
          providerBCommands.length === commandCountBefore;
        state.bProbe = {
          noPostCloseHostEffects,
          activityIdentityCallsBefore,
          activityIdentityCallsAfter: activityIdentityCallsB,
          sessionIdentityCallsBefore,
          sessionIdentityCallsAfter: sessionIdentityCallsB,
          commandCountBefore,
          commandCountAfter: providerBCommands.length,
        };
        if (!noPostCloseHostEffects) {
          violation('synchronous Host notification failure prevented physical binding release');
        }
        state.hostCloseObserved = true;
        state.phase = 'await-fresh-port';
        requestFreshPort();
        post('host-close-probed', {
          noPostCloseHostEffects,
          activityIdentityCallsBefore,
          activityIdentityCallsAfter: activityIdentityCallsB,
          sessionIdentityCallsBefore,
          sessionIdentityCallsAfter: sessionIdentityCallsB,
          commandCountBefore,
          commandCountAfter: providerBCommands.length,
          hostClose: hostCloseDetail,
          closingId: String(closing.id),
        });
      };

      const drive = (): void => {
        if (state.phase === 'finished') return;
        if (state.failure !== undefined) {
          finish();
          return;
        }
        if (state.phase === 'wait-provider-b' && providerBClient !== undefined) {
          const survivor = submit(clientA, 'survivor');
          const closing = submit(providerBClient, 'closing');
          if (survivor === undefined || closing === undefined) {
            fail('M33 initial activity roster did not admit the live close probe');
            return;
          }
          clientA.poll();
          providerBClient.poll();
          state.survivor = survivor;
          state.closing = closing;
          state.phase = 'await-host-close';
          post('initial-submitted', {
            survivorId: String(survivor.id),
            closingId: String(closing.id),
            providerBCommandCount: providerBCommands.length,
          });
          return;
        }
        if (state.phase === 'await-host-close' && hostCloseDetail !== undefined) {
          startCloseProbe();
          return;
        }
        if (state.phase === 'await-fresh-port' && providerCClient !== undefined) {
          const fresh = submit(providerCClient, 'fresh');
          if (fresh === undefined) return;
          state.fresh = fresh;
          state.phase = 'await-completions';
          post('fresh-submitted', { freshId: String(fresh.id) });
          return;
        }
        if (
          state.phase === 'await-completions' &&
          state.survivorCompleted &&
          state.freshCompleted &&
          state.bProbe !== undefined
        ) {
          finish();
        }
      };

      const system = {
        name: 'm33-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (state.phase === 'finished') return;
          state.frameCount += 1;
          for (const event of clientA.poll()) recordPrimaryEvent(event);
          if (providerCClient !== undefined) {
            for (const event of providerCClient.poll()) recordPrimaryEvent(event);
          }
          if (state.frameCount > 300 && state.phase !== 'finished') {
            fail('M33 Host close notification recovery did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm33/intelligence-system',
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
      }, 'm33/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
