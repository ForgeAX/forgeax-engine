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
  M36_LIMITS,
  M36_PROVIDER_A_ID,
  M36_PROVIDER_B_ID,
  M36_PROVIDER_C_ID,
} from './m36-provider';

interface M36HostCloseDetail {
  readonly origin: 'host-binding.after-poll-command-fault';
  readonly pollOutstandingAtClose: number;
  readonly notificationAttempted: boolean;
  readonly notificationForwarded: boolean;
  readonly notificationSuppressed: boolean;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
}

interface M36ClientTrace {
  readonly commandKinds: string[];
  readonly postFaultCommands: string[];
  activityIdentityCalls: number;
  sessionIdentityCalls: number;
  faultPollAttempts: number;
  faultThrowInjected: boolean;
  faultOutcome: 'closed' | 'threw' | 'ok' | null;
  faultResult: unknown;
  normalPollResponses: number;
  stagedEventObserved: boolean;
  stagedEventCountAtResponse: number;
  faultStagedEventCountBefore: number | null;
  faultStagedEventCountAfter: number | null;
  faultPollPendingAfter: boolean | null;
  removeListenerCalls: number;
  physicalCloseCalls: number;
  closePromiseSame: boolean | null;
}

interface M36FaultProbe {
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
  readonly stagedEventCountAfterFault: number;
  readonly pollPendingAfterFault: boolean;
}

interface M36Proof {
  readonly pendingText: Record<string, string>;
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  prematureMutationCount: number;
  acceptedTerminalCount: number;
  authoritativeMutationCount: number;
  targetEventsReturned: number;
}

type M36Phase =
  | 'wait-provider-b'
  | 'await-poll-fault'
  | 'await-host-close'
  | 'await-fault-probe'
  | 'await-fresh-port'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M36State {
  phase: M36Phase;
  frameCount: number;
  survivor?: ActivityRef;
  target?: ActivityRef;
  fresh?: ActivityRef;
  retainedSession?: ActivityRef['session'];
  survivorCompleted: boolean;
  freshCompleted: boolean;
  faultAttempted: boolean;
  hostCloseObserved: boolean;
  faultProbeDone: boolean;
  postFaultProbe: boolean;
  probe?: M36FaultProbe;
  failure?: string;
  falsifierReason?: string;
}

interface ClientPortOptions {
  readonly throwOnPollFault?: boolean;
  readonly postFault?: () => boolean;
}

interface M36LegacyPollClient {
  readonly active: Set<ActivityId>;
  readonly received: ActivityEvent[];
  readonly pollPending: boolean;
  readonly stagedEventObserved: boolean;
  submit(ref: ActivityRef): void;
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
  let legacyPollClient: M36LegacyPollClient | undefined;
  let providerCClient: IntelligencePortClient | undefined;
  let hostCloseDetail: M36HostCloseDetail | undefined;
  let state: M36State | undefined;
  let proof: M36Proof | undefined;
  const clientTraceA: M36ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultPollAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    normalPollResponses: 0,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    faultStagedEventCountBefore: null,
    faultStagedEventCountAfter: null,
    faultPollPendingAfter: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceB: M36ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultPollAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    normalPollResponses: 0,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    faultStagedEventCountBefore: null,
    faultStagedEventCountAfter: null,
    faultPollPendingAfter: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
  const clientTraceC: M36ClientTrace = {
    commandKinds: [],
    postFaultCommands: [],
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    faultPollAttempts: 0,
    faultThrowInjected: false,
    faultOutcome: null,
    faultResult: null,
    normalPollResponses: 0,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    faultStagedEventCountBefore: null,
    faultStagedEventCountAfter: null,
    faultPollPendingAfter: null,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };

  const post = (event: string, detail: Record<string, unknown> = {}): void => {
    evidencePort?.postMessage({ kind: 'm36-worker-event', event, detail });
  };

