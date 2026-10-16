import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  bindIntelligencePort,
  createIntelligenceRuntime,
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligencePortBinding,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  M33_LIMITS,
  M33_PROVIDER_A_ID,
  M33_PROVIDER_B_ID,
  M33_PROVIDER_C_ID,
  createM33Provider,
  type M33Provider,
} from './m33-provider';

const canvas = document.querySelector('#game');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
if (!(canvas instanceof HTMLCanvasElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLElement)) {
  throw new Error('M33 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM33Provider(M33_PROVIDER_A_ID);
const providerB = createM33Provider(M33_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M33PortTrace {
  readonly providerId: string;
  readonly submittedInputs: string[];
  readonly commandKinds: string[];
  readonly postCloseHostCommands: string[];
  pollRequests: number;
  pollResponses: number;
  pollOutstanding: number;
  maxPollOutstanding: number;
  closeMessages: number;
  hostCloseOrigin: string | null;
  pollOutstandingAtClose: number | null;
  notificationAttempted: boolean;
  notificationForwarded: boolean;
  notificationThrowInjected: boolean;
  hostCloseSettled: boolean;
  hostCloseRejected: boolean;
  physicalCloseCalls: number;
  portCloseSuppressed: boolean;
}

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

interface HostPortOptions {
  readonly throwOnClosed?: boolean;
  readonly suppressPhysicalClose?: boolean;
  readonly onEvents?: () => void;
}

function createTrace(providerId: string): M33PortTrace {
  return {
    providerId,
    submittedInputs: [],
    commandKinds: [],
    postCloseHostCommands: [],
    pollRequests: 0,
    pollResponses: 0,
    pollOutstanding: 0,
    maxPollOutstanding: 0,
    closeMessages: 0,
    hostCloseOrigin: null,
    pollOutstandingAtClose: null,
    notificationAttempted: false,
    notificationForwarded: false,
    notificationThrowInjected: false,
    hostCloseSettled: false,
    hostCloseRejected: false,
    physicalCloseCalls: 0,
    portCloseSuppressed: false,
  };
}

const traceA = createTrace(M33_PROVIDER_A_ID);
const traceB = createTrace(M33_PROVIDER_B_ID);
let traceC: M33PortTrace | undefined;
let providerC: M33Provider | undefined;
let rawPortC: MessagePort | undefined;
let bindingC: IntelligencePortBinding | undefined;
let app: ExecutionApp | undefined;
let bindingB: IntelligencePortBinding | undefined;
let hostCloseStarted = false;
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

const diagnostics = globalThis as {
  __forgeaxM33Done?: boolean;
  __forgeaxM33Report?: () => unknown;
};

function summarizeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return String(error);
  const value = error as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
  };
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

function providerReport(provider: M33Provider): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M33PortTrace | undefined): unknown {
  if (trace === undefined) return null;
  return {
    ...trace,
    submittedInputs: [...trace.submittedInputs],
    commandKinds: [...trace.commandKinds],
    postCloseHostCommands: [...trace.postCloseHostCommands],
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
  const result = workerResult as {
    readonly ok?: unknown;
    readonly falsifierCaught?: unknown;
  } | undefined;
  if (failure !== undefined) {
    status.dataset.status = 'failed';
    status.textContent = 'M33 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M33 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M33 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M33 Engine Worker running';
  }
  diagnostics.__forgeaxM33Done = done;
}

function createHostPort(
  rawPort: MessagePort,
  trace: M33PortTrace,
  options: HostPortOptions = {},
): IntelligenceMessagePort {
  return {
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind === 'intelligence-events') {
        trace.pollResponses += 1;
        options.onEvents?.();
        trace.pollOutstanding -= 1;
      } else if (message.kind === 'intelligence-closed') {
        trace.closeMessages += 1;
        trace.notificationAttempted = true;
        if (options.throwOnClosed === true) {
          trace.notificationThrowInjected = true;
          throw new Error('M33 injected synchronous Host intelligence-closed publication failure');
        }
        trace.notificationForwarded = true;
      }
      rawPort.postMessage(message);
    },
    addEventListener(type, listener): void {
      rawPort.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type, listener): void {
      rawPort.removeEventListener(type, listener as EventListener);
    },
    start(): void {
      rawPort.start();
    },
    close(): void {
      trace.physicalCloseCalls += 1;
      if (options.suppressPhysicalClose === true) {
        trace.portCloseSuppressed = true;
        return;
      }
      rawPort.close();
    },
  };
}

