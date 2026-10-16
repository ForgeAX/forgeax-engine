import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  bindIntelligencePort,
  createIntelligenceRuntime,
  intelligenceFailure,
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  M38_LIMITS,
  M38_PROVIDER_A_ID,
  M38_PROVIDER_B_ID,
  M38_PROVIDER_C_ID,
  createM38Provider,
  type M38Provider,
} from './m38-provider';

const canvas = document.querySelector('#game');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
if (
  !(canvas instanceof HTMLCanvasElement) ||
  !(status instanceof HTMLElement) ||
  !(output instanceof HTMLElement)
) {
  throw new Error('M38 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM38Provider(M38_PROVIDER_A_ID);
const providerB = createM38Provider(M38_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M38PortTrace {
  readonly providerId: string;
  readonly submittedInputs: string[];
  readonly commandKinds: string[];
  readonly postCleanupHostCommands: string[];
  pollRequests: number;
  pollResponses: number;
  nonEmptyPollResponses: number;
  pollResponseFaultAttempts: number;
  pollResponseFaultInjected: boolean;
  activeCountAtFault: number | null;
  cancelRequests: number;
  closeMessages: number;
  listenerRemoveCalls: number;
  physicalCloseCalls: number;
}

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

interface HostBinding {
  close(): Promise<void>;
}

let traceC: M38PortTrace | undefined;
let providerC: M38Provider | undefined;
let bindingC: HostBinding | undefined;
let bindingB: HostBinding | undefined;
let app: ExecutionApp | undefined;
let hostCloseStarted = false;
let hostActiveCountBeforeCleanup: number | null = null;
let freshChannelCreated = false;
let finalizing = false;
let done = false;
let failure: unknown;
let workerResult: unknown;
let workerEvents: WorkerEvent[] = [];
let appReportBeforeStop: unknown;
let stopResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingCloseResults:
  | Record<string, { readonly first: unknown; readonly second: unknown }>
  | undefined;
let bindingClosePromiseSame: Record<string, boolean> | undefined;
let cleanupRequestedResolve: (() => void) | undefined;
const cleanupRequested = new Promise<void>((resolve) => {
  cleanupRequestedResolve = resolve;
});

const traceA = createTrace(M38_PROVIDER_A_ID);
const traceB = createTrace(M38_PROVIDER_B_ID);

const diagnostics = globalThis as {
  __forgeaxM38Done?: boolean;
  __forgeaxM38Report?: () => unknown;
};

function createTrace(providerId: string): M38PortTrace {
  return {
    providerId,
    submittedInputs: [],
    commandKinds: [],
    postCleanupHostCommands: [],
    pollRequests: 0,
    pollResponses: 0,
    nonEmptyPollResponses: 0,
    pollResponseFaultAttempts: 0,
    pollResponseFaultInjected: false,
    activeCountAtFault: null,
    cancelRequests: 0,
    closeMessages: 0,
    listenerRemoveCalls: 0,
    physicalCloseCalls: 0,
  };
}

function summarizeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return String(error);
  const value = error as { readonly code?: unknown; readonly name?: unknown; readonly message?: unknown };
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    message: typeof value.message === 'string' ? value.message : String(error),
  };
}

function resultSummary(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  return value.ok === true ? { ok: true } : { ok: false, error: summarizeError(value.error) };
}

function providerReport(provider: M38Provider): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M38PortTrace | undefined): unknown {
  if (trace === undefined) return null;
  return {
    ...trace,
    submittedInputs: [...trace.submittedInputs],
    commandKinds: [...trace.commandKinds],
    postCleanupHostCommands: [...trace.postCleanupHostCommands],
  };
}

function report(): unknown {
  return {
    falsify,
    done,
    failure: failure === undefined ? null : summarizeError(failure),
    appReport: app?.execution.report() ?? null,
    appReportBeforeStop,
    ports: {
      providerA: portReport(traceA),
      providerB: portReport(traceB),
      providerC: portReport(traceC),
    },
    providerA: providerReport(providerA),
    providerB: providerReport(providerB),
    providerC: providerC === undefined ? null : providerReport(providerC),
    workerResult,
    workerEvents,
    stopResults,
    bindingCloseResults,
    bindingClosePromiseSame,
    freshChannelCreated,
  };
}

function publish(): void {
  output.textContent = JSON.stringify(report(), null, 2);
  const result = workerResult as { readonly ok?: unknown; readonly falsifierCaught?: unknown } | undefined;
  if (failure !== undefined) {
    status.dataset.status = 'failed';
    status.textContent = 'M38 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M38 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M38 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M38 Engine Worker running';
  }
  diagnostics.__forgeaxM38Done = done;
}

