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
import { createM31InterleavedProvider } from './m31-interleaved-provider';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const status = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLPreElement>('#report');
if (canvas === null || status === null || output === null) {
  throw new Error('M31 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const provider = createM31InterleavedProvider();
const channel = new MessageChannel();
const rawHostPort = channel.port1;
let pollRequests = 0;
let pollResponses = 0;
let pollOutstanding = 0;
let maxPollOutstanding = 0;
let pollRequestedMaxEvents: number[] = [];
let pollResponseSizes: number[] = [];
let falsifierInjected = false;
let hostSubmittedInputs: string[] = [];
const hostPort: IntelligenceMessagePort = {
  postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
    if (message.kind === 'intelligence-events') {
      pollResponses += 1;
      pollOutstanding -= 1;
      const events =
        falsify && !falsifierInjected && message.events.length > 0
          ? [message.events[0], ...message.events]
          : message.events;
      if (events.length !== message.events.length) falsifierInjected = true;
      pollResponseSizes.push(events.length);
      rawHostPort.postMessage({ kind: message.kind, events });
      return;
    }
    rawHostPort.postMessage(message);
  },
  addEventListener(type, listener): void {
    rawHostPort.addEventListener(type, listener as EventListener);
  },
  removeEventListener(type, listener): void {
    rawHostPort.removeEventListener(type, listener as EventListener);
  },
  start(): void {
    rawHostPort.start();
  },
  close(): void {
    rawHostPort.close();
  },
};
rawHostPort.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (typeof message !== 'object' || message === null) return;
  const value = message as {
    readonly kind?: unknown;
    readonly maxEvents?: unknown;
    readonly event?: unknown;
    readonly detail?: unknown;
    readonly submission?: { readonly input?: unknown };
  };
  if (value.kind === 'intelligence-poll') {
    pollRequests += 1;
    pollOutstanding += 1;
    maxPollOutstanding = Math.max(maxPollOutstanding, pollOutstanding);
    if (typeof value.maxEvents === 'number') pollRequestedMaxEvents.push(value.maxEvents);
    return;
  }
  if (value.kind === 'intelligence-submit') {
    const input = value.submission?.input;
    if (typeof input === 'string') hostSubmittedInputs = [...hostSubmittedInputs, input];
    return;
  }
  if (value.kind !== 'm31-worker-event' || typeof value.event !== 'string') return;
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

const runtime = createIntelligenceRuntime(provider, {
  limits: {
    maxInputChars: 64,
    maxOutputChars: 128,
    maxConcurrentActivities: 2,
    maxPendingEventsPerActivity: 16,
    maxPollEvents: 1,
  },
});
const binding = bindIntelligencePort(hostPort, runtime);

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

let app: ExecutionApp | undefined;
let workerResult: unknown;
let workerEvents: WorkerEvent[] = [];
let appReportBeforeStop: unknown;
let stopResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingCloseResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingClosePromiseSame: boolean | undefined;
let failure: unknown;
let done = false;
let finalizing = false;
let closeRequestedResolve: (() => void) | undefined;
const closeRequested = new Promise<void>((resolve) => {
  closeRequestedResolve = resolve;
});

const diagnostics = globalThis as {
  __forgeaxM31Done?: boolean;
  __forgeaxM31Report?: () => unknown;
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

function providerReport(): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function report(): unknown {
  return {
    falsify,
    done,
    failure: failure === undefined ? null : summarizeError(failure),
    appReport: app?.execution.report() ?? null,
    appReportBeforeStop,
    hostSubmittedInputs,
    pollTrace: {
      requests: pollRequests,
      responses: pollResponses,
      outstanding: pollOutstanding,
      maxOutstanding: maxPollOutstanding,
      requestedMaxEvents: [...pollRequestedMaxEvents],
      responseSizes: [...pollResponseSizes],
      falsifierInjected,
    },
    provider: providerReport(),
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
    status.textContent = 'M31 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M31 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M31 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M31 Engine Worker running';
  }
  diagnostics.__forgeaxM31Done = done;
}

function resultSummary(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  return value.ok === true ? { ok: true } : { ok: false, error: summarizeError(value.error) };
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
  const firstClose = binding.close();
  const secondClose = binding.close();
  bindingClosePromiseSame = firstClose === secondClose;
  await Promise.all([firstClose, secondClose]);
  bindingCloseResults = { first: { ok: true }, second: { ok: true } };
  done = true;
  publish();
}

rawHostPort.start();
diagnostics.__forgeaxM31Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m31-bootstrap.js', location.href);
  const created = await createApp(
    canvas,
    {
      execution: {
        workers: { engine: true, render: false, kernels: false },
        bootstrap,
        bootstrapData: { falsify },
        bootstrapPort: channel.port2,
        startupTimeoutMs: 15_000,
        frameTimeoutMs: 5_000,
      },
    },
    forgeaxBundlerAdapter(),
  );
  if (!created.ok) {
    failure = created.error;
    await binding.close();
    done = true;
    publish();
    return;
  }
  app = created.value;
  const started = app.start();
  if (!started.ok) {
    failure = started.error;
    await binding.close();
    done = true;
    publish();
    return;
  }
  publish();
}

start().catch((error: unknown) => {
  failure = error;
  void binding.close().then(() => {
    done = true;
    publish();
  });
});
