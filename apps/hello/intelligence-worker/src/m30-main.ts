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
  M30_LIMITS,
  M30_PROVIDER_A_ID,
  M30_PROVIDER_B_ID,
  createM30Provider,
} from './m30-provider';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const status = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLPreElement>('#report');
if (canvas === null || status === null || output === null) {
  throw new Error('M30 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM30Provider(M30_PROVIDER_A_ID);
const providerB = createM30Provider(M30_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M30PortTrace {
  readonly providerId: string;
  readonly submittedInputs: string[];
  pollRequests: number;
  pollResponses: number;
  pollOutstanding: number;
  maxPollOutstanding: number;
  rejectionMessages: number;
  closeMessages: number;
}

const traceA: M30PortTrace = {
  providerId: M30_PROVIDER_A_ID,
  submittedInputs: [],
  pollRequests: 0,
  pollResponses: 0,
  pollOutstanding: 0,
  maxPollOutstanding: 0,
  rejectionMessages: 0,
  closeMessages: 0,
};
const traceB: M30PortTrace = {
  providerId: M30_PROVIDER_B_ID,
  submittedInputs: [],
  pollRequests: 0,
  pollResponses: 0,
  pollOutstanding: 0,
  maxPollOutstanding: 0,
  rejectionMessages: 0,
  closeMessages: 0,
};

function createHostPort(rawPort: MessagePort, trace: M30PortTrace): IntelligenceMessagePort {
  return {
    postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
      if (message.kind === 'intelligence-events') {
        trace.pollResponses += 1;
        trace.pollOutstanding -= 1;
      } else if (message.kind === 'intelligence-rejected') {
        trace.rejectionMessages += 1;
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
      rawPort.close();
    },
  };
}

const hostPortA = createHostPort(rawPortA, traceA);
const hostPortB = createHostPort(rawPortB, traceB);

function observeWorkerCommands(rawPort: MessagePort, trace: M30PortTrace, eventKind: string): void {
  rawPort.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (typeof message !== 'object' || message === null) return;
    const value = message as {
      readonly kind?: unknown;
      readonly maxEvents?: unknown;
      readonly event?: unknown;
      readonly detail?: unknown;
      readonly submission?: { readonly input?: unknown };
    };
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
    if (value.kind === 'intelligence-close') {
      trace.closeMessages += 1;
      return;
    }
    if (value.kind !== eventKind || typeof value.event !== 'string') return;
    workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
    if (value.event === 'close-requested') closeRequestedResolve?.();
    if (value.event === 'worker-finished') {
      workerResult = value.detail;
      publish();
      void finalize().catch((error: unknown) => {
        failure = error;
        done = true;
        publish();
      });
    }
  });
  rawPort.start();
}

observeWorkerCommands(rawPortA, traceA, 'm30-worker-event');
observeWorkerCommands(rawPortB, traceB, 'm30-worker-event');

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M30_LIMITS }),
);
const bindingB = bindIntelligencePort(
  hostPortB,
  createIntelligenceRuntime(providerB, { limits: M30_LIMITS }),
);

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

let app: ExecutionApp | undefined;
let workerResult: unknown;
let workerEvents: WorkerEvent[] = [];
let appReportBeforeStop: unknown;
let stopResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingCloseResults:
  | {
      readonly providerA: { readonly first: unknown; readonly second: unknown };
      readonly providerB: { readonly first: unknown; readonly second: unknown };
    }
  | undefined;
let bindingClosePromiseSame: { readonly providerA: boolean; readonly providerB: boolean } | undefined;
let failure: unknown;
let done = false;
let finalizing = false;
let closeRequestedResolve: (() => void) | undefined;
const closeRequested = new Promise<void>((resolve) => {
  closeRequestedResolve = resolve;
});

const diagnostics = globalThis as {
  __forgeaxM30Done?: boolean;
  __forgeaxM30Report?: () => unknown;
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

function providerReport(provider: typeof providerA): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M30PortTrace): unknown {
  return {
    ...trace,
    submittedInputs: [...trace.submittedInputs],
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
    },
    providerA: providerReport(providerA),
    providerB: providerReport(providerB),
    workerResult,
    workerEvents,
    stopResults,
    bindingCloseResults,
    bindingClosePromiseSame,
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
    status.textContent = 'M30 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M30 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M30 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M30 Engine Worker running';
  }
  diagnostics.__forgeaxM30Done = done;
}

function resultSummary(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  return value.ok === true ? { ok: true } : { ok: false, error: summarizeError(value.error) };
}

async function closeBindings(): Promise<void> {
  const firstA = bindingA.close();
  const secondA = bindingA.close();
  const firstB = bindingB.close();
  const secondB = bindingB.close();
  bindingClosePromiseSame = {
    providerA: firstA === secondA,
    providerB: firstB === secondB,
  };
  const [resultFirstA, resultSecondA, resultFirstB, resultSecondB] = await Promise.all([
    firstA,
    secondA,
    firstB,
    secondB,
  ]);
  bindingCloseResults = {
    providerA: { first: { ok: true }, second: { ok: true } },
    providerB: { first: { ok: true }, second: { ok: true } },
  };
}

async function finalize(): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  await closeRequested;
  if (app !== undefined) {
    appReportBeforeStop = app.execution.report();
    const first = app.stop();
    const second = app.stop();
    stopResults = { first: resultSummary(first), second: resultSummary(second) };
  }
  await closeBindings();
  done = true;
  publish();
}

diagnostics.__forgeaxM30Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m30-bootstrap.js', location.href);
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
  rawPortA.postMessage(
    { kind: 'm30-provider-b-port', port: channelB.port2 },
    [channelB.port2],
  );
  publish();
}

start().catch((error: unknown) => {
  failure = error;
  void closeBindings().then(() => {
    done = true;
    publish();
  });
});