function createHostPort(
  rawPort: MessagePort,
  trace: M38PortTrace,
  options: {
    readonly injectPollResponseFault?: boolean;
    readonly onPollResponseFault?: () => void;
    readonly activeCount?: () => number;
  } = {},
): IntelligenceMessagePort {
  return {
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind === 'intelligence-events') {
        trace.pollResponses += 1;
        if (message.events.length > 0) {
          trace.nonEmptyPollResponses += 1;
          if (options.injectPollResponseFault === true && !trace.pollResponseFaultInjected) {
            trace.pollResponseFaultAttempts += 1;
            trace.pollResponseFaultInjected = true;
            trace.activeCountAtFault = options.activeCount?.() ?? null;
            options.onPollResponseFault?.();
            throw new Error('M38 injected synchronous Host poll response publication failure');
          }
        }
      } else if (message.kind === 'intelligence-cancel') {
        trace.cancelRequests += 1;
      } else if (message.kind === 'intelligence-closed') {
        trace.closeMessages += 1;
      }
      rawPort.postMessage(message);
    },
    addEventListener(type, listener): void {
      rawPort.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type, listener): void {
      trace.listenerRemoveCalls += 1;
      rawPort.removeEventListener(type, listener as EventListener);
    },
    start(): void {
      rawPort.start();
    },
    close(): void {
      trace.physicalCloseCalls += 1;
      rawPort.close();
    },
  };
}

function publishHostCloseDetail(): void {
  rawPortA.postMessage({
    kind: 'm38-host-binding-closed',
    origin: 'host-binding.after-poll-response-fault',
    faultOutcome: falsify ? 'escaped' : 'contained',
    activeCountBeforeCleanup: hostActiveCountBeforeCleanup ?? traceB.activeCountAtFault,
    activeCountAtClose: providerB.trace.activeCountAtClose,
    hostCloseSettled: true,
    hostCloseRejected: false,
    physicalCloseCalls: traceB.physicalCloseCalls,
    pollResponseFaultAttempts: traceB.pollResponseFaultAttempts,
    nonEmptyPollResponses: traceB.nonEmptyPollResponses,
  });
}

function startTargetHostCleanup(): void {
  if (hostCloseStarted) return;
  hostCloseStarted = true;
  hostActiveCountBeforeCleanup = falsify ? providerB.activeCount : null;
  const currentBinding = bindingB;
  if (currentBinding === undefined) {
    failure = new Error('M38 provider-B binding was not installed before poll fault cleanup');
    publish();
    return;
  }
  void currentBinding.close().then(
    publishHostCloseDetail,
    () => publishHostCloseDetail(),
  );
}

function createLegacyHostBinding(
  port: IntelligenceMessagePort,
  runtime: ReturnType<typeof createIntelligenceRuntime>,
): HostBinding {
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const listener = (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>): void => {
    if (closed) return;
    const message = event.data;
    if (message.kind === 'intelligence-submit') {
      const accepted = runtime.accept(message.submission);
      if (!accepted.ok) {
        port.postMessage({
          kind: 'intelligence-rejected',
          activityId: message.submission.id,
          error: {
            code: accepted.error.code,
            expected: accepted.error.expected,
            hint: accepted.error.hint,
            detail: intelligenceFailure(accepted.error).detail,
          },
        });
      }
      return;
    }
    if (message.kind === 'intelligence-poll') {
      // This is intentionally the pre-M38 uncontained implementation used only
      // by the headed falsifier: poll drains before the response can throw.
      port.postMessage({ kind: 'intelligence-events', events: runtime.poll(message.maxEvents) });
      return;
    }
    if (message.kind === 'intelligence-cancel') {
      runtime.cancel(message.activityId);
      return;
    }
    if (message.kind === 'intelligence-close') void close();
  };
  const close = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask;
    closed = true;
    port.removeEventListener('message', listener);
    closeTask = (async () => {
      await runtime.close();
      try {
        port.postMessage({ kind: 'intelligence-closed' });
      } catch {
        // The falsifier still gives explicit cleanup a physical release.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      port.close();
    })();
    return closeTask;
  };
  port.addEventListener('message', listener);
  port.start?.();
  return { close };
}

function createFreshBinding(): void {
  if (providerC !== undefined) return;
  freshChannelCreated = true;
  providerC = createM38Provider(M38_PROVIDER_C_ID);
  const channelC = new MessageChannel();
  traceC = createTrace(M38_PROVIDER_C_ID);
  const hostPort = createHostPort(channelC.port1, traceC);
  bindingC = bindIntelligencePort(
    hostPort,
    createIntelligenceRuntime(providerC, { limits: M38_LIMITS }),
  );
  observePort(channelC.port1, traceC);
  rawPortA.postMessage({ kind: 'm38-fresh-port', port: channelC.port2 }, [channelC.port2]);
}

