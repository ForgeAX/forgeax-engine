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
  M35_LIMITS,
  M35_PROVIDER_A_ID,
  M35_PROVIDER_B_ID,
  M35_PROVIDER_C_ID,
  createM35Provider,
  type M35Provider,
} from './m35-provider';

const canvas = document.querySelector('#game');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
if (!(canvas instanceof HTMLCanvasElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLElement)) {
  throw new Error('M35 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM35Provider(M35_PROVIDER_A_ID);
const providerB = createM35Provider(M35_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M35PortTrace {
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
  notificationSuppressed: boolean;
  hostCloseSettled: boolean;
  hostCloseRejected: boolean;
  physicalCloseCalls: number;
}

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

interface HostPortOptions {
  readonly delayEventsMs?: number;
  readonly suppressClosedNotification?: boolean;
}

function createTrace(providerId: string): M35PortTrace {
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
    notificationSuppressed: false,
    hostCloseSettled: false,
    hostCloseRejected: false,
    physicalCloseCalls: 0,
  };
}

const traceA = createTrace(M35_PROVIDER_A_ID);
const traceB = createTrace(M35_PROVIDER_B_ID);
let traceC: M35PortTrace | undefined;
let providerC: M35Provider | undefined;
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
  __forgeaxM35Done?: boolean;
  __forgeaxM35Report?: () => unknown;
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

function providerReport(provider: M35Provider): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M35PortTrace | undefined): unknown {
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
    status.textContent = 'M35 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M35 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M35 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M35 Engine Worker running';
  }
  diagnostics.__forgeaxM35Done = done;
}

function createHostPort(
  rawPort: MessagePort,
  trace: M35PortTrace,
  options: HostPortOptions = {},
): IntelligenceMessagePort {
  return {
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind === 'intelligence-events') {
        trace.pollResponses += 1;
        const forward = (): void => {
          trace.pollOutstanding = Math.max(0, trace.pollOutstanding - 1);
          rawPort.postMessage(message);
        };
        if (options.delayEventsMs !== undefined) {
          setTimeout(forward, options.delayEventsMs);
        } else {
          forward();
        }
        return;
      }
      if (message.kind === 'intelligence-closed') {
        trace.closeMessages += 1;
        trace.notificationAttempted = true;
        if (options.suppressClosedNotification === true) {
          trace.notificationSuppressed = true;
          return;
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
      rawPort.close();
    },
  };
}

function publishHostCloseDetail(rejected: boolean): void {
  traceB.hostCloseSettled = true;
  traceB.hostCloseRejected = rejected;
  rawPortA.postMessage({
    kind: 'm35-host-binding-closed',
    origin: 'host-binding.after-submit-command-fault',
    pollOutstandingAtClose: traceB.pollOutstandingAtClose,
    notificationAttempted: traceB.notificationAttempted,
    notificationForwarded: traceB.notificationForwarded,
    notificationSuppressed: traceB.notificationSuppressed,
    hostCloseSettled: traceB.hostCloseSettled,
    hostCloseRejected: traceB.hostCloseRejected,
    physicalCloseCalls: traceB.physicalCloseCalls,
  });
}

function startTargetHostCleanup(): void {
  if (hostCloseStarted) return;
  hostCloseStarted = true;
  traceB.hostCloseOrigin = 'host-binding.after-submit-command-fault';
  traceB.pollOutstandingAtClose = traceB.pollOutstanding;
  const currentBinding = bindingB;
  if (currentBinding === undefined) {
    failure = new Error('M35 provider-B binding was not installed before submit fault report');
    publish();
    return;
  }
  void currentBinding.close().then(
    () => publishHostCloseDetail(false),
    () => publishHostCloseDetail(true),
  );
}

function createFreshBinding(): void {
  if (providerC !== undefined) return;
  freshChannelCreated = true;
  providerC = createM35Provider(M35_PROVIDER_C_ID);
  const channelC = new MessageChannel();
  const rawPortC = channelC.port1;
  traceC = createTrace(M35_PROVIDER_C_ID);
  bindingC = bindIntelligencePort(
    createHostPort(rawPortC, traceC),
    createIntelligenceRuntime(providerC, { limits: M35_LIMITS }),
  );
  observePort(rawPortC, traceC);
  rawPortA.postMessage({ kind: 'm35-fresh-port', port: channelC.port2 }, [channelC.port2]);
}

function observePort(rawPort: MessagePort, trace: M35PortTrace, eventKind?: string): void {
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
      if (hostCloseStarted && trace.providerId === M35_PROVIDER_B_ID) {
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
    if (value.kind === 'm35-provider-b-port' && isMessagePort(value.port)) return;
    if (value.kind === 'm35-fresh-port-request') {
      createFreshBinding();
      return;
    }
    if (eventKind !== undefined && value.kind === eventKind && typeof value.event === 'string') {
      workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
      if (value.event === 'worker-finished') {
        workerResult = value.detail;
        publish();
      }
      if (value.event === 'submit-fault-contained') startTargetHostCleanup();
      if (value.event === 'cleanup-requested') {
        cleanupRequestedResolve?.();
        void finalize().catch((cause: unknown) => {
          failure = cause;
          done = true;
          publish();
        });
      }
    }
  });
  rawPort.start();
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

const hostPortA = createHostPort(rawPortA, traceA);
const hostPortB = createHostPort(rawPortB, traceB, {
  delayEventsMs: 120,
  suppressClosedNotification: falsify,
});
observePort(rawPortA, traceA, 'm35-worker-event');
observePort(rawPortB, traceB);

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M35_LIMITS }),
);
bindingB = bindIntelligencePort(
  hostPortB,
  createIntelligenceRuntime(providerB, { limits: M35_LIMITS }),
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

diagnostics.__forgeaxM35Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m35-bootstrap.js', location.href);
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
  rawPortA.postMessage({ kind: 'm35-provider-b-port', port: channelB.port2 }, [channelB.port2]);
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
