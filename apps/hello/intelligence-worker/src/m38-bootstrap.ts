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
import { M38_LIMITS, M38_PROVIDER_A_ID, M38_PROVIDER_B_ID, M38_PROVIDER_C_ID } from './m38-provider';

interface M38HostCloseDetail {
  readonly origin: 'host-binding.after-poll-response-fault';
  readonly faultOutcome: 'contained' | 'escaped';
  readonly activeCountBeforeCleanup: number | null;
  readonly activeCountAtClose: number | null;
  readonly hostCloseSettled: boolean;
  readonly hostCloseRejected: boolean;
  readonly physicalCloseCalls: number;
  readonly pollResponseFaultAttempts: number;
  readonly nonEmptyPollResponses: number;
}

interface M38ClientTrace {
  readonly commandKinds: string[];
  readonly postFaultCommands: string[];
  readonly targetId: string | null;
  activityIdentityCalls: number;
  sessionIdentityCalls: number;
  pollAttempts: number;
  pollOutcome: 'closed' | 'threw' | 'ok' | null;
  pollResult: unknown;
  stagedEventObserved: boolean;
  stagedEventCountAtResponse: number;
  closedObserved: boolean;
  removeListenerCalls: number;
  physicalCloseCalls: number;
  closePromiseSame: boolean | null;
}

interface M38Probe {
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

interface M38Proof {
  readonly pendingText: Record<string, string>;
  readonly perActivitySequences: Record<string, number[]>;
  readonly authoritativeOutputs: Record<string, string>;
  preTerminalMutationAttempts: number;
  authoritativeMutationCount: number;
  targetEventsReturned: number;
}

type M38Phase =
  | 'wait-provider-b'
  | 'await-control'
  | 'await-poll-response-fault'
  | 'await-fault-probe'
  | 'await-host-close'
  | 'await-fresh'
  | 'await-completions'
  | 'finished'
  | 'failed';

interface M38State {
  phase: M38Phase;
  frameCount: number;
  control?: ActivityRef;
  target?: ActivityRef;
  fresh?: ActivityRef;
  retainedSession?: ActivityRef['session'];
  controlCompleted: boolean;
  freshCompleted: boolean;
  pollRequested: boolean;
  faultObserved: boolean;
  hostCloseObserved: boolean;
  probeDone: boolean;
  postFaultProbe: boolean;
  probe?: M38Probe;
  failure?: string;
  falsifierReason?: string;
}

interface ClientPortOptions {
  readonly postFault?: () => boolean;
  readonly onClosed?: () => void;
}

interface M38LegacyClient {
  readonly active: Set<ActivityId>;
  readonly received: ActivityEvent[];
  readonly pollPending: boolean;
  submit(ref: ActivityRef, input: string): void;
  poll(): readonly ActivityEvent[];
  close(): void;
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
  let legacyClient: M38LegacyClient | undefined;
  let providerCClient: IntelligencePortClient | undefined;
  let hostCloseDetail: M38HostCloseDetail | undefined;
  let state: M38State | undefined;
  let onPollFault:
    | ((outcome: 'closed' | 'threw', result: unknown) => void)
    | undefined;

  const clientTraceA = createClientTrace();
  const clientTraceB = createClientTrace();
  const clientTraceC = createClientTrace();

  const post = (event: string, detail: Record<string, unknown> = {}): void => {
    evidencePort?.postMessage({ kind: 'm38-worker-event', event, detail });
  };

