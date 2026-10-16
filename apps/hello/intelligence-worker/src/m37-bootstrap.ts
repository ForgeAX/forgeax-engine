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
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligencePortClient,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { M37_LIMITS, M37_PROVIDER_A_ID, M37_PROVIDER_B_ID, M37_PROVIDER_C_ID } from './m37-provider';

interface M37HostCloseDetail {
  readonly origin: 'host-binding.after-cancel-command-fault';
  readonly cancelCallsBeforeClose: number;
  readonly activeCountAtClose: number;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
}

interface M37ClientTrace {
  readonly commandKinds: string[];
  readonly postFaultCommands: string[];
  readonly targetId: string | null;
  activityIdentityCalls: number;
  sessionIdentityCalls: number;
  cancelAttempts: number;
  cancelThrowInjected: boolean;
  cancelOutcome: 'closed' | 'threw' | 'ok' | null;
  cancelResult: unknown;
  stagedEventObserved: boolean;
  stagedEventCountAtResponse: number;
  removeListenerCalls: number;
  physicalCloseCalls: number;
  closePromiseSame: boolean | null;
}

interface M37Probe {
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
  readonly activeCountAfterFault: number;
  readonly stagedEventCountBeforeProbe: number;
  readonly stagedEventCountAfterProbe: number;
  readonly pollPendingAfterFault: boolean;
}

interface M37Proof {
  readonly pendingText: Record<string, string>;
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  authoritativeMutationCount: number;
  targetEventsReturned: number;
}

type M37Phase =
  | 'wait-provider-b'
  | 'await-cancel-fault'
  | 'await-host-close'
  | 'await-probe'
  | 'await-fresh'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M37State {
  phase: M37Phase;
  frameCount: number;
  control?: ActivityRef;
  target?: ActivityRef;
  fresh?: ActivityRef;
  retainedSession?: ActivityRef['session'];
  controlCompleted: boolean;
  freshCompleted: boolean;
  cancelAttempted: boolean;
  hostCloseObserved: boolean;
  probeDone: boolean;
  postFaultProbe: boolean;
  probe?: M37Probe;
  failure?: string;
  falsifierReason?: string;
}

interface ClientPortOptions {
  readonly faultActivityId?: () => string | undefined;
  readonly injectCancelFault?: boolean;
  readonly postFault?: () => boolean;
}

interface M37LegacyClient {
  readonly active: Set<ActivityId>;
  readonly received: ActivityEvent[];
  readonly pollPending: boolean;
  submit(ref: ActivityRef, input: string): void;
  cancel(id: ActivityId): void;
  poll(): readonly ActivityEvent[];
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

function summarizeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function summarizeResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  if (value.ok === true) return { ok: true };
  const error = value.error;
  if (typeof error !== 'object' || error === null) return { ok: false, error };
  const detail = error as { readonly code?: unknown; readonly detail?: unknown };
  return {
    ok: false,
    error: {
      code: typeof detail.code === 'string' ? detail.code : undefined,
      detail: detail.detail,
    },
  };
}

