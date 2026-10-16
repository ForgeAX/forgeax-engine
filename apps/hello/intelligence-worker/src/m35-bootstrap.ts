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
  type ActivityId,
  type ActivityRef,
  type ActivitySubmission,
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligencePortClient,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  M35_LIMITS,
  M35_PROVIDER_A_ID,
  M35_PROVIDER_B_ID,
  M35_PROVIDER_C_ID,
} from './m35-provider';

interface M35HostCloseDetail {
  readonly origin: 'host-binding.after-submit-command-fault';
  readonly pollOutstandingAtClose: number;
  readonly notificationAttempted: boolean;
  readonly notificationForwarded: boolean;
  readonly notificationSuppressed: boolean;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
}

interface M35ClientTrace {
  readonly commandKinds: string[];
  readonly postFaultCommands: string[];
  activityIdentityCalls: number;
  sessionIdentityCalls: number;
  faultSubmitAttempts: number;
  faultThrowInjected: boolean;
  faultOutcome: 'closed' | 'threw' | 'ok' | null;
  faultResult: unknown;
  removeListenerCalls: number;
  physicalCloseCalls: number;
  closePromiseSame: boolean | null;
}

interface M35FaultProbe {
  readonly normalClientState: boolean;
  readonly falsifierState: boolean;
  readonly submitAfterFault: unknown;
  readonly cancelAfterFault: unknown;
  readonly pollAfterFault: readonly ActivityEvent[];
  readonly activityIdentityCallsBefore: number;
  readonly activityIdentityCallsAfter: number;
  readonly sessionIdentityCallsBefore: number;
  readonly sessionIdentityCallsAfter: number;
  readonly commandCountBefore: number;
  readonly commandCountAfter: number;
  readonly uncontainedActiveCount: number;
}

interface M35Proof {
  readonly pendingText: Record<string, string>;
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
}

type M35Phase =
  | 'wait-provider-b'
  | 'await-control'
  | 'await-closing'
  | 'await-host-close'
  | 'await-fault-probe'
  | 'await-fresh-port'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M35State {
  phase: M35Phase;
  frameCount: number;
  survivor?: ActivityRef;
  control?: ActivityRef;
  closing?: ActivityRef;
  fresh?: ActivityRef;
  retainedSession?: ActivityRef['session'];
  survivorCompleted: boolean;
  controlCompleted: boolean;
  freshCompleted: boolean;
  closingTextObserved: boolean;
  faultAttempted: boolean;
  hostCloseObserved: boolean;
  faultProbeDone: boolean;
  postFaultProbe: boolean;
  probe?: M35FaultProbe;
  failure?: string;
  falsifierReason?: string;
}