  const wrapClientPort = (
    port: MessagePort,
    trace: M38ClientTrace,
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
          if (message.kind === 'intelligence-closed') {
            trace.closedObserved = true;
            options.onClosed?.();
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
    trace: M38ClientTrace,
    prefix: string,
  ): IntelligencePortClient =>
    createIntelligencePortClient(providerId, port, {
      limits: M38_LIMITS,
      createActivityId: () => {
        trace.activityIdentityCalls += 1;
        return activityId(`m38-worker-${prefix}-${state?.frameCount ?? 0}-${trace.activityIdentityCalls}`);
      },
      createSessionId: () => {
        trace.sessionIdentityCalls += 1;
        return `m38-worker-session-${prefix}-${trace.sessionIdentityCalls}`;
      },
    });

  const postLegacy = (
    port: MessagePort,
    trace: M38ClientTrace,
    message: IntelligenceHostCommand,
  ): void => {
    trace.commandKinds.push(message.kind);
    if (state?.postFaultProbe === true) trace.postFaultCommands.push(message.kind);
    port.postMessage(message);
  };

  const createLegacyClient = (port: MessagePort, trace: M38ClientTrace): M38LegacyClient => {
    let received: ActivityEvent[] = [];
    let pollPending = false;
    let closed = false;
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
      if (value.events.length > 0) {
        trace.stagedEventObserved = true;
        trace.stagedEventCountAtResponse = value.events.length;
      }
      received = [...received, ...value.events];
      for (const eventValue of value.events) {
        if (eventValue.type !== 'text-delta') active.delete(eventValue.activityId);
      }
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
        postLegacy(port, trace, { kind: 'intelligence-submit', submission: { ...ref, input } });
      },
      poll(): readonly ActivityEvent[] {
        const events = received.splice(0, M38_LIMITS.maxPollEvents);
        if (!pollPending && !closed) {
          pollPending = true;
          postLegacy(port, trace, { kind: 'intelligence-poll', maxEvents: M38_LIMITS.maxPollEvents });
        }
        return events;
      },
      close(): void {
        if (closed) return;
        closed = true;
        port.removeEventListener('message', listener);
        port.close();
      },
    };
  };

  const servicePlugin: Plugin = {
    name: 'm38-intelligence-worker-services',
    inject: ['executionBootstrapHost'],
    provide: 'intelligence',
    apply(ctx) {
      const host = ctx.executionBootstrapHost as ExecutionBootstrapHost;
      const port = host.port;
      if (port === undefined) throw new Error('M38 requires execution.bootstrapPort in the Worker');
      evidencePort = port;
      const setupListener = (event: MessageEvent<unknown>): void => {
        const message = event.data;
        if (typeof message !== 'object' || message === null) return;
        const value = message as {
          readonly kind?: unknown;
          readonly port?: unknown;
          readonly origin?: unknown;
          readonly faultOutcome?: unknown;
          readonly activeCountBeforeCleanup?: unknown;
          readonly activeCountAtClose?: unknown;
          readonly hostCloseSettled?: unknown;
          readonly hostCloseRejected?: unknown;
          readonly physicalCloseCalls?: unknown;
          readonly pollResponseFaultAttempts?: unknown;
          readonly nonEmptyPollResponses?: unknown;
          readonly activeCountAtFault?: unknown;
        };
        if (value.kind === 'm38-provider-b-port' && isMessagePort(value.port)) {
          if (providerBClient !== undefined || legacyClient !== undefined) return;
          if (falsify) {
            legacyClient = createLegacyClient(value.port, clientTraceB);
          } else {
            providerBClient = createClient(
              M38_PROVIDER_B_ID,
              wrapClientPort(value.port, clientTraceB, {
                onClosed: () => {
                  onPollFault?.('closed', { ok: false, error: { code: 'intelligence-closed' } });
                },
              }),
              clientTraceB,
              'b',
            );
          }
          return;
        }
        if (
          value.kind === 'm38-host-poll-response-fault-escaped' &&
          typeof value.activeCountAtFault === 'number' &&
          typeof value.nonEmptyPollResponses === 'number'
        ) {
          onPollFault?.('threw', {
            ok: false,
            threw: 'M38 uncontained Host poll response publication failure',
            activeCountAtFault: value.activeCountAtFault,
            nonEmptyPollResponses: value.nonEmptyPollResponses,
          });
          return;
        }
        if (
          value.kind === 'm38-host-binding-closed' &&
          value.origin === 'host-binding.after-poll-response-fault' &&
          (value.faultOutcome === 'contained' || value.faultOutcome === 'escaped') &&
          (typeof value.activeCountBeforeCleanup === 'number' || value.activeCountBeforeCleanup === null) &&
          (typeof value.activeCountAtClose === 'number' || value.activeCountAtClose === null) &&
          typeof value.hostCloseSettled === 'boolean' &&
          typeof value.hostCloseRejected === 'boolean' &&
          typeof value.physicalCloseCalls === 'number' &&
          typeof value.pollResponseFaultAttempts === 'number' &&
          typeof value.nonEmptyPollResponses === 'number'
        ) {
          hostCloseDetail = {
            origin: value.origin,
            faultOutcome: value.faultOutcome,
            activeCountBeforeCleanup: value.activeCountBeforeCleanup,
            activeCountAtClose: value.activeCountAtClose,
            hostCloseSettled: value.hostCloseSettled,
            hostCloseRejected: value.hostCloseRejected,
            physicalCloseCalls: value.physicalCloseCalls,
            pollResponseFaultAttempts: value.pollResponseFaultAttempts,
            nonEmptyPollResponses: value.nonEmptyPollResponses,
          };
          if (state !== undefined) state.hostCloseObserved = true;
          post('host-binding-closed-observed', { hostClose: hostCloseDetail });
          return;
        }
        if (value.kind === 'm38-fresh-port' && isMessagePort(value.port)) {
          if (providerCClient !== undefined) return;
          providerCClient = createClient(
            M38_PROVIDER_C_ID,
            wrapClientPort(value.port, clientTraceC),
            clientTraceC,
            'c',
          );
        }
      };
      port.addEventListener('message', setupListener);
      const clientA = createClient(M38_PROVIDER_A_ID, wrapClientPort(port, clientTraceA), clientTraceA, 'a');
      ctx.provide('intelligence', clientA);
      ctx.effect(
        () => () => {
          port.removeEventListener('message', setupListener);
          const closes = [clientA.close()];
          if (providerCClient !== undefined) closes.push(providerCClient.close());
          return Promise.all(closes).then(() => undefined);
        },
        'm38/intelligence-services',
      );
    },
  };

