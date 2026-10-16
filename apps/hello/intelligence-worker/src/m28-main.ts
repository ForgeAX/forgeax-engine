import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  bindIntelligencePort,
  createIntelligencePortClient,
  createIntelligenceRuntime,
  type ActivityEvent,
  type IntelligenceMessagePort,
  type IntelligenceProvider,
} from '@forgeax/engine-intelligence';
import { ok } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  createM28RejectingProvider,
} from './m28-rejecting-provider';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const status = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLPreElement>('#report');
if (canvas === null || status === null || output === null) {
  throw new Error('M28 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
let closeAttemptResolve: (() => void) | undefined;
const closeAttempted = new Promise<void>((resolve) => {
  closeAttemptResolve = resolve;
});
const provider = createM28RejectingProvider({
  onCloseAttempt: () => closeAttemptResolve?.(),
});
const channel = new MessageChannel();
const runtime = createIntelligenceRuntime(provider, {
  limits: {
    maxInputChars: 64,
    maxOutputChars: 128,
    maxConcurrentActivities: 2,
    maxPendingEventsPerActivity: 16,
    maxPollEvents: 16,
  },
});
provider.attachPoll(() => runtime.poll());
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
let hostSubmittedInputs: string[] = [];
let appReportBeforeStop: unknown;
let stopResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingCloseResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingClosePromiseSame: boolean | undefined;
let freshRecovery: unknown;
let failure: unknown;
let done = false;
let finalizing = false;

const diagnostics = globalThis as {
  __forgeaxM28Done?: boolean;
  __forgeaxM28Report?: () => unknown;
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
    eventsObservedDuringClose: [...provider.trace.eventsObservedDuringClose],
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
    provider: providerReport(),
    workerResult,
    workerEvents,
    stopResults,
    bindingCloseResults,
    bindingClosePromiseSame,
    freshRecovery,
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
    status.textContent = 'M28 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M28 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M28 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M28 Engine Worker running';
  }
  diagnostics.__forgeaxM28Done = done;
}

function resultSummary(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const value = result as { readonly ok?: unknown; readonly error?: unknown };
  return value.ok === true ? { ok: true } : { ok: false, error: summarizeError(value.error) };
}

async function runFreshRecovery(): Promise<unknown> {
  const freshChannel = new MessageChannel();
  let freshStarts = 0;
  const freshProvider: IntelligenceProvider = {
    id: 'm28.fresh.recovery',
    start(_submission, sink) {
      freshStarts += 1;
      queueMicrotask(() => sink.complete('fresh-ok'));
      return ok(undefined);
    },
    cancel() {
      return ok(undefined);
    },
    async close() {},
  };
  const freshHost = bindIntelligencePort(
    freshChannel.port1 as unknown as IntelligenceMessagePort,
    createIntelligenceRuntime(freshProvider),
  );
  const freshClient = createIntelligencePortClient(
    freshProvider.id,
    freshChannel.port2 as unknown as IntelligenceMessagePort,
  );
  try {
    const submitted = freshClient.submit({ input: 'fresh binding' });
    let events: readonly ActivityEvent[] = [];
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
      events = freshClient.poll();
      if (events.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const closeTask = freshClient.close();
    await closeTask;
    await freshHost.close();
    return {
      submitted: submitted.ok,
      starts: freshStarts,
      events,
      closeSettled: true,
    };
  } finally {
    await freshHost.close();
  }
}

async function finalize(): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  await closeAttempted;
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
  freshRecovery = await runFreshRecovery();
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
    readonly submission?: { readonly input?: unknown };
  };
  if (value.kind === 'intelligence-submit') {
    const input = value.submission?.input;
    if (typeof input === 'string') hostSubmittedInputs = [...hostSubmittedInputs, input];
    return;
  }
  if (value.kind !== 'm28-worker-event' || typeof value.event !== 'string') return;
  workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
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
channel.port1.start();

diagnostics.__forgeaxM28Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m28-bootstrap.js', location.href);
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
