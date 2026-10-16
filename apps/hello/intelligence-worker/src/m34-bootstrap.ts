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
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligencePortClient,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  M34_LIMITS,
  M34_PROVIDER_A_ID,
  M34_PROVIDER_B_ID,
  M34_PROVIDER_C_ID,
} from './m34-provider';

interface M34HostCloseDetail {
  readonly origin: 'host-binding.close-after-client-command-fault';
  readonly pollOutstandingAtClose: number;
  readonly notificationAttempted: boolean;
  readonly notificationForwarded: boolean;
  readonly notificationSuppressed: boolean;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
}

interface M34ClientTrace {
  readonly commandKinds: string[];
  readonly postCloseCommands: string[];
  removeListenerCalls: number;
  physicalCloseCalls: number;
  closeCommandAttempts: number;
  closeCommandThrowInjected: boolean;
  closeOutcome: 'settled' | 'rejected' | null;
  closePromiseSame: boolean | null;
}

interface M34Probe {
  readonly normalClientState: boolean;
  readonly clientCloseOutcome: M34ClientTrace['closeOutcome'];
  readonly submitAfterClose: unknown;
  readonly cancelAfterClose: unknown;
  readonly pollAfterClose: readonly ActivityEvent[];
  readonly postCloseCommands: string[];
}

interface M34Proof {
  readonly pendingText: Record<string, string>;
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
}

type M34Phase =
  | 'wait-provider-b'
  | 'await-client-close'
  | 'await-host-close'
  | 'await-fresh-port'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M34State {
  phase: M34Phase;
  frameCount: number;
  survivor?: ActivityRef;
  closing?: ActivityRef;
  fresh?: ActivityRef;
  survivorCompleted: boolean;
  freshCompleted: boolean;
  closeAttempted: boolean;
  closeProbeDone: boolean;
  hostCloseObserved: boolean;
  postCloseProbe: boolean;
  probe?: M34Probe;
  failure?: string;
  falsifierReason?: string;
}

interface ClientPortOptions {
  readonly throwOnClose?: boolean;
  readonly postClose?: () => boolean;
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

function summarizeResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  if (value.ok === true) return { ok: true };
  const error = value.error;
  if (typeof error !== 'object' || error === null) return { ok: false, error: String(error) };
  const detail = error as { readonly code?: unknown; readonly detail?: unknown };
  return {
    ok: false,
    error: {
      code: typeof detail.code === 'string' ? detail.code : undefined,
      detail: detail.detail,
    },
  };
}

function summarizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let providerBPort: IntelligenceMessagePort | undefined;
  let providerBRawPort: MessagePort | undefined;
  let providerBClient: IntelligencePortClient | undefined;
  let providerCClient: IntelligencePortClient | undefined;
  let hostCloseDetail: M34HostCloseDetail | undefined;
  let state: M34State | undefined;
  const clientTraceA: M34ClientTrace = {
    commandKinds: [],
    postCloseCommands: [],
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closeCommandAttempts: 0,
    closeCommandThrowInjected: false,
    closeOutcome: null,
    closePromiseSame: null,
  };
  const clientTraceB: M34ClientTrace = {
    commandKinds: [],
    postCloseCommands: [],
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closeCommandAttempts: 0,
    closeCommandThrowInjected: false,
    closeOutcome: null,
    closePromiseSame: null,
  };
  const clientTraceC: M34ClientTrace = {
    commandKinds: [],
    postCloseCommands: [],
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closeCommandAttempts: 0,
    closeCommandThrowInjected: false,
    closeOutcome: null,
    closePromiseSame: null,
  };

  const post = (event: string, detail: Record<string, unknown> = {}): void => {
    evidencePort?.postMessage({ kind: 'm34-worker-event', event, detail });
  };

  const wrapClientPort = (
    port: MessagePort,
    trace: M34ClientTrace,
    options: ClientPortOptions = {},
  ): IntelligenceMessagePort => ({
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind.startsWith('intelligence-')) {
        const kind = message.kind;
        trace.commandKinds.push(kind);
        if (options.postClose?.() === true) trace.postCloseCommands.push(kind);
        if (kind === 'intelligence-close') {
          trace.closeCommandAttempts += 1;
          if (options.throwOnClose === true) {
            trace.closeCommandThrowInjected = true;
            throw new Error('M34 injected synchronous Worker client close command failure');
          }
        }
      }
      port.postMessage(message);
    },
    addEventListener(type, listener): void {
      port.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type, listener): void {
      trace.removeListenerCalls += 1;
      port.removeEventListener(type, listener as EventListener);
    },
    start(): void {
      port.start();
    },
    close(): void {
      trace.physicalCloseCalls += 1;
      port.close();
    },
  });

  const uncontainedClose = (port: IntelligenceMessagePort): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        port.postMessage({ kind: 'intelligence-close' });
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });

  const servicePlugin: Plugin = {
    name: 'm34-intelligence-ports',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M34 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
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
          readonly notificationSuppressed?: unknown;
          readonly hostCloseSettled?: unknown;
          readonly hostCloseRejected?: unknown;
          readonly physicalCloseCalls?: unknown;
        };
        if (value.kind === 'm34-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined) return;
          providerBRawPort = value.port;
          providerBPort = wrapClientPort(value.port, clientTraceB, {
            throwOnClose: true,
            postClose: () => state?.postCloseProbe === true,
          });
          providerBClient = createIntelligencePortClient(M34_PROVIDER_B_ID, providerBPort, {
            limits: M34_LIMITS,
            createActivityId: () => activityId(`m34-worker-b-${state?.frameCount ?? 0}`),
            createSessionId: () => `m34-worker-session-b-${state?.frameCount ?? 0}`,
          });
          return;
        }
        if (
          value.kind === 'm34-host-binding-closed' &&
          value.origin === 'host-binding.close-after-client-command-fault' &&
          typeof value.pollOutstandingAtClose === 'number' &&
          typeof value.notificationAttempted === 'boolean' &&
          typeof value.notificationForwarded === 'boolean' &&
          typeof value.notificationSuppressed === 'boolean' &&
          typeof value.hostCloseSettled === 'boolean' &&
          typeof value.hostCloseRejected === 'boolean' &&
          typeof value.physicalCloseCalls === 'number'
        ) {
          hostCloseDetail = {
            origin: value.origin,
            pollOutstandingAtClose: value.pollOutstandingAtClose,
            notificationAttempted: value.notificationAttempted,
            notificationForwarded: value.notificationForwarded,
            notificationSuppressed: value.notificationSuppressed,
            hostCloseSettled: value.hostCloseSettled,
            hostCloseRejected: value.hostCloseRejected,
            physicalCloseCalls: value.physicalCloseCalls,
          };
          if (state !== undefined) {
            state.hostCloseObserved = true;
            state.phase = 'await-fresh-port';
          }
          post('host-binding-closed-observed', { hostClose: hostCloseDetail });
          return;
        }
        if (value.kind === 'm34-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          const wrapped = wrapClientPort(value.port, clientTraceC);
          providerCClient = createIntelligencePortClient(M34_PROVIDER_C_ID, wrapped, {
            limits: M34_LIMITS,
            createActivityId: () => activityId(`m34-worker-c-${state?.frameCount ?? 0}`),
            createSessionId: () => `m34-worker-session-c-${state?.frameCount ?? 0}`,
          });
        }
      };
      port.addEventListener('message', setupListener);
      const clientA = createIntelligencePortClient(M34_PROVIDER_A_ID, wrapClientPort(port, clientTraceA), {
        limits: M34_LIMITS,
        createActivityId: () => activityId(`m34-worker-a-${state?.frameCount ?? 0}`),
        createSessionId: () => `m34-worker-session-a-${state?.frameCount ?? 0}`,
      });
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          return Promise.all(closes).then(() => undefined);
        },
        'm34/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm34-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M34 provider-A intelligence service was not provided');
      const proof: M34Proof = {
        pendingText: {},
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
      };
      const localState: M34State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        survivorCompleted: false,
        freshCompleted: false,
        closeAttempted: false,
        closeProbeDone: false,
        hostCloseObserved: false,
        postCloseProbe: false,
      };
      state = localState;
      world.insertResource('m34IntelligenceProof', proof);

      const fail = (reason: string): void => {
        if (localState.phase === 'finished' || localState.failure !== undefined) return;
        localState.failure = reason;
        localState.phase = 'failed';
        post('worker-failure', { reason });
      };

      const violation = (reason: string): void => {
        if (!falsify) {
          fail(reason);
          return;
        }
        if (localState.falsifierReason === undefined) {
          localState.falsifierReason = reason;
          post('falsifier-caught', { reason });
        }
      };

      const submit = (
        client: IntelligencePortClient,
        input: string,
        session?: ActivityRef['session'],
      ): ActivityRef | undefined => {
        const result = client.submit(session === undefined ? { input } : { input, session });
        if (!result.ok) {
          fail(`${input}: ${result.error.code}`);
          return undefined;
        }
        return result.value;
      };

      const recordPrimaryEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label =
          localState.survivor !== undefined && id === String(localState.survivor.id)
            ? 'survivor'
            : localState.fresh !== undefined && id === String(localState.fresh.id)
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
        if (label === 'survivor') localState.survivorCompleted = true;
        if (label === 'fresh') localState.freshCompleted = true;
      };

      const probeAfterClose = (): void => {
        if (localState.closeProbeDone || providerBClient === undefined || localState.closing === undefined) return;
        localState.postCloseProbe = true;
        if (falsify && providerBRawPort !== undefined) {
          // The counterfactual keeps the original poll credit open; release it locally so the
          // falsifier can also observe the client's next post-close poll publication.
          providerBRawPort.dispatchEvent(
            new MessageEvent('message', { data: { kind: 'intelligence-events', events: [] } }),
          );
        }
        const submitAfterClose = providerBClient.submit({ input: 'after-close' });
        const cancelAfterClose = providerBClient.cancel(localState.closing.id);
        const pollAfterClose = [...providerBClient.poll()];
        localState.postCloseProbe = false;
        const submitSummary = summarizeResult(submitAfterClose) as {
          readonly error?: { readonly code?: unknown };
        };
        const cancelSummary = summarizeResult(cancelAfterClose) as {
          readonly error?: { readonly code?: unknown };
        };
        const normalClientState =
          clientTraceB.closeOutcome === 'settled' &&
          clientTraceB.removeListenerCalls === 1 &&
          clientTraceB.physicalCloseCalls === 1 &&
          clientTraceB.postCloseCommands.length === 0 &&
          !submitAfterClose.ok &&
          !cancelAfterClose.ok &&
          submitSummary.error?.code === 'intelligence-closed' &&
          cancelSummary.error?.code === 'intelligence-closed' &&
          pollAfterClose.length === 0;
        const falsifierState =
          clientTraceB.closeOutcome === 'rejected' &&
          clientTraceB.removeListenerCalls === 0 &&
          clientTraceB.physicalCloseCalls === 0 &&
          clientTraceB.postCloseCommands.includes('intelligence-submit') &&
          clientTraceB.postCloseCommands.includes('intelligence-cancel') &&
          clientTraceB.postCloseCommands.includes('intelligence-poll');
        if (!falsify && !normalClientState) {
          fail('client close did not contain the synchronous command fault');
        }
        if (falsify && falsifierState) {
          localState.falsifierReason = 'uncontained client close left listener and physical port open';
          post('falsifier-caught', { reason: localState.falsifierReason });
        } else if (falsify) {
          fail('client close command falsifier did not expose the uncontained release fault');
        }
        localState.probe = {
          normalClientState,
          clientCloseOutcome: clientTraceB.closeOutcome,
          submitAfterClose: submitSummary,
          cancelAfterClose: cancelSummary,
          pollAfterClose,
          postCloseCommands: [...clientTraceB.postCloseCommands],
        };
        localState.closeProbeDone = true;
        post('client-close-probed', {
          normalClientState,
          clientTrace: { ...clientTraceB, postCloseCommands: [...clientTraceB.postCloseCommands] },
          submitAfterClose: submitSummary,
          cancelAfterClose: cancelSummary,
          pollAfterClose,
        });
        evidencePort?.postMessage({ kind: 'm34-fresh-port-request' });
        post('fresh-port-requested');
      };

      const finish = (): void => {
        if (localState.phase === 'finished') return;
        const survivor = localState.survivor;
        const fresh = localState.fresh;
        const normalComplete =
          localState.failure === undefined &&
          localState.falsifierReason === undefined &&
          hostCloseDetail?.origin === 'host-binding.close-after-client-command-fault' &&
          hostCloseDetail.pollOutstandingAtClose === 1 &&
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          !hostCloseDetail.notificationSuppressed &&
          localState.hostCloseObserved &&
          localState.closeProbeDone &&
          localState.survivorCompleted &&
          localState.freshCompleted &&
          survivor !== undefined &&
          fresh !== undefined &&
          proof.preTerminalMutationAttempts === 2 &&
          proof.prematureMutationCount === 0 &&
          proof.acceptedTerminalCount === 2 &&
          proof.authoritativeMutationCount === 2 &&
          proof.pendingText[String(survivor.id)] === 'survivor:' &&
          proof.pendingText[String(fresh.id)] === 'fresh:' &&
          proof.authoritativeOutputs[String(survivor.id)] === 'survivor-ok' &&
          proof.authoritativeOutputs[String(fresh.id)] === 'fresh-ok' &&
          localState.probe?.normalClientState === true;
        const result = {
          ok: falsify ? false : normalComplete,
          falsifierCaught: falsify && localState.falsifierReason !== undefined,
          failure: localState.failure ?? null,
          falsifierReason: localState.falsifierReason ?? null,
          clientTrace: {
            providerA: { ...clientTraceA, commandKinds: [...clientTraceA.commandKinds] },
            providerB: {
              ...clientTraceB,
              commandKinds: [...clientTraceB.commandKinds],
              postCloseCommands: [...clientTraceB.postCloseCommands],
            },
            providerC: { ...clientTraceC, commandKinds: [...clientTraceC.commandKinds] },
          },
          hostClose: hostCloseDetail ?? null,
          probe: localState.probe ?? null,
          frameCount: localState.frameCount,
          survivorId: survivor === undefined ? null : String(survivor.id),
          closingId: localState.closing === undefined ? null : String(localState.closing.id),
          freshId: fresh === undefined ? null : String(fresh.id),
          proof: {
            ...proof,
            pendingText: { ...proof.pendingText },
            perActivitySequences: Object.fromEntries(
              Object.entries(proof.perActivitySequences).map(([id, sequences]) => [id, [...sequences]]),
            ),
            authoritativeOutputs: { ...proof.authoritativeOutputs },
          },
        };
        localState.phase = 'finished';
        post('worker-finished', result);
        const closeA = clientA.close();
        const closeAAgain = clientA.close();
        clientTraceA.closePromiseSame = closeA === closeAAgain;
        const closeC = providerCClient?.close();
        const closeCAgain = providerCClient?.close();
        clientTraceC.closePromiseSame = closeC !== undefined && closeC === closeCAgain;
        post('cleanup-requested', {
          clientClosePromiseSame: {
            providerA: clientTraceA.closePromiseSame,
            providerC: clientTraceC.closePromiseSame,
          },
          providerBClientClose: falsify ? 'falsifier-uncontained' : 'settled-before-host-cleanup',
        });
        const closes = [closeA];
        if (closeC !== undefined) closes.push(closeC);
        void Promise.all(closes).then(
          () => post('clients-closed'),
          (cause: unknown) => post('client-close-failed', { cause: summarizeCause(cause) }),
        );
      };

      const drive = (): void => {
        if (localState.phase === 'finished') return;
        if (localState.failure !== undefined) {
          finish();
          return;
        }
        if (localState.phase === 'wait-provider-b' && providerBClient !== undefined) {
          const survivor = submit(clientA, 'survivor');
          const closing = submit(providerBClient, 'closing');
          if (survivor === undefined || closing === undefined) {
            fail('M34 initial activity roster did not admit the client close probe');
            return;
          }
          clientA.poll();
          providerBClient.poll();
          localState.survivor = survivor;
          localState.closing = closing;
          localState.phase = 'await-client-close';
          post('initial-submitted', {
            survivorId: String(survivor.id),
            closingId: String(closing.id),
            pollOutstandingExpected: 1,
          });
          return;
        }
        if (localState.phase === 'await-client-close' && !localState.closeAttempted) {
          localState.closeAttempted = true;
          localState.phase = 'await-host-close';
          const closeTask =
            falsify && providerBPort !== undefined
              ? uncontainedClose(providerBPort)
              : providerBClient?.close() ?? Promise.resolve();
          if (!falsify && providerBClient !== undefined) {
            const second = providerBClient.close();
            clientTraceB.closePromiseSame = closeTask === second;
          }
          void closeTask.then(
            () => {
              clientTraceB.closeOutcome = 'settled';
              post('client-close-settled', {
                clientTrace: { ...clientTraceB, postCloseCommands: [...clientTraceB.postCloseCommands] },
              });
            },
            (cause: unknown) => {
              clientTraceB.closeOutcome = 'rejected';
              post('client-close-rejected', {
                cause: summarizeCause(cause),
                clientTrace: { ...clientTraceB, postCloseCommands: [...clientTraceB.postCloseCommands] },
              });
            },
          );
          return;
        }
        if (
          localState.phase === 'await-fresh-port' &&
          localState.hostCloseObserved &&
          !localState.closeProbeDone
        ) {
          probeAfterClose();
          return;
        }
        if (localState.phase === 'await-fresh-port' && providerCClient !== undefined) {
          if (localState.closing === undefined) {
            fail('M34 fresh client arrived without the retained SessionRef');
            return;
          }
          const fresh = submit(providerCClient, 'fresh', localState.closing.session);
          if (fresh === undefined) return;
          localState.fresh = fresh;
          localState.phase = 'await-completions';
          providerCClient.poll();
          post('fresh-submitted', {
            freshId: String(fresh.id),
            retainedSession: localState.closing.session,
          });
          return;
        }
        if (
          localState.phase === 'await-completions' &&
          localState.survivorCompleted &&
          localState.freshCompleted &&
          localState.closeProbeDone
        ) {
          finish();
        }
      };

      const system = {
        name: 'm34-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (localState.phase === 'finished') return;
          localState.frameCount += 1;
          for (const event of clientA.poll()) recordPrimaryEvent(event);
          if (providerCClient !== undefined) {
            for (const event of providerCClient.poll()) recordPrimaryEvent(event);
          }
          if (localState.frameCount > 300 && localState.phase !== 'finished') {
            fail('M34 client close command recovery did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm34/intelligence-system',
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
      }, 'm34/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
