import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  bindIntelligencePort,
  createIntelligenceRuntime,
  type IntelligenceMessagePort,
} from '@forgeax/engine-intelligence';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createM26DeterministicProvider } from './deterministic-provider';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const status = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLPreElement>('#report');
if (canvas === null || status === null || output === null) {
  throw new Error('M26 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const channel = new MessageChannel();
const provider = createM26DeterministicProvider();
const runtime = createIntelligenceRuntime(provider, {
  limits: {
    maxConcurrentActivities: 2,
    maxOutputChars: 8,
    maxPendingEventsPerActivity: 32,
    maxPollEvents: 32,
  },
});
const binding = bindIntelligencePort(
  channel.port1 as unknown as IntelligenceMessagePort,
  runtime,
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
let bindingCloseResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingClosePromiseSame: boolean | undefined;
let failure: unknown;
let done = false;
let finalizing = false;

const diagnostics = globalThis as {
  __forgeaxM26Done?: boolean;
  __forgeaxM26Report?: () => unknown;
};

function summarizeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return String(error);
  const value = error as { readonly code?: unknown; readonly name?: unknown; readonly message?: unknown };
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    message: typeof value.message === 'string' ? value.message : String(error),
  };
}

function providerReport(): unknown {
  return {
    ...provider.trace,
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
    provider: providerReport(),
    workerResult,
    workerEvents,
    stopResults,
    bindingCloseResults,
    bindingClosePromiseSame,
  };
}

function publish(): void {
  const snapshot = report();
  output.textContent = JSON.stringify(snapshot, null, 2);
  const result = workerResult as { readonly ok?: unknown; readonly falsifierCaught?: unknown } | undefined;
  if (failure !== undefined) {
    status.dataset.status = 'failed';
    status.textContent = 'M26 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M26 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M26 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M26 Engine Worker running';
  }
  diagnostics.__forgeaxM26Done = done;
}

function resultSummary(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  return value.ok === true
    ? { ok: true }
    : { ok: false, error: summarizeError(value.error) };
}

async function finalize(): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
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

channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (typeof message !== 'object' || message === null) return;
  const value = message as {
    readonly kind?: unknown;
    readonly event?: unknown;
    readonly detail?: unknown;
  };
  if (value.kind !== 'm26-worker-event' || typeof value.event !== 'string') return;
  workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
  if (value.event === 'worker-finished') {
    workerResult = value.detail;
    publish();
    void finalize();
  }
});
channel.port1.start();

diagnostics.__forgeaxM26Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m26-bootstrap.js', location.href);
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