function publishHostCloseDetail(rejected: boolean): void {
  traceB.hostCloseSettled = true;
  traceB.hostCloseRejected = rejected;
  rawPortA.postMessage({
    kind: 'm33-host-binding-closed',
    origin: 'host-binding.close',
    pollOutstandingAtClose: traceB.pollOutstandingAtClose,
    notificationAttempted: traceB.notificationAttempted,
    notificationForwarded: traceB.notificationForwarded,
    notificationThrowInjected: traceB.notificationThrowInjected,
    hostCloseSettled: traceB.hostCloseSettled,
    hostCloseRejected: traceB.hostCloseRejected,
    physicalCloseCalls: traceB.physicalCloseCalls,
    portCloseSuppressed: traceB.portCloseSuppressed,
  });
}

const hostPortA = createHostPort(rawPortA, traceA);
const hostPortB = createHostPort(rawPortB, traceB, {
  throwOnClosed: true,
  suppressPhysicalClose: falsify,
  onEvents: () => {
    if (hostCloseStarted) return;
    hostCloseStarted = true;
    traceB.hostCloseOrigin = 'host-binding.close';
    traceB.pollOutstandingAtClose = traceB.pollOutstanding;
    const currentBinding = bindingB;
    if (currentBinding === undefined) {
      failure = new Error('M33 provider-B binding was not installed before its poll response');
      publish();
      return;
    }
    void currentBinding.close().then(
      () => publishHostCloseDetail(false),
      () => publishHostCloseDetail(true),
    );
  },
});

function createFreshBinding(): void {
  if (providerC !== undefined) return;
  freshChannelCreated = true;
  providerC = createM33Provider(M33_PROVIDER_C_ID);
  const channelC = new MessageChannel();
  rawPortC = channelC.port1;
  traceC = createTrace(M33_PROVIDER_C_ID);
  observeWorkerCommands(rawPortC, traceC, 'm33-unused-worker-event');
  bindingC = bindIntelligencePort(
    createHostPort(rawPortC, traceC),
    createIntelligenceRuntime(providerC, { limits: M33_LIMITS }),
  );
  rawPortA.postMessage({ kind: 'm33-fresh-port', port: channelC.port2 }, [channelC.port2]);
}

function observeWorkerCommands(rawPort: MessagePort, trace: M33PortTrace, eventKind: string): void {
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
      if (hostCloseStarted && trace.providerId === M33_PROVIDER_B_ID) {
        trace.postCloseHostCommands.push(kind);
      }
    }
    if (value.kind === 'intelligence-submit') {
      const input = value.submission?.input;
      if (typeof input === 'string') trace.submittedInputs.push(input);
      return;
    }
    if (value.kind === 'intelligence-poll') {
      trace.pollRequests += 1;
      trace.pollOutstanding += 1;
      trace.maxPollOutstanding = Math.max(trace.maxPollOutstanding, trace.pollOutstanding);
      return;
    }
    if (value.kind === 'm33-fresh-port-request') {
      createFreshBinding();
      return;
    }
    if (value.kind !== eventKind || typeof value.event !== 'string') return;
    workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
    if (value.event === 'worker-finished') {
      workerResult = value.detail;
      publish();
    }
    if (value.event === 'cleanup-requested') {
      cleanupRequestedResolve?.();
      void finalize().catch((error: unknown) => {
        failure = error;
        done = true;
        publish();
      });
    }
  });
  rawPort.start();
}

observeWorkerCommands(rawPortA, traceA, 'm33-worker-event');
observeWorkerCommands(rawPortB, traceB, 'm33-unused-worker-event');

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M33_LIMITS }),
);
bindingB = bindIntelligencePort(
  hostPortB,
  createIntelligenceRuntime(providerB, { limits: M33_LIMITS }),
);

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

diagnostics.__forgeaxM33Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m33-bootstrap.js', location.href);
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
  rawPortA.postMessage({ kind: 'm33-provider-b-port', port: channelB.port2 }, [channelB.port2]);
  publish();
}

start().catch((error: unknown) => {
  failure = error;
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
