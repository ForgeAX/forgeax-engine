import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  bindIntelligencePort,
  createIntelligenceRuntime,
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligenceRealmMessage,
} from '@forgeax/engine-intelligence';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  M37_LIMITS,
  M37_PROVIDER_A_ID,
  M37_PROVIDER_B_ID,
  M37_PROVIDER_C_ID,
  createM37Provider,
  type M37Provider,
} from './m37-provider';

const canvas = document.querySelector('#game');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
if (!(canvas instanceof HTMLCanvasElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLElement)) {
  throw new Error('M37 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM37Provider(M37_PROVIDER_A_ID);
const providerB = createM37Provider(M37_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M37PortTrace {
  readonly providerId: string;
  readonly submittedInputs: string[];
  readonly commandKinds: string[];
  readonly postCloseHostCommands: string[];
  pollRequests: number;
  pollResponses: number;
  cancelRequests: number;
  closeMessages: number;
  physicalCloseCalls: number;
}

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

let traceC: M37PortTrace | undefined;
let providerC: M37Provider | undefined;
let bindingC: ReturnType<typeof bindIntelligencePort> | undefined;
let app: ExecutionApp | undefined;
let bindingB: ReturnType<typeof bindIntelligencePort> | undefined;
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

const traceA = createTrace(M37_PROVIDER_A_ID);
const traceB = createTrace(M37_PROVIDER_B_ID);

const diagnostics = globalThis as {
  __forgeaxM37Done?: boolean;
  __forgeaxM37Report?: () => unknown;
};

function createTrace(providerId: string): M37PortTrace {
  return {
    providerId,
    submittedInputs: [],
    commandKinds: [],
    postCloseHostCommands: [],
    pollRequests: 0,
    pollResponses: 0,
    cancelRequests: 0,
    closeMessages: 0,
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

function providerReport(provider: M37Provider): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M37PortTrace | undefined): unknown {
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
  const result = workerResult as { readonly ok?: unknown; readonly falsifierCaught?: unknown } | undefined;
  if (failure !== undefined) {
    status.dataset.status = 'failed';
    status.textContent = 'M37 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M37 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M37 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M37 Engine Worker running';
  }
  diagnostics.__forgeaxM37Done = done;
}

function createHostPort(rawPort: MessagePort, trace: M37PortTrace): IntelligenceMessagePort {
  return {
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind === 'intelligence-events') {
        trace.pollResponses += 1;
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
    kind: 'm37-host-binding-closed',
    origin: 'host-binding.after-cancel-command-fault',
    cancelCallsBeforeClose: providerB.trace.cancelCalls,
    activeCountAtClose: providerB.trace.activeCountAtClose,
    hostCloseSettled: true,
    hostCloseRejected: false,
    physicalCloseCalls: traceB.physicalCloseCalls,
  });
}

function startTargetHostCleanup(): void {
  if (hostCloseStarted) return;
  hostCloseStarted = true;
  const currentBinding = bindingB;
  if (currentBinding === undefined) {
    failure = new Error('M37 provider-B binding was not installed before cancel fault report');
    publish();
    return;
  }
  void currentBinding.close().then(
    publishHostCloseDetail,
    () => publishHostCloseDetail(),
  );
}

function createFreshBinding(): void {
  if (providerC !== undefined) return;
  freshChannelCreated = true;
  providerC = createM37Provider(M37_PROVIDER_C_ID);
  const channelC = new MessageChannel();
  traceC = createTrace(M37_PROVIDER_C_ID);
  bindingC = bindIntelligencePort(
    createHostPort(channelC.port1, traceC),
    createIntelligenceRuntime(providerC, { limits: M37_LIMITS }),
  );
  observePort(channelC.port1, traceC);
  rawPortA.postMessage({ kind: 'm37-fresh-port', port: channelC.port2 }, [channelC.port2]);
}

function observePort(rawPort: MessagePort, trace: M37PortTrace, eventKind?: string): void {
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
      if (hostCloseStarted && trace === traceB) trace.postCloseHostCommands.push(kind);
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
      if (value.event === 'cancel-fault-contained') startTargetHostCleanup();
      if (value.event === 'cleanup-requested') {
        cleanupRequestedResolve?.();
        void finalize().catch((cause: unknown) => {
          failure = cause;
          done = true;
          publish();
        });
      }
    }
    if (value.kind === 'm37-fresh-port-request') createFreshBinding();
  });
  rawPort.start();
}

const hostPortA = createHostPort(rawPortA, traceA);
const hostPortB = createHostPort(rawPortB, traceB);
observePort(rawPortA, traceA, 'm37-worker-event');
observePort(rawPortB, traceB);

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M37_LIMITS }),
);
bindingB = bindIntelligencePort(
  hostPortB,
  createIntelligenceRuntime(providerB, { limits: M37_LIMITS }),
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

diagnostics.__forgeaxM37Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m37-bootstrap.js', location.href);
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
  rawPortA.postMessage({ kind: 'm37-provider-b-port', port: channelB.port2 }, [channelB.port2]);
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