interface ClientPortOptions {
  readonly throwOnFault?: boolean;
  readonly postFault?: () => boolean;
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
  let hostCloseDetail: M35HostCloseDetail | undefined;
  let state: M35State | undefined;
  let proof: M35Proof | undefined;
  const uncontainedActiveIds = new Set<ActivityId>();
  const clientTraceA: M35ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultSubmitAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceB: M35ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultSubmitAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceC: M35ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultSubmitAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };

  const post = (event: string, detail: Record<string, unknown> = {}): void => {
    evidencePort?.postMessage({ kind: 'm35-worker-event', event, detail });
  };

  const wrapClientPort = (
    port: MessagePort,
    trace: M35ClientTrace,
    options: ClientPortOptions = {},
  ): IntelligenceMessagePort => ({
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind.startsWith('intelligence-')) {
        trace.commandKinds.push(message.kind);
        if (options.postFault?.() === true) trace.postFaultCommands.push(message.kind);
        if (message.kind === 'intelligence-submit' && message.submission.input === 'fault') {
          trace.faultSubmitAttempts += 1;
          if (options.throwOnFault === true) {
            trace.faultThrowInjected = true;
            throw new Error('M35 injected synchronous Worker client submit command failure');
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

  const createClient = (
    providerId: string,
    port: IntelligenceMessagePort,
    trace: M35ClientTrace,
    prefix: string,
    sessionFactory?: () => string,
  ): IntelligencePortClient =>
    createIntelligencePortClient(providerId, port, {
      limits: M35_LIMITS,
      createActivityId: () => {
        trace.activityIdentityCalls += 1;
        return activityId(`m35-worker-${prefix}-${state?.frameCount ?? 0}-${trace.activityIdentityCalls}`);
      },
      createSessionId: () => {
        trace.sessionIdentityCalls += 1;
        return sessionFactory?.() ?? `m35-worker-session-${prefix}-${trace.sessionIdentityCalls}`;
      },
    });

  const uncontainedSubmit = (session: ActivityRef['session']): void => {
    if (providerBPort === undefined) return;
    const id = activityId(`m35-uncontained-${state?.frameCount ?? 0}`);
    const submission: ActivitySubmission = { id, session, input: 'fault' };
    uncontainedActiveIds.add(id);
    try {
      providerBPort.postMessage({ kind: 'intelligence-submit', submission });
      clientTraceB.faultOutcome = 'ok';
      clientTraceB.faultResult = { ok: true };
    } catch (cause) {
      clientTraceB.faultOutcome = 'threw';
      clientTraceB.faultResult = { ok: false, threw: summarizeCause(cause) };
    }
  };

  const servicePlugin: Plugin = {
    name: 'm35-intelligence-ports',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M35 requires execution.bootstrapPort in the Worker');
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
        if (value.kind === 'm35-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined) return;
          providerBRawPort = value.port;
          providerBPort = wrapClientPort(value.port, clientTraceB, {
            throwOnFault: true,
            postFault: () => state?.postFaultProbe === true,
          });
          providerBClient = createClient(M35_PROVIDER_B_ID, providerBPort, clientTraceB, 'b');
          return;
        }
        if (
          value.kind === 'm35-host-binding-closed' &&
          value.origin === 'host-binding.after-submit-command-fault' &&
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
            state.phase = 'await-fault-probe';
          }
          post('host-binding-closed-observed', { hostClose: hostCloseDetail });
          return;
        }
        if (value.kind === 'm35-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          const wrapped = wrapClientPort(value.port, clientTraceC);
          providerCClient = createClient(M35_PROVIDER_C_ID, wrapped, clientTraceC, 'c');
        }
      };
      port.addEventListener('message', setupListener);
      const clientA = createClient(M35_PROVIDER_A_ID, wrapClientPort(port, clientTraceA), clientTraceA, 'a');
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          return Promise.all(closes).then(() => undefined);
        },
        'm35/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm35-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M35 provider-A intelligence service was not provided');
      const currentProof: M35Proof = {
        pendingText: {},
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
      };
      const localState: M35State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        survivorCompleted: false,
        controlCompleted: false,
        freshCompleted: false,
        closingTextObserved: false,
        faultAttempted: false,
        hostCloseObserved: false,
        faultProbeDone: false,
        postFaultProbe: false,
      };
      state = localState;
      proof = currentProof;
      world.insertResource('m35IntelligenceProof', currentProof);

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

      const labelFor = (id: string): 'survivor' | 'control' | 'closing' | 'fresh' | undefined => {
        if (localState.survivor !== undefined && id === String(localState.survivor.id)) return 'survivor';
        if (localState.control !== undefined && id === String(localState.control.id)) return 'control';
        if (localState.closing !== undefined && id === String(localState.closing.id)) return 'closing';
        if (localState.fresh !== undefined && id === String(localState.fresh.id)) return 'fresh';
        return undefined;
      };

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label = labelFor(id);
        if (label === undefined) {
          violation(`unexpected M35 activity ${id}`);
          return;
        }
        if (label === 'closing') {
          if (event.type === 'text-delta') {
            localState.closingTextObserved = true;
            currentProof.pendingText[id] = `${currentProof.pendingText[id] ?? ''}${event.text}`;
            return;
          }
          violation(`closing activity emitted ${event.type} after its fault boundary`);
          return;
        }
        const expectedSequence = (currentProof.perActivitySequences[id]?.at(-1) ?? 0) + 1;
        if (event.sequence !== expectedSequence) {
          violation(`${label} sequence expected ${expectedSequence} but received ${event.sequence}`);
          return;
        }
        (currentProof.perActivitySequences[id] ??= []).push(event.sequence);
        if (event.type === 'text-delta') {
          currentProof.preTerminalMutationAttempts += 1;
          currentProof.pendingText[id] = `${currentProof.pendingText[id] ?? ''}${event.text}`;
          return;
        }
        if (event.type !== 'completed') {
          violation(`${label} produced ${event.type} instead of completed`);
          return;
        }
        if (
          (label === 'control' || label === 'fresh') &&
          localState.retainedSession !== undefined &&
          (event.session.providerId !== localState.retainedSession.providerId ||
            event.session.id !== localState.retainedSession.id)
        ) {
          violation(`${label} completed with a different provider SessionRef`);
          return;
        }
        currentProof.acceptedTerminalCount += 1;
        currentProof.authoritativeMutationCount += 1;
        currentProof.authoritativeOutputs[id] = event.output;
        if (label === 'survivor') localState.survivorCompleted = true;
        if (label === 'control') localState.controlCompleted = true;
        if (label === 'fresh') localState.freshCompleted = true;
      };

      const probeAfterFault = (): void => {
        if (
          localState.faultProbeDone ||
          providerBClient === undefined ||
          localState.closing === undefined ||
          hostCloseDetail === undefined
        ) {
          return;
        }
        localState.postFaultProbe = true;
        if (falsify && providerBRawPort !== undefined) {
          providerBRawPort.dispatchEvent(
            new MessageEvent('message', { data: { kind: 'intelligence-events', events: [] } }),
          );
        }
        const activityIdentityCallsBefore = clientTraceB.activityIdentityCalls;
        const sessionIdentityCallsBefore = clientTraceB.sessionIdentityCalls;
        const commandCountBefore = clientTraceB.commandKinds.length;
        let submitAfterFault: unknown;
        let cancelAfterFault: unknown;
        let pollAfterFault: readonly ActivityEvent[] = [];
        try {
          submitAfterFault = providerBClient.submit({ input: 'after-fault' });
          cancelAfterFault = providerBClient.cancel(localState.closing.id);
          pollAfterFault = [...providerBClient.poll()];
        } catch (cause) {
          fail(`post-fault client operation threw: ${summarizeCause(cause)}`);
          submitAfterFault = { threw: summarizeCause(cause) };
          cancelAfterFault = { threw: summarizeCause(cause) };
        }
        localState.postFaultProbe = false;
        const submitSummary = summarizeResult(submitAfterFault) as {
          readonly ok?: unknown;
          readonly error?: { readonly code?: unknown };
        };
        const cancelSummary = summarizeResult(cancelAfterFault) as {
          readonly ok?: unknown;
          readonly error?: { readonly code?: unknown };
        };
        const normalClientState =
          !falsify &&
          clientTraceB.faultOutcome === 'closed' &&
          clientTraceB.removeListenerCalls === 1 &&
          clientTraceB.physicalCloseCalls === 1 &&
          clientTraceB.postFaultCommands.length === 0 &&
          submitSummary.ok === false &&
          cancelSummary.ok === false &&
          submitSummary.error?.code === 'intelligence-closed' &&
          cancelSummary.error?.code === 'intelligence-closed' &&
          pollAfterFault.length === 0 &&
          clientTraceB.activityIdentityCalls === activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls === sessionIdentityCallsBefore;
        const falsifierState =
          falsify &&
          clientTraceB.faultOutcome === 'threw' &&
          clientTraceB.removeListenerCalls === 0 &&
          clientTraceB.physicalCloseCalls === 0 &&
          clientTraceB.postFaultCommands.join('|') ===
            'intelligence-submit|intelligence-cancel|intelligence-poll' &&
          clientTraceB.activityIdentityCalls > activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls > sessionIdentityCallsBefore &&
          uncontainedActiveIds.size === 1;
        if (!falsify && !normalClientState) fail('M35 submit fault did not contain the client state');
        if (falsify && falsifierState) {
          localState.falsifierReason =
            'uncontained submit fault left optimistic activity identity, listener, and physical port open';
          post('falsifier-caught', { reason: localState.falsifierReason });
        } else if (falsify) {
          fail('M35 submit fault falsifier did not expose the uncontained client state');
        }
        if (!falsify) {
          const closeTask = providerBClient.close();
          const closeAgain = providerBClient.close();
          clientTraceB.closePromiseSame = closeTask === closeAgain;
        }
        localState.probe = {
          normalClientState,
          falsifierState,
          submitAfterFault: submitSummary,
          cancelAfterFault: cancelSummary,
          pollAfterFault,
          activityIdentityCallsBefore,
          activityIdentityCallsAfter: clientTraceB.activityIdentityCalls,
          sessionIdentityCallsBefore,
          sessionIdentityCallsAfter: clientTraceB.sessionIdentityCalls,
          commandCountBefore,
          commandCountAfter: clientTraceB.commandKinds.length,
          uncontainedActiveCount: uncontainedActiveIds.size,
        };
        localState.faultProbeDone = true;
        post('fault-probed', {
          probe: localState.probe,
          clientTrace: { ...clientTraceB, postFaultCommands: [...clientTraceB.postFaultCommands] },
        });
        evidencePort?.postMessage({ kind: 'm35-fresh-port-request' });
        localState.phase = 'await-fresh-port';
        post('fresh-port-requested', { retainedSession: localState.retainedSession });
      };

      const finish = (): void => {
        if (localState.phase === 'finished') return;
        const survivor = localState.survivor;
        const control = localState.control;
        const fresh = localState.fresh;
        const normalComplete =
          localState.failure === undefined &&
          localState.falsifierReason === undefined &&
          hostCloseDetail?.origin === 'host-binding.after-submit-command-fault' &&
          hostCloseDetail.pollOutstandingAtClose === 1 &&
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          !hostCloseDetail.notificationSuppressed &&
          localState.hostCloseObserved &&
          localState.faultProbeDone &&
          localState.survivorCompleted &&
          localState.controlCompleted &&
          localState.freshCompleted &&
          localState.closingTextObserved &&
          survivor !== undefined &&
          control !== undefined &&
          fresh !== undefined &&
          localState.retainedSession !== undefined &&
          currentProof.preTerminalMutationAttempts === 3 &&
          currentProof.prematureMutationCount === 0 &&
          currentProof.acceptedTerminalCount === 3 &&
          currentProof.authoritativeMutationCount === 3 &&
          currentProof.pendingText[String(survivor.id)] === 'survivor:' &&
          currentProof.pendingText[String(control.id)] === 'control:' &&
          currentProof.pendingText[String(fresh.id)] === 'fresh:' &&
          currentProof.authoritativeOutputs[String(survivor.id)] === 'survivor-ok' &&
          currentProof.authoritativeOutputs[String(control.id)] === 'control-ok' &&
          currentProof.authoritativeOutputs[String(fresh.id)] === 'fresh-ok' &&
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
              postFaultCommands: [...clientTraceB.postFaultCommands],
            },
            providerC: { ...clientTraceC, commandKinds: [...clientTraceC.commandKinds] },
          },
          hostClose: hostCloseDetail ?? null,
          probe: localState.probe ?? null,
          frameCount: localState.frameCount,
          survivorId: survivor === undefined ? null : String(survivor.id),
          controlId: control === undefined ? null : String(control.id),
          closingId: localState.closing === undefined ? null : String(localState.closing.id),
          freshId: fresh === undefined ? null : String(fresh.id),
          retainedSession: localState.retainedSession ?? null,
          proof: {
            ...currentProof,
            pendingText: { ...currentProof.pendingText },
            perActivitySequences: Object.fromEntries(
              Object.entries(currentProof.perActivitySequences).map(([id, sequences]) => [id, [...sequences]]),
            ),
            authoritativeOutputs: { ...currentProof.authoritativeOutputs },
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
          providerBClientClose: falsify ? 'falsifier-uncontained' : 'settled-after-submit-fault',
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
          const control = submit(providerBClient, 'control');
          if (survivor === undefined || control === undefined) {
            fail('M35 initial activity roster did not admit survivor and control');
            return;
          }
          localState.survivor = survivor;
          localState.control = control;
          localState.retainedSession = control.session;
          clientA.poll();
          providerBClient.poll();
          localState.phase = 'await-control';
          post('initial-submitted', {
            survivorId: String(survivor.id),
            controlId: String(control.id),
            retainedSession: control.session,
            pollOutstandingExpected: 1,
          });
          return;
        }
        if (localState.phase === 'await-control' && localState.controlCompleted) {
          if (providerBClient === undefined || localState.retainedSession === undefined) {
            fail('M35 control completed without a retained provider SessionRef');
            return;
          }
          const closing = submit(providerBClient, 'closing', localState.retainedSession);
          if (closing === undefined) return;
          localState.closing = closing;
          localState.phase = 'await-closing';
          providerBClient.poll();
          post('control-completed', { retainedSession: localState.retainedSession });
          return;
        }
        if (
          localState.phase === 'await-closing' &&
          localState.closingTextObserved &&
          !localState.faultAttempted &&
          localState.retainedSession !== undefined
        ) {
          localState.faultAttempted = true;
          localState.phase = 'await-host-close';
          if (falsify) {
            uncontainedSubmit(localState.retainedSession);
          } else if (providerBClient !== undefined) {
            const result = providerBClient.submit({ input: 'fault', session: localState.retainedSession });
            clientTraceB.faultResult = summarizeResult(result);
            clientTraceB.faultOutcome = result.ok
              ? 'ok'
              : result.error.code === 'intelligence-closed'
                ? 'closed'
                : 'threw';
          }
          post('submit-fault-contained', {
            outcome: clientTraceB.faultOutcome,
            result: clientTraceB.faultResult,
            falsify,
          });
          return;
        }
        if (localState.phase === 'await-fault-probe' && localState.hostCloseObserved) {
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-fresh-port' && providerCClient !== undefined) {
          if (localState.retainedSession === undefined) {
            fail('M35 fresh client arrived without the retained SessionRef');
            return;
          }
          const fresh = submit(providerCClient, 'fresh', localState.retainedSession);
          if (fresh === undefined) return;
          localState.fresh = fresh;
          localState.phase = 'await-completions';
          providerCClient.poll();
          post('fresh-submitted', {
            freshId: String(fresh.id),
            retainedSession: localState.retainedSession,
          });
          return;
        }
        if (
          localState.phase === 'await-completions' &&
          localState.survivorCompleted &&
          localState.controlCompleted &&
          localState.freshCompleted &&
          localState.faultProbeDone
        ) {
          finish();
        }
      };

      const system = {
        name: 'm35-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (localState.phase === 'finished') return;
          localState.frameCount += 1;
          for (const event of clientA.poll()) recordEvent(event);
          if (providerBClient !== undefined && !localState.faultAttempted) {
            for (const event of providerBClient.poll()) recordEvent(event);
          }
          if (providerCClient !== undefined) {
            for (const event of providerCClient.poll()) recordEvent(event);
          }
          if (localState.frameCount > 300 && localState.phase !== 'finished') {
            fail('M35 submit command fault recovery did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm35/intelligence-system',
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
      }, 'm35/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