  const consumerPlugin: Plugin = {
    name: 'm38-intelligence-worker-consumer',
    inject: ['world', 'intelligence'],
    apply(ctx) {
      const world = ctx.world;
      const clientA = ctx.intelligence as IntelligencePortClient | undefined;
      if (clientA === undefined) throw new Error('M38 control intelligence service was not provided');
      const currentProof: M38Proof = {
        pendingText: {},
        perActivitySequences: {},
        authoritativeOutputs: {},
        preTerminalMutationAttempts: 0,
        authoritativeMutationCount: 0,
        targetEventsReturned: 0,
      };
      const localState: M38State = {
        phase: 'wait-provider-b',
        frameCount: 0,
        controlCompleted: false,
        freshCompleted: false,
        pollRequested: false,
        faultObserved: false,
        hostCloseObserved: false,
        probeDone: false,
        postFaultProbe: false,
      };
      state = localState;
      world.insertResource('m38IntelligenceProof', currentProof);

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
          violation(`poll target event reached World polling: ${event.type}`);
          return;
        }
        const label =
          localState.control !== undefined && id === String(localState.control.id)
            ? 'control'
            : localState.fresh !== undefined && id === String(localState.fresh.id)
              ? 'fresh'
              : undefined;
        if (label === undefined) {
          violation(`unexpected M38 activity ${id}`);
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
        if (label === 'control') {
          localState.controlCompleted = true;
          localState.retainedSession = event.session;
        }
        if (label === 'fresh') localState.freshCompleted = true;
      };

      const createLegacyRef = (): ActivityRef => {
        clientTraceB.activityIdentityCalls += 1;
        clientTraceB.sessionIdentityCalls += 1;
        return {
          id: activityId(`m38-uncontained-${localState.frameCount}-${clientTraceB.activityIdentityCalls}`),
          session: {
            providerId: M38_PROVIDER_B_ID,
            id: `m38-worker-session-b-${clientTraceB.sessionIdentityCalls}`,
          },
        };
      };

      const probeAfterFault = (): void => {
        if (
          localState.probeDone ||
          !localState.faultObserved ||
          !localState.hostCloseObserved && !falsify ||
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
        let cancelAfterFault: unknown = { ok: false, skipped: true };
        let pollAfterFault: readonly ActivityEvent[] = [];
        if (falsify) {
          const legacy = legacyClient;
          if (legacy === undefined) {
            fail('M38 legacy poll falsifier disappeared before probe');
          } else {
            try {
              legacy.submit(createLegacyRef(), 'after-poll-fault');
              submitAfterFault = { ok: true };
            } catch (cause) {
              submitAfterFault = { threw: summarizeCause(cause) };
            }
            try {
              pollAfterFault = [...legacy.poll()];
            } catch (cause) {
              violation(`M38 falsifier poll unexpectedly threw: ${summarizeCause(cause)}`);
            }
          }
        } else {
          const client = providerBClient;
          if (client === undefined) {
            fail('M38 provider-B client disappeared before probe');
          } else {
            try {
              submitAfterFault = client.submit({ input: 'after-poll-fault' });
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
          clientTraceB.pollOutcome === 'closed' &&
          clientTraceB.closedObserved &&
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
          clientTraceB.pollOutcome === 'threw' &&
          !clientTraceB.closedObserved &&
          clientTraceB.postFaultCommands.join('|') === 'intelligence-submit' &&
          clientTraceB.activityIdentityCalls > activityIdentityCallsBefore &&
          clientTraceB.sessionIdentityCalls > sessionIdentityCallsBefore &&
          (legacyClient?.active.size ?? 0) >= 2 &&
          stagedEventCountBeforeProbe === 0 &&
          (legacyClient?.pollPending ?? false);
        if (!falsify && !normalClientState) fail('M38 poll response fault did not contain the client state');
        if (falsify && falsifierState) {
          localState.falsifierReason =
            'uncontained Host poll response fault lost the drained event while the Host listener, runtime, active work, and poll credit remained live';
          post('falsifier-caught', { reason: localState.falsifierReason });
        } else if (falsify) {
          fail('M38 poll response fault falsifier did not expose the uncontained Host state');
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
          clientTrace: {
            ...clientTraceB,
            postFaultCommands: [...clientTraceB.postFaultCommands],
          },
        });
        if (falsify) {
          post('host-cleanup-request', { reason: 'falsifier probe captured leaked Host authority' });
          localState.phase = 'await-host-close';
        } else {
          evidencePort?.postMessage({ kind: 'm38-fresh-port-request' });
          localState.phase = 'await-fresh';
          post('fresh-port-requested', { retainedSession: localState.retainedSession });
        }
      };

      onPollFault = (outcome, result): void => {
        if (localState.faultObserved) return;
        localState.faultObserved = true;
        clientTraceB.pollAttempts += 1;
        clientTraceB.pollOutcome = outcome;
        clientTraceB.pollResult = result;
        localState.phase = falsify ? 'await-fault-probe' : 'await-host-close';
        post(outcome === 'closed' ? 'poll-response-fault-contained' : 'poll-response-fault-escaped', {
          outcome,
          result,
          targetId: localState.target === undefined ? null : String(localState.target.id),
          drainedEventDelivered: clientTraceB.stagedEventObserved,
        });
      };

      const finish = (): void => {
        if (localState.phase === 'finished') return;
        const control = localState.control;
        const target = localState.target;
        const fresh = localState.fresh;
        const normalComplete =
          localState.failure === undefined &&
          localState.falsifierReason === undefined &&
          hostCloseDetail?.origin === 'host-binding.after-poll-response-fault' &&
          hostCloseDetail.faultOutcome === 'contained' &&
          hostCloseDetail.hostCloseSettled &&
          !hostCloseDetail.hostCloseRejected &&
          hostCloseDetail.physicalCloseCalls === 1 &&
          hostCloseDetail.pollResponseFaultAttempts === 1 &&
          hostCloseDetail.nonEmptyPollResponses === 1 &&
          localState.hostCloseObserved &&
          localState.probeDone &&
          localState.controlCompleted &&
          localState.freshCompleted &&
          control !== undefined &&
          target !== undefined &&
          fresh !== undefined &&
          localState.retainedSession !== undefined &&
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
        legacyClient?.close();
        post('cleanup-requested', {
          clientClosePromiseSame: {
            providerA: closeA === closeAAgain,
            providerC: closeC !== undefined && closeC === closeCAgain,
          },
          providerBClientClose: falsify ? 'explicit-after-falsifier-probe' : 'closed-on-host-fault',
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
          localState.control = control;
          localState.phase = 'await-control';
          post('control-submitted', { controlId: String(control.id), maxPollEvents: M38_LIMITS.maxPollEvents });
          return;
        }
        if (localState.phase === 'await-control' && localState.controlCompleted) {
          if (localState.retainedSession === undefined) {
            fail('M38 control completed without a retained SessionRef');
            return;
          }
          let target: ActivityRef | undefined;
          if (falsify) {
            const legacy = legacyClient;
            if (legacy === undefined) {
              fail('M38 legacy poll falsifier was not ready');
              return;
            }
            target = createLegacyRef();
            legacy.submit(target, 'poll-target');
          } else if (providerBClient !== undefined) {
            target = submit(providerBClient, 'poll-target');
          }
          if (target === undefined) {
            fail('M38 poll target was not admitted');
            return;
          }
          localState.target = target;
          clientTraceB.targetId = String(target.id);
          clientA.poll();
          if (falsify) legacyClient?.poll();
          else providerBClient?.poll();
          localState.pollRequested = true;
          localState.phase = 'await-poll-response-fault';
          post('target-submitted', {
            targetId: String(target.id),
            retainedSession: localState.retainedSession,
            secondActivityStarted: true,
            maxPollEvents: M38_LIMITS.maxPollEvents,
          });
          return;
        }
        if (localState.phase === 'await-fault-probe') {
          probeAfterFault();
          return;
        }
        if (
          (localState.phase === 'await-host-close' || localState.phase === 'await-poll-response-fault') &&
          localState.faultObserved &&
          localState.hostCloseObserved &&
          !localState.probeDone
        ) {
          probeAfterFault();
          return;
        }
        if (localState.phase === 'await-host-close' && localState.probeDone && hostCloseDetail !== undefined) {
          evidencePort?.postMessage({ kind: 'm38-fresh-port-request' });
          localState.phase = 'await-fresh';
          post('fresh-port-requested', { retainedSession: localState.retainedSession });
          return;
        }
        if (localState.phase === 'await-fresh' && providerCClient !== undefined) {
          if (localState.retainedSession === undefined) {
            fail('M38 fresh client arrived without retained SessionRef');
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
        name: 'm38-intelligence-worker-consumer',
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
          if (providerBClient !== undefined && localState.target !== undefined) {
            for (const event of providerBClient.poll()) recordEvent(event);
          }
          if (providerCClient !== undefined && localState.fresh !== undefined) {
            for (const event of providerCClient.poll()) recordEvent(event);
          }
          const phaseBeforeDrive = localState.phase;
          drive();
          if (
            localState.frameCount > 300 &&
            localState.phase !== 'finished' &&
            localState.failure === undefined &&
            localState.phase === phaseBeforeDrive
          ) {
            fail('M38 Host poll response fault recovery did not settle within the frame budget');
          }
        },
      };
      const update = world.scheduleToken('Update');
      world.addSystem(update, system).unwrap();
      ctx.effect(
        () => () => world.removeSystem(update, system.name),
        'm38/intelligence-system',
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
      }, 'm38/intelligence-scene');
    },
  };

  return { plugins: [servicePlugin, consumerPlugin] };
};

function createClientTrace(): M38ClientTrace {
  return {
    commandKinds: [],
    postFaultCommands: [],
    targetId: null,
    activityIdentityCalls: 0,
    sessionIdentityCalls: 0,
    pollAttempts: 0,
    pollOutcome: null,
    pollResult: null,
    stagedEventObserved: false,
    stagedEventCountAtResponse: 0,
    closedObserved: false,
    removeListenerCalls: 0,
    physicalCloseCalls: 0,
    closePromiseSame: null,
  };
}

export default bootstrap;