function observePort(rawPort: MessagePort, trace: M38PortTrace, eventKind?: string): void {
  rawPort.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (typeof message !== 'object' || message === null) return;
    const value = message as {
      readonly kind?: unknown;
      readonly event?: unknown;
      readonly detail?: unknown;
      readonly submission?: { readonly input?: unknown };
    };
    if (
      value.kind === 'intelligence-submit' ||
      value.kind === 'intelligence-poll' ||
      value.kind === 'intelligence-cancel' ||
      value.kind === 'intelligence-close'
    ) {
      const kind = String(value.kind);
      trace.commandKinds.push(kind);
      if (hostCloseStarted && trace === traceB) trace.postCleanupHostCommands.push(kind);
    }
    if (value.kind === 'intelligence-submit') {
      const input = value.submission?.input;
      if (typeof input === 'string') trace.submittedInputs.push(input);
      return;
    }
    if (value.kind === 'intelligence-poll') {
      trace.pollRequests += 1;
      return;
    }
    if (eventKind !== undefined && value.kind === eventKind && typeof value.event === 'string') {
      workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
      if (value.event === 'worker-finished') {
        workerResult = value.detail;
        publish();
      }
      if (value.event === 'poll-response-fault-contained') startTargetHostCleanup();
      if (value.event === 'host-cleanup-request') startTargetHostCleanup();
      if (value.event === 'cleanup-requested') {
        cleanupRequestedResolve?.();
        void finalize().catch((cause: unknown) => {
          failure = cause;
          done = true;
          publish();
        });
      }
    }
    if (value.kind === 'm38-fresh-port-request') createFreshBinding();
  });
  rawPort.start();
}

const hostPortA = createHostPort(rawPortA, traceA);
const hostPortB = createHostPort(rawPortB, traceB, {
  injectPollResponseFault: true,
  activeCount: () => providerB.activeCount,
  onPollResponseFault: falsify
    ? () => {
        queueMicrotask(() =>
          rawPortA.postMessage({
            kind: 'm38-host-poll-response-fault-escaped',
            activeCountAtFault: providerB.activeCount,
            nonEmptyPollResponses: traceB.nonEmptyPollResponses,
          }),
        );
      }
    : undefined,
});
observePort(rawPortA, traceA, 'm38-worker-event');
observePort(rawPortB, traceB);

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M38_LIMITS }),
);
const runtimeB = createIntelligenceRuntime(providerB, { limits: M38_LIMITS });
bindingB = falsify ? createLegacyHostBinding(hostPortB, runtimeB) : bindIntelligencePort(hostPortB, runtimeB);

async function closeBindings(): Promise<void> {
  const firstA = bindingA.close();
  const secondA = bindingA.close();
  const firstB = bindingB?.close() ?? Promise.resolve();
  const secondB = bindingB?.close() ?? Promise.resolve();
  const firstC = bindingC?.close() ?? Promise.resolve();
  const secondC = bindingC?.close() ?? Promise.resolve();
  bindingClosePromiseSame = {
    providerA: firstA === secondA,
    providerB: firstB === secondB,
    providerC: firstC === secondC,
  };
  await Promise.all([firstA, secondA, firstB, secondB, firstC, secondC]);
  bindingCloseResults = {
    providerA: { first: { ok: true }, second: { ok: true } },
    providerB: { first: { ok: true }, second: { ok: true } },
    providerC: { first: { ok: true }, second: { ok: true } },
  };
}

async function finalize(): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  await cleanupRequested;
  if (app !== undefined) {
    appReportBeforeStop = app.execution.report();
    const firstStop = app.stop();
    const secondStop = app.stop();
    stopResults = { first: resultSummary(firstStop), second: resultSummary(secondStop) };
  }
  await closeBindings();
  await providerB.waitForLateCallbacks();
  done = true;
  publish();
}

diagnostics.__forgeaxM38Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m38-bootstrap.js', location.href);
  const created = await createApp(
    canvas,
    {
      execution: {
        workers: { engine: true, render: false, kernels: false },
        bootstrap,
        bootstrapData: { falsify },
        bootstrapPort: channelA.port2,
        startupTimeoutMs: 15_000,
        frameTimeoutMs: 5_000,
      },
    },
    forgeaxBundlerAdapter(),
  );
  if (!created.ok) {
    failure = created.error;
    await closeBindings();
    done = true;
    publish();
    return;
  }
  app = created.value;
  const started = app.start();
  if (!started.ok) {
    failure = started.error;
    await closeBindings();
    done = true;
    publish();
    return;
  }
  rawPortA.postMessage({ kind: 'm38-provider-b-port', port: channelB.port2 }, [channelB.port2]);
  publish();
}

start().catch((cause: unknown) => {
  failure = cause;
  void closeBindings().then(
    () => {
      done = true;
      publish();
    },
    (closeError: unknown) => {
      failure = closeError;
      done = true;
      publish();
    },
  );
});