  const wrapClientPort = (
    port: MessagePort,
    trace: M36ClientTrace,
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
          if (message.kind === 'intelligence-poll' && options.throwOnPollFault === true && trace.stagedEventObserved) {
            trace.faultPollAttempts += 1;
            trace.faultThrowInjected = true;
            throw new Error('M36 injected synchronous Worker client poll command failure');
          }
        }
        port.postMessage(message);
      },
      addEventListener(type, listener): void {
        const forwarded = (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>): void => {
          const message = event.data;
          if (message.kind === 'intelligence-events') {
            trace.normalPollResponses += 1;
            if (message.events.length > 0) {
              trace.stagedEventObserved = true;
              trace.stagedEventCountAtResponse = message.events.length;
            }
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
    trace: M36ClientTrace,
    prefix: string,
  ): IntelligencePortClient =>
    createIntelligencePortClient(providerId, port, {
      limits: M36_LIMITS,
      createActivityId: () => {
        trace.activityIdentityCalls += 1;
        return activityId(`m36-worker-${prefix}-${state?.frameCount ?? 0}-${trace.activityIdentityCalls}`);
      },
      createSessionId: () => {
        trace.sessionIdentityCalls += 1;
        return `m36-worker-session-${prefix}-${trace.sessionIdentityCalls}`;
      },
    });

  const postLegacy = (
    port: MessagePort,
    trace: M36ClientTrace,
    message: IntelligenceHostCommand,
    throwOnPoll = false,
  ): void => {
    trace.commandKinds.push(message.kind);
    if (state?.postFaultProbe === true) trace.postFaultCommands.push(message.kind);
    if (throwOnPoll && message.kind === 'intelligence-poll') {
      throw new Error('M36 uncontained Worker client poll command failure');
    }
    port.postMessage(message);
  };

  const createLegacyClient = (port: MessagePort, trace: M36ClientTrace): M36LegacyPollClient => {
    let received: ActivityEvent[] = [];
    let pollPending = false;
    let stagedEventObserved = false;
    let armPollFault = false;
    const active = new Set<ActivityId>();
    const listener = (event: MessageEvent<unknown>): void => {
      const message = event.data;
      if (typeof message !== 'object' || message === null) return;
      const value = message as {
        readonly kind?: unknown;
        readonly events?: readonly ActivityEvent[];
      };
      if (value.kind !== 'intelligence-events' || value.events === undefined) return;
      pollPending = false;
      trace.normalPollResponses += 1;
      if (value.events.length > 0) {
        stagedEventObserved = true;
        armPollFault = true;
        trace.stagedEventObserved = true;
        trace.stagedEventCountAtResponse = value.events.length;
      }
      received = [...received, ...value.events];
    };
    port.addEventListener('message', listener);
    port.start();
    const client: M36LegacyPollClient = {
      get active() {
        return active;
      },
      get received() {
        return received;
      },
      get pollPending() {
        return pollPending;
      },
      get stagedEventObserved() {
        return stagedEventObserved;
      },
      submit(ref: ActivityRef): void {
        active.add(ref.id);
        postLegacy(port, trace, {
          kind: 'intelligence-submit',
          submission: { ...ref, input: 'poll-fault-target' },
        });
      },
      cancel(id: ActivityId): void {
        postLegacy(port, trace, { kind: 'intelligence-cancel', activityId: id });
      },
      poll(): readonly ActivityEvent[] {
        const events = received.splice(0, M36_LIMITS.maxPollEvents);
        const throwOnPoll = armPollFault;
        if (!pollPending) {
          pollPending = true;
          if (throwOnPoll) {
            armPollFault = false;
            trace.faultPollAttempts += 1;
            trace.faultThrowInjected = true;
            trace.faultStagedEventCountBefore = events.length;
          }
          try {
            postLegacy(port, trace, {
              kind: 'intelligence-poll',
              maxEvents: M36_LIMITS.maxPollEvents,
            }, throwOnPoll);
          } catch (cause) {
            trace.faultOutcome = 'threw';
            trace.faultResult = { ok: false, threw: summarizeCause(cause) };
            trace.faultStagedEventCountAfter = received.length;
            trace.faultPollPendingAfter = pollPending;
            throw cause;
          }
        }
        return events;
      },
    };
    return client;
  };

  const createLegacyRef = (trace: M36ClientTrace, session?: ActivityRef['session']): ActivityRef => {
    trace.activityIdentityCalls += 1;
    const retainedSession =
      session ??
      (() => {
        trace.sessionIdentityCalls += 1;
        return { providerId: M36_PROVIDER_B_ID, id: `m36-worker-session-b-${trace.sessionIdentityCalls}` };
      })();
    return {
      id: activityId(`m36-uncontained-${state?.frameCount ?? 0}-${trace.activityIdentityCalls}`),
      session: retainedSession,
    };
  };

  const servicePlugin: Plugin = {
    name: 'm36-intelligence-ports',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M36 requires execution.bootstrapPort in the Worker');
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
        if (value.kind === 'm36-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined || legacyPollClient !== undefined) return;
          providerBRawPort = value.port;
          if (falsify) {
            legacyPollClient = createLegacyClient(value.port, clientTraceB);
          } else {
            providerBPort = wrapClientPort(value.port, clientTraceB, { throwOnPollFault: true });
            providerBClient = createClient(M36_PROVIDER_B_ID, providerBPort, clientTraceB, 'b');
          }
          return;
        }
        if (
          value.kind === 'm36-host-binding-closed' &&
          value.origin === 'host-binding.after-poll-command-fault' &&
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
        if (value.kind === 'm36-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          providerCClient = createClient(
            M36_PROVIDER_C_ID,
            wrapClientPort(value.port, clientTraceC),
            clientTraceC,
            'c',
          );
        }
      };
      port.addEventListener('message', setupListener);
      const clientA = createClient(M36_PROVIDER_A_ID, wrapClientPort(port, clientTraceA), clientTraceA, 'a');
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          return Promise.all(closes).then(() => undefined);
        },
        'm36/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm36-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M36 provider-A intelligence service was not provided');
      const currentProof: M36Proof = {
        pendingText: {},
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        prematureMutationCount: 0,
        acceptedTerminalCount: 0,
        authoritativeMutationCount: 0,
        targetEventsReturned: 0,
      };
      const localState: M36State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        survivorCompleted: false,
        freshCompleted: false,
        faultAttempted: false,
        hostCloseObserved: false,
        faultProbeDone: false,
        postFaultProbe: false,
      };
      state = localState;
      proof = currentProof;
      world.insertResource('m36IntelligenceProof', currentProof);

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

      const labelFor = (id: string): 'survivor' | 'target' | 'fresh' | undefined => {
        if (localState.survivor !== undefined && id === String(localState.survivor.id)) return 'survivor';
        if (localState.target !== undefined && id === String(localState.target.id)) return 'target';
        if (localState.fresh !== undefined && id === String(localState.fresh.id)) return 'fresh';
        return undefined;
      };

      const recordEvent = (event: ActivityEvent): void => {
        const id = String(event.activityId);
        const label = labelFor(id);
        if (label === undefined) {
          violation(`unexpected M36 activity ${id}`);
          return;
        }
        if (label === 'target') {
          currentProof.targetEventsReturned += 1;
          violation(`poll-fault target event reached World polling: ${event.type}`);
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
        currentProof.acceptedTerminalCount += 1;
        currentProof.authoritativeMutationCount += 1;
        currentProof.authoritativeOutputs[id] = event.output;
        if (label === 'survivor') localState.survivorCompleted = true;
        if (label === 'fresh') localState.freshCompleted = true;
      };

      const markPollFault = (outcome: 'closed' | 'threw', result: unknown): void => {
        if (localState.faultAttempted) return;
        localState.faultAttempted = true;
        localState.phase = 'await-host-close';
        if (clientTraceB.faultOutcome === null) {
          clientTraceB.faultOutcome = outcome;
          clientTraceB.faultResult = result;
        }
        post('poll-fault-contained', {
          outcome: clientTraceB.faultOutcome,
          result: clientTraceB.faultResult,
          falsify,
          stagedEventObserved: clientTraceB.stagedEventObserved,
        });
      };

      const probeAfterFault = (): void => {
        if (
          localState.faultProbeDone ||
          hostCloseDetail === undefined ||
          localState.target === undefined ||
          (falsify ? legacyPollClient === undefined : providerBClient === undefined)
        ) {
          return;
        }
        localState.postFaultProbe = true;
        const activityIdentityCallsBefore = clientTraceB.activityIdentityCalls;
        const sessionIdentityCallsBefore = clientTraceB.sessionIdentityCalls;
        const commandCountBefore = clientTraceB.commandKinds.length;
        let submitAfterFault: unknown;
        let cancelAfterFault: unknown;
        let pollAfterFault: readonly ActivityEvent[] = [];
        let stagedEventCountAfterFault = 0;
        let pollPendingAfterFault = false;
        if (falsify) {
          const legacy = legacyPollClient;
          if (legacy === undefined) {
            fail('M36 legacy poll falsifier client disappeared before probe');
          } else {
            const afterRef = createLegacyRef(clientTraceB);
            legacy.submit(afterRef);
            submitAfterFault = { ok: true };
            legacy.cancel(localState.target.id);
            cancelAfterFault = { ok: true };
            pollAfterFault = [...legacy.poll()];
            stagedEventCountAfterFault = legacy.received.length;
            pollPendingAfterFault = legacy.pollPending;
          }
        } else {
          const client = providerBClient;
          if (client === undefined) {
            fail('M36 provider-B client disappeared before probe');
          } else {
            try {
              submitAfterFault = client.submit({ input: 'after-fault' });
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
          clientTraceB.faultOutcome === 'closed' &&
          clientTraceB.faultPollAttempts === 1 &&
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
          clientTraceB.faultOutcome === 'threw' &&
          clientTraceB.faultPollAttempts === 1 &&
          clientTraceB.faultStagedEventCountBefore === 1 &&
          clientTraceB.faultStagedEventCountAfter === 0 &&
          clientTraceB.faultPollPendingAfter === true &&
          clientTraceB.removeListenerCalls === 0 &&
          clientTraceB.physicalCloseCalls === 0 &&
          clientTraceB.postFaultCommands.join('|') === 'intelligence-submit|intelligence-cancel' &&
          clientTraceB.activityIdentityCalls > activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls > sessionIdentityCallsBefore &&
          stagedEventCountAfterFault === 0 &&
          pollPendingAfterFault === true &&
          legacyPollClient?.active.size === 2;
        if (!falsify && !normalClientState) fail('M36 poll fault did not contain the client state');
        if (falsify && falsifierState) {
          localState.falsifierReason =
            'uncontained poll fault removed the staged event before a throwing post and left poll credit, identity, listener, and port open';
          post('falsifier-caught', { reason: localState.falsifierReason });
        } else if (falsify) {
          fail('M36 poll fault falsifier did not expose staged-event and poll-credit loss');
        }
        if (!falsify && providerBClient !== undefined) {
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
          uncontainedActiveCount: legacyPollClient?.active.size ?? 0,
          stagedEventCountAfterFault,
          pollPendingAfterFault,
        };
        localState.faultProbeDone = true;
        post('fault-probed', {
          probe: localState.probe,
          clientTrace: { ...clientTraceB, postFaultCommands: [...clientTraceB.postFaultCommands] },
        });
        evidencePort?.postMessage({ kind: 'm36-fresh-port-request' });
        localState.phase = 'await-fresh-port';
        post('fresh-port-requested', { retainedSession: localState.retainedSession });
      };

      const finish = (): void => {
        if (localState.phase === 'finished') return;
        const survivor = localState.survivor;
        const target = localState.target;
        const fresh = localState.fresh;
        const normalComplete =
          localState.failure === undefined &&
          localState.falsifierReason === undefined &&
          hostCloseDetail?.origin === 'host-binding.after-poll-command-fault' &&
          hostCloseDetail.pollOutstandingAtClose === 0 &&
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          !hostCloseDetail.notificationSuppressed &&
          localState.hostCloseObserved &&
          localState.faultProbeDone &&
          localState.survivorCompleted &&
          localState.freshCompleted &&
          survivor !== undefined &&
          target !== undefined &&
          fresh !== undefined &&
          localState.retainedSession !== undefined &&
          clientTraceB.stagedEventObserved &&
          currentProof.preTerminalMutationAttempts === 2 &&
          currentProof.prematureMutationCount === 0 &&
          currentProof.acceptedTerminalCount === 2 &&
          currentProof.authoritativeMutationCount === 2 &&
          currentProof.targetEventsReturned === 0 &&
          currentProof.pendingText[String(survivor.id)] === 'survivor:' &&
          currentProof.pendingText[String(fresh.id)] === 'fresh:' &&
          currentProof.authoritativeOutputs[String(survivor.id)] === 'survivor-ok' &&
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
            providerA: clientTraceA.closePromiseSame,
            providerC: clientTraceC.closePromiseSame,
          },
          providerBClientClose: falsify ? 'falsifier-uncontained' : 'settled-after-poll-fault',
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
        const bReady = falsify ? legacyPollClient !== undefined : providerBClient !== undefined;
        if (localState.phase === 'wait-provider-b' && bReady) {
          const survivor = submit(clientA, 'survivor');
          if (survivor === undefined) return;
          let target: ActivityRef | undefined;
          if (falsify) {
            const legacy = legacyPollClient;
            if (legacy === undefined) {
              fail('M36 legacy poll falsifier client was not ready');
              return;
            }
            target = createLegacyRef(clientTraceB);
            legacy.submit(target);
          } else if (providerBClient !== undefined) {
            target = submit(providerBClient, 'poll-fault-target');
          }
          if (target === undefined) {
            fail('M36 initial activity roster did not admit survivor and poll-fault target');
            return;
          }
          localState.survivor = survivor;
          localState.target = target;
          localState.retainedSession = target.session;
          clientA.poll();
          if (falsify) legacyPollClient?.poll();
          else providerBClient?.poll();
          localState.phase = 'await-poll-fault';
          post('initial-submitted', {
            survivorId: String(survivor.id),
            targetId: String(target.id),
            retainedSession: target.session,
            maxPollEvents: M36_LIMITS.maxPollEvents,
            pollCreditGranted: true,
          });
          return;
        }
        if (localState.phase === 'await-host-close' && localState.hostCloseObserved) {
          localState.phase = 'await-fault-probe';
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-fault-probe' && localState.hostCloseObserved) {
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-fresh-port' && providerCClient !== undefined) {
          if (localState.retainedSession === undefined) {
            fail('M36 fresh client arrived without the retained SessionRef');
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
          localState.freshCompleted &&
          localState.faultProbeDone
        ) {
          finish();
        }
      };

      const system = {
        name: 'm36-intelligence-worker-consumer',
        queries: [],
        fn(): void {
          if (localState.phase === 'finished') return;
          localState.frameCount += 1;
          const bReady = falsify ? legacyPollClient !== undefined : providerBClient !== undefined;
          if (localState.phase === 'wait-provider-b' && bReady) {
            drive();
            return;
          }
          for (const event of clientA.poll()) recordEvent(event);
          if (!falsify && providerBClient !== undefined && !localState.faultAttempted) {
            try {
              for (const event of providerBClient.poll()) recordEvent(event);
            } catch (cause) {
              fail(`M36 contained Worker poll unexpectedly threw: ${summarizeCause(cause)}`);
            }
            if (clientTraceB.faultThrowInjected) {
              clientTraceB.faultOutcome = 'closed';
              clientTraceB.faultResult = { ok: false, error: { code: 'intelligence-closed' } };
              markPollFault('closed', clientTraceB.faultResult);
            }
          }
          if (falsify && legacyPollClient !== undefined && !localState.faultAttempted) {
            try {
              for (const event of legacyPollClient.poll()) recordEvent(event);
            } catch (cause) {
              markPollFault('threw', { ok: false, threw: summarizeCause(cause) });
            }
          }
          if (providerCClient !== undefined) {
            for (const event of providerCClient.poll()) recordEvent(event);
          }
          if (localState.frameCount > 300 && localState.phase !== 'finished') {
            fail('M36 poll command fault recovery did not settle within the frame budget');
          }
          drive();
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm36/intelligence-system',
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
      }, 'm36/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

export default bootstrap;