const bootstrap: ExecutionBootstrapEntry = (data) => {
  const falsify = isFalsifierRequested(data);
  let evidencePort: MessagePort | undefined;
  let providerBClient: IntelligencePortClient | undefined;
  let legacyClient: M37LegacyClient | undefined;
  let providerCClient: IntelligencePortClient | undefined;
  let hostCloseDetail: M37HostCloseDetail | undefined;
  let state: M37State | undefined;
  const clientTraceA: M37ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    targetId: null,
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    cancelAttempts: 0,
    cancelThrowInjected: false,
    cancelOutcome: null,
    cancelResult: null,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceB: M37ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    targetId: null,
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    cancelAttempts: 0,
    cancelThrowInjected: false,
    cancelOutcome: null,
    cancelResult: null,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceC: M37ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    targetId: null,
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    cancelAttempts: 0,
    cancelThrowInjected: false,
    cancelOutcome: null,
    cancelResult: null,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };

  const post = (event: string, detail: Record<string, unknown> = {}): void => {
    evidencePort?.postMessage({ kind: 'm37-worker-event', event, detail });
  };

  const wrapClientPort = (
    port: MessagePort,
    trace: M37ClientTrace,
    options: ClientPortOptions = {},
  ): IntelligenceMessagePort => {
    const listeners = new Map<
      (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void,
      (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void
    >();
    return {
      postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
        if (message.kind.startsWith('intelligence-')) {
          trace.commandKinds.push(message.kind);
          if (options.postFault?.() === true) trace.postFaultCommands.push(message.kind);
          if (
            message.kind === 'intelligence-cancel' &&
            options.injectCancelFault === true &&
            !trace.cancelThrowInjected &&
            String(message.activityId) === options.faultActivityId?.()
          ) {
            trace.cancelAttempts += 1;
            trace.cancelThrowInjected = true;
            throw new Error('M37 injected synchronous Worker client cancel command failure');
          }
        }
        port.postMessage(message);
      },
      addEventListener(type, listener): void {
        const forwarded = (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>): void => {
          const message = event.data;
          if (message.kind === 'intelligence-events' && message.events.length > 0) {
            trace.stagedEventObserved = true;
            trace.stagedEventCountAtResponse = message.events.length;
          }
          listener(event);
        };
        listeners.set(listener, forwarded);
        port.addEventListener(type, forwarded as EventListener);
      },
      removeEventListener(type, listener): void {
        trace.removeListenerCalls += 1;
        const forwarded = listeners.get(listener);
        if (forwarded === undefined) return;
        listeners.delete(listener);
        port.removeEventListener(type, forwarded as EventListener);
      },
      start(): void {
        port.start();
      },
      close(): void {
        trace.physicalCloseCalls += 1;
        port.close();
      },
    };
  };

  const createClient = (
    providerId: string,
    port: IntelligenceMessagePort,
    trace: M37ClientTrace,
    prefix: string,
  ): IntelligencePortClient =>
    createIntelligencePortClient(providerId, port, {
      limits: M37_LIMITS,
      createActivityId: () => {
        trace.activityIdentityCalls += 1;
        return activityId(`m37-worker-${prefix}-${state?.frameCount ?? 0}-${trace.activityIdentityCalls}`);
      },
      createSessionId: () => {
        trace.sessionIdentityCalls += 1;
        return `m37-worker-session-${prefix}-${trace.sessionIdentityCalls}`;
      },
    });

  const postLegacy = (
    port: MessagePort,
    trace: M37ClientTrace,
    message: IntelligenceHostCommand,
    options: ClientPortOptions,
  ): void => {
    trace.commandKinds.push(message.kind);
    if (options.postFault?.() === true) trace.postFaultCommands.push(message.kind);
    if (
      message.kind === 'intelligence-cancel' &&
      options.injectCancelFault === true &&
      !trace.cancelThrowInjected &&
      String(message.activityId) === options.faultActivityId?.()
    ) {
      trace.cancelAttempts += 1;
      trace.cancelThrowInjected = true;
      throw new Error('M37 uncontained Worker client cancel command failure');
    }
    port.postMessage(message);
  };

  const createLegacyClient = (port: MessagePort, trace: M37ClientTrace): M37LegacyClient => {
    let received: ActivityEvent[] = [];
    let pollPending = false;
    const active = new Set<ActivityId>();
    const listener = (event: MessageEvent<unknown>): void => {
      const message = event.data;
      if (typeof message !== 'object' || message === null) return;
      const value = message as { readonly kind?: unknown; readonly events?: readonly ActivityEvent[] };
      if (value.kind !== 'intelligence-events' || value.events === undefined) return;
      pollPending = false;
      if (value.events.length > 0) {
        trace.stagedEventObserved = true;
        trace.stagedEventCountAtResponse = value.events.length;
      }
      received = [...received, ...value.events];
    };
    port.addEventListener('message', listener);
    port.start();
    return {
      get active() {
        return active;
      },
      get received() {
        return received;
      },
      get pollPending() {
        return pollPending;
      },
      submit(ref, input): void {
        active.add(ref.id);
        postLegacy(port, trace, { kind: 'intelligence-submit', submission: { ...ref, input } }, {
          faultActivityId: () => state?.target && String(state.target.id),
          injectCancelFault: false,
          postFault: () => state?.postFaultProbe === true,
        });
      },
      cancel(id): void {
        postLegacy(port, trace, { kind: 'intelligence-cancel', activityId: id }, {
          faultActivityId: () => state?.target && String(state.target.id),
          injectCancelFault: true,
          postFault: () => state?.postFaultProbe === true,
        });
      },
      poll(): readonly ActivityEvent[] {
        const events = received.splice(0, M37_LIMITS.maxPollEvents);
        if (!pollPending) {
          pollPending = true;
          postLegacy(port, trace, { kind: 'intelligence-poll', maxEvents: M37_LIMITS.maxPollEvents }, {
            faultActivityId: () => state?.target && String(state.target.id),
            injectCancelFault: false,
            postFault: () => state?.postFaultProbe === true,
          });
        }
        return events;
      },
    };
  };

  const servicePlugin: Plugin = {
    name: 'm37-intelligence-worker-services',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M37 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const setupListener = (event: MessageEvent<unknown>): void => {
        const message = event.data;
        if (typeof message !== 'object' || message === null) return;
        const value = message as {
          readonly kind?: unknown;
          readonly port?: unknown;
          readonly origin?: unknown;
          readonly cancelCallsBeforeClose?: unknown;
          readonly activeCountAtClose?: unknown;
          readonly hostCloseSettled?: unknown;
          readonly hostCloseRejected?: unknown;
          readonly physicalCloseCalls?: unknown;
        };
        if (value.kind === 'm37-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined || legacyClient !== undefined) return;
          if (falsify) {
            legacyClient = createLegacyClient(value.port, clientTraceB);
          } else {
            providerBClient = createClient(
              M37_PROVIDER_B_ID,
              wrapClientPort(value.port, clientTraceB, {
                injectCancelFault: true,
                faultActivityId: () => state?.target && String(state.target.id),
                postFault: () => state?.postFaultProbe === true,
              }),
              clientTraceB,
              'b',
            );
          }
          return;
        }
        if (
          value.kind === 'm37-host-binding-closed' &&
          value.origin === 'host-binding.after-cancel-command-fault' &&
          typeof value.cancelCallsBeforeClose === 'number' &&
          typeof value.activeCountAtClose === 'number' &&
          typeof value.hostCloseSettled === 'boolean' &&
          typeof value.hostCloseRejected === 'boolean' &&
          typeof value.physicalCloseCalls === 'number'
        ) {
          hostCloseDetail = {
            origin: value.origin,
            cancelCallsBeforeClose: value.cancelCallsBeforeClose,
            activeCountAtClose: value.activeCountAtClose,
            hostCloseSettled: value.hostCloseSettled,
            hostCloseRejected: value.hostCloseRejected,
            physicalCloseCalls: value.physicalCloseCalls,
          };
          if (state !== undefined) {
            state.hostCloseObserved = true;
            state.phase = 'await-probe';
          }
          post('host-binding-closed-observed', { hostClose: hostCloseDetail });
          return;
        }
        if (value.kind === 'm37-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          providerCClient = createClient(
            M37_PROVIDER_C_ID,
            wrapClientPort(value.port, clientTraceC),
            clientTraceC,
            'c',
          );
        }
      };
      port.addEventListener('message', setupListener);
      const clientA = createClient(
        M37_PROVIDER_A_ID,
        wrapClientPort(port, clientTraceA),
        clientTraceA,
        'a',
      );
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          return Promise.all(closes).then(() => undefined);
        },
        'm37/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm37-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M37 control intelligence service was not provided');
      const currentProof: M37Proof = {
        pendingText: {},
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        authoritativeMutationCount: 0,
        targetEventsReturned: 0,
      };
      const localState: M37State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        controlCompleted: false,
        freshCompleted: false,
        cancelAttempted: false,
        hostCloseObserved: false,
        probeDone: false,
        postFaultProbe: false,
      };
      state = localState;
      world.insertResource('m37IntelligenceProof', currentProof);

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

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        if (localState.target !== undefined && id === String(localState.target.id)) {
          currentProof.targetEventsReturned += 1;
          violation(`cancel target event reached World polling: ${event.type}`);
          return;
        }
        const label =
          localState.control !== undefined && id === String(localState.control.id)
            ? 'control'
            : localState.fresh !== undefined && id === String(localState.fresh.id)
              ? 'fresh'
              : undefined;
        if (label === undefined) {
          violation(`unexpected M37 activity ${id}`);
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
        currentProof.authoritativeMutationCount += 1;
        currentProof.authoritativeOutputs[id] = event.output;
        if (label === 'control') localState.controlCompleted = true;
        if (label === 'fresh') localState.freshCompleted = true;
      };

      const markCancelFault = (outcome: 'closed' | 'threw', result: unknown): void => {
        if (localState.cancelAttempted) return;
        localState.cancelAttempted = true;
        localState.phase = 'await-host-close';
        clientTraceB.cancelOutcome = outcome;
        clientTraceB.cancelResult = result;
        post('cancel-fault-contained', {
          outcome,
          result,
          falsify,
          stagedEventObserved: clientTraceB.stagedEventObserved,
          targetId: localState.target === undefined ? null : String(localState.target.id),
        });
      };

      const createLegacyRef = (session?: ActivityRef['session']): ActivityRef => {
        clientTraceB.activityIdentityCalls += 1;
        const retainedSession =
          session ??
          ({
            providerId: M37_PROVIDER_B_ID,
            id: `m37-worker-session-b-${clientTraceB.sessionIdentityCalls + 1}`,
          } as const);
        if (session === undefined) clientTraceB.sessionIdentityCalls += 1;
        return {
          id: activityId(`m37-uncontained-${localState.frameCount}-${clientTraceB.activityIdentityCalls}`),
          session: retainedSession,
        };
      };

      const probeAfterFault = (): void => {
        if (
          localState.probeDone ||
          hostCloseDetail === undefined ||
          localState.target === undefined ||
          (falsify ? legacyClient === undefined : providerBClient === undefined)
        ) {
          return;
        }
        localState.postFaultProbe = true;
        const activityIdentityCallsBefore = clientTraceB.activityIdentityCalls;
        const sessionIdentityCallsBefore = clientTraceB.sessionIdentityCalls;
        const commandCountBefore = clientTraceB.commandKinds.length;
        const stagedEventCountBeforeProbe = legacyClient?.received.length ?? 0;
        let submitAfterFault: unknown;
        let cancelAfterFault: unknown;
        let pollAfterFault: readonly ActivityEvent[] = [];
        if (falsify) {
          const legacy = legacyClient;
          if (legacy === undefined) {
            fail('M37 legacy cancel falsifier disappeared before probe');
          } else {
            try {
              legacy.submit(createLegacyRef(), 'after-cancel-fault');
              submitAfterFault = { ok: true };
            } catch (cause) {
              submitAfterFault = { threw: summarizeCause(cause) };
            }
            try {
              legacy.cancel(localState.target.id);
              cancelAfterFault = { ok: true };
            } catch (cause) {
              cancelAfterFault = { threw: summarizeCause(cause) };
            }
            try {
              pollAfterFault = [...legacy.poll()];
            } catch (cause) {
              pollAfterFault = [];
              violation(`M37 falsifier poll unexpectedly threw: ${summarizeCause(cause)}`);
            }
          }
        } else {
          const client = providerBClient;
          if (client === undefined) {
            fail('M37 provider-B client disappeared before probe');
          } else {
            try {
              submitAfterFault = client.submit({ input: 'after-cancel-fault' });
              cancelAfterFault = client.cancel(localState.target.id);
              pollAfterFault = [...client.poll()];
            } catch (cause) {
              fail(`post-fault client operation threw: ${summarizeCause(cause)}`);
              submitAfterFault = { threw: summarizeCause(cause) };
              cancelAfterFault = { threw: summarizeCause(cause) };
            }
          }
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
          clientTraceB.cancelOutcome === 'closed' &&
          clientTraceB.cancelAttempts === 1 &&
          clientTraceB.cancelThrowInjected &&
          clientTraceB.stagedEventObserved &&
          clientTraceB.removeListenerCalls === 1 &&
          clientTraceB.physicalCloseCalls === 1 &&
          clientTraceB.postFaultCommands.length === 0 &&
          submitSummary.ok === false &&
          cancelSummary.ok === false &&
          submitSummary.error?.code === 'intelligence-closed' &&
          cancelSummary.error?.code === 'intelligence-closed' &&
          pollAfterFault.length === 0 &&
          clientTraceB.activityIdentityCalls === activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls === sessionIdentityCallsBefore &&
          clientTraceB.commandKinds.length === commandCountBefore;
        const falsifierState =
          falsify &&
          clientTraceB.cancelOutcome === 'threw' &&
          clientTraceB.cancelAttempts === 1 &&
          clientTraceB.cancelThrowInjected &&
          clientTraceB.removeListenerCalls === 0 &&
          clientTraceB.physicalCloseCalls === 0 &&
          clientTraceB.postFaultCommands.join('|') ===
            'intelligence-submit|intelligence-cancel|intelligence-poll' &&
          clientTraceB.activityIdentityCalls > activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls > sessionIdentityCallsBefore &&
          (legacyClient?.active.size ?? 0) >= 2 &&
          stagedEventCountBeforeProbe === 1;
        if (!falsify && !normalClientState) fail('M37 cancel fault did not contain the client state');
        if (falsify && falsifierState) {
          localState.falsifierReason =
            'uncontained cancel fault left the active target, staged event, listener, port, identity, and post-fault commands live';
          post('falsifier-caught', { reason: localState.falsifierReason });
        } else if (falsify) {
          fail('M37 cancel fault falsifier did not expose the uncontained client state');
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
          activeCountAfterFault: legacyClient?.active.size ?? 0,
          stagedEventCountBeforeProbe,
          stagedEventCountAfterProbe: legacyClient?.received.length ?? 0,
          pollPendingAfterFault: legacyClient?.pollPending ?? false,
        };
        localState.probeDone = true;
        post('fault-probed', {
          probe: localState.probe,
          clientTrace: { ...clientTraceB, postFaultCommands: [...clientTraceB.postFaultCommands] },
        });
        evidencePort?.postMessage({ kind: 'm37-fresh-port-request' });
        localState.phase = 'await-fresh';
        post('fresh-port-requested', { retainedSession: localState.retainedSession });
      };

      const finish = (): void => {
        if (localState.phase === 'finished') return;
        const control = localState.control;
        const target = localState.target;
        const fresh = localState.fresh;
        const normalComplete =
          localState.failure === undefined &&
          localState.falsifierReason === undefined &&
          hostCloseDetail?.origin === 'host-binding.after-cancel-command-fault' &&
          hostCloseDetail.cancelCallsBeforeClose === 0 &&
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          localState.hostCloseObserved &&
          localState.probeDone &&
          localState.controlCompleted &&
          localState.freshCompleted &&
          control !== undefined &&
          target !== undefined &&
          fresh !== undefined &&
          localState.retainedSession !== undefined &&
          clientTraceB.stagedEventObserved &&
          currentProof.preTerminalMutationAttempts === 2 &&
          currentProof.authoritativeMutationCount === 2 &&
          currentProof.targetEventsReturned === 0 &&
          currentProof.pendingText[String(control.id)] === 'control:' &&
          currentProof.pendingText[String(fresh.id)] === 'fresh:' &&
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
          controlId: control === undefined ? null : String(control.id),
          targetId: target === undefined ? null : String(target.id),
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
            providerA: closeA === closeAAgain,
            providerC: closeC !== undefined && closeC === closeCAgain,
          },
          providerBClientClose: falsify ? 'falsifier-uncontained' : 'closed-on-cancel-fault',
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
        const bReady = falsify ? legacyClient !== undefined : providerBClient !== undefined;
        if (localState.phase === 'wait-provider-b' && bReady) {
          const control = submit(clientA, 'control');
          if (control === undefined) return;
          let target: ActivityRef | undefined;
          if (falsify) {
            const legacy = legacyClient;
            if (legacy === undefined) {
              fail('M37 legacy cancel falsifier was not ready');
              return;
            }
            target = createLegacyRef();
            legacy.submit(target, 'cancel-target');
          } else if (providerBClient !== undefined) {
            target = submit(providerBClient, 'cancel-target');
          }
          if (target === undefined) {
            fail('M37 initial activity roster did not admit control and cancel target');
            return;
          }
          localState.control = control;
          localState.target = target;
          localState.retainedSession = target.session;
          clientTraceB.targetId = String(target.id);
          clientA.poll();
          if (falsify) legacyClient?.poll();
          else providerBClient?.poll();
          localState.phase = 'await-cancel-fault';
          post('initial-submitted', {
            controlId: String(control.id),
            targetId: String(target.id),
            retainedSession: target.session,
            secondActivityStarted: true,
            maxPollEvents: M37_LIMITS.maxPollEvents,
          });
          return;
        }
        if (localState.phase === 'await-cancel-fault' && clientTraceB.stagedEventObserved) {
          const target = localState.target;
          if (target === undefined) {
            fail('M37 cancel target disappeared before the fault');
            return;
          }
          if (falsify) {
            try {
              legacyClient?.cancel(target.id);
              markCancelFault('ok', { ok: true });
            } catch (cause) {
              markCancelFault('threw', { ok: false, threw: summarizeCause(cause) });
            }
          } else {
            const client = providerBClient;
            if (client === undefined) {
              fail('M37 provider-B client disappeared before the fault');
              return;
            }
            try {
              const result = client.cancel(target.id);
              markCancelFault(result.ok ? 'ok' : 'closed', summarizeResult(result));
            } catch (cause) {
              fail(`M37 contained cancel unexpectedly threw: ${summarizeCause(cause)}`);
            }
          }
          return;
        }
        if (localState.phase === 'await-host-close' && localState.hostCloseObserved) {
          localState.phase = 'await-probe';
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-probe' && localState.hostCloseObserved) {
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-fresh' && providerCClient !== undefined) {
          if (localState.retainedSession === undefined) {
            fail('M37 fresh client arrived without the retained SessionRef');
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
          localState.controlCompleted &&
          localState.freshCompleted &&
          localState.probeDone
        ) {
          finish();
        }
      };

      const system = {
        name: 'm37-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (localState.phase === 'finished') return;
          localState.frameCount += 1;
          const bReady = falsify ? legacyClient !== undefined : providerBClient !== undefined;
          if (localState.phase === 'wait-provider-b' && bReady) {
            drive();
            return;
          }
          for (const event of clientA.poll()) recordEvent(event);
          if (providerCClient !== undefined) {
            for (const event of providerCClient.poll()) recordEvent(event);
          }
          if (localState.frameCount > 300 && localState.phase !== 'finished') {
            fail('M37 cancel command fault recovery did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm37/intelligence-system',
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
      }, 'm37/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
