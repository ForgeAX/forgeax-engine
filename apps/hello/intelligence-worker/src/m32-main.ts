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
  M32_HOST_LIMITS,
  M32_LIMITS,
  M32_PROVIDER_A_ID,
  M32_PROVIDER_B_ID,
  M32_PROVIDER_C_ID,
  createM32Provider,
  type M32Provider,
} from './m32-provider';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const status = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLPreElement>('#report');
if (canvas === null || status === null || output === null) {
  throw new Error('M32 intelligence worker demo DOM is incomplete');
}

const falsify = new URL(location.href).searchParams.get('falsify') === '1';
const providerA = createM32Provider(M32_PROVIDER_A_ID);
const providerB = createM32Provider(M32_PROVIDER_B_ID);
const channelA = new MessageChannel();
const channelB = new MessageChannel();
const rawPortA = channelA.port1;
const rawPortB = channelB.port1;

interface M32PortTrace {
  readonly providerId: string;
  readonly submittedInputs: string[];
  readonly commandKinds: string[];
  pollRequests: number;
  pollResponses: number;
  pollOutstanding: number;
  maxPollOutstanding: number;
  rejectionMessages: number;
  closeMessages: number;
  hostCloseOrigin: string | null;
  pollOutstandingAtClose: number | null;
  notificationForwarded: boolean;
  notificationSuppressed: boolean;
  portCloseSuppressed: boolean;
  lateMessagesSent: number;
}

const traceA: M32PortTrace = {
  providerId: M32_PROVIDER_A_ID,
  submittedInputs: [],
  commandKinds: [],
  pollRequests: 0,
  pollResponses: 0,
  pollOutstanding: 0,
  maxPollOutstanding: 0,
  rejectionMessages: 0,
  closeMessages: 0,
  hostCloseOrigin: null,
  pollOutstandingAtClose: null,
  notificationForwarded: false,
  notificationSuppressed: false,
  portCloseSuppressed: false,
  lateMessagesSent: 0,
};
const traceB: M32PortTrace = {
  providerId: M32_PROVIDER_B_ID,
  submittedInputs: [],
  commandKinds: [],
  pollRequests: 0,
  pollResponses: 0,
  pollOutstanding: 0,
  maxPollOutstanding: 0,
  rejectionMessages: 0,
  closeMessages: 0,
  hostCloseOrigin: null,
  pollOutstandingAtClose: null,
  notificationForwarded: false,
  notificationSuppressed: false,
  portCloseSuppressed: false,
  lateMessagesSent: 0,
};

let providerC: M32Provider | undefined;
let rawPortC: MessagePort | undefined;
let bindingC: IntelligencePortBinding | undefined;
let app: ExecutionApp | undefined;
let bindingB: IntelligencePortBinding | undefined;
let hostCloseStarted = false;
let hostCloseSidebandSent = false;
let freshChannelCreated = false;

interface WorkerEvent {
  readonly event: string;
  readonly detail: unknown;
}

let workerResult: unknown;
let workerEvents: WorkerEvent[] = [];
let appReportBeforeStop: unknown;
let stopResults: { readonly first: unknown; readonly second: unknown } | undefined;
let bindingCloseResults:
  | {
      readonly providerA: { readonly first: unknown; readonly second: unknown };
      readonly providerB: { readonly first: unknown; readonly second: unknown };
      readonly providerC: { readonly first: unknown; readonly second: unknown };
    }
  | undefined;
let bindingClosePromiseSame:
  | { readonly providerA: boolean; readonly providerB: boolean; readonly providerC: boolean }
  | undefined;
let failure: unknown;
let done = false;
let finalizing = false;
let cleanupRequestedResolve: (() => void) | undefined;
const cleanupRequested = new Promise<void>((resolve) => {
  cleanupRequestedResolve = resolve;
});

const diagnostics = globalThis as {
  __forgeaxM32Done?: boolean;
  __forgeaxM32Report?: () => unknown;
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

function providerReport(provider: M32Provider): unknown {
  return {
    ...provider.trace,
    starts: [...provider.trace.starts],
    emissions: [...provider.trace.emissions],
    activeCount: provider.activeCount,
    closed: provider.closed,
  };
}

function portReport(trace: M32PortTrace): unknown {
  return {
    ...trace,
    submittedInputs: [...trace.submittedInputs],
    commandKinds: [...trace.commandKinds],
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
    status.textContent = 'M32 failed';
  } else if (done && result?.falsifierCaught === true) {
    status.dataset.status = 'falsifier-caught';
    status.textContent = 'M32 falsifier caught';
  } else if (done && result?.ok === true) {
    status.dataset.status = 'passed';
    status.textContent = 'M32 passed';
  } else {
    status.dataset.status = 'running';
    status.textContent = 'M32 Engine Worker running';
  }
  diagnostics.__forgeaxM32Done = done;
}

function createHostPort(rawPort: MessagePort, trace: M32PortTrace): IntelligenceMessagePort {
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
let hostPortB: IntelligenceMessagePort;

hostPortB = {
  postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void {
    if (message.kind === 'intelligence-events') {
      traceB.pollResponses += 1;
      if (!hostCloseStarted) {
        hostCloseStarted = true;
        traceB.hostCloseOrigin = 'host-binding.close';
        traceB.pollOutstandingAtClose = traceB.pollOutstanding;
        const currentBinding = bindingB;
        if (currentBinding === undefined) {
          failure = new Error('M32 provider-B binding was not installed before its poll response');
          publish();
        } else {
          const closeTask = currentBinding.close();
          void closeTask.then(() => {
            traceB.lateMessagesSent += 2;
            if (!hostCloseSidebandSent) {
              hostCloseSidebandSent = true;
              rawPortA.postMessage({
                kind: 'm32-host-binding-closed',
                origin: 'host-binding.close',
                pollOutstandingAtClose: traceB.pollOutstandingAtClose,
                notificationForwarded: traceB.notificationForwarded,
                notificationSuppressed: traceB.notificationSuppressed,
              });
            }
            rawPortB.postMessage({
              kind: 'intelligence-events',
              events: [
                {
                  type: 'text-delta',
                  activityId: 'm32-late-host-event',
                  sequence: 1,
                  text: 'late-host:',
                },
              ],
            });
            rawPortB.postMessage({
              kind: 'intelligence-rejected',
              activityId: 'm32-late-host-rejection',
              error: {
                code: 'intelligence-capacity-exceeded',
                expected: 'the Host capacity bound rejects excess activity',
                hint: 'poll the client and inspect the structured failure',
                detail: { limit: 1 },
              },
            });
          });
        }
      }
      traceB.pollOutstanding -= 1;
      rawPortB.postMessage(message);
      return;
    }
    if (message.kind === 'intelligence-closed') {
      traceB.closeMessages += 1;
      if (falsify) {
        traceB.notificationSuppressed = true;
        return;
      }
      traceB.notificationForwarded = true;
    }
    if (message.kind === 'intelligence-rejected') traceB.rejectionMessages += 1;
    rawPortB.postMessage(message);
  },
  addEventListener(type, listener): void {
    rawPortB.addEventListener(type, listener as EventListener);
  },
  removeEventListener(type, listener): void {
    rawPortB.removeEventListener(type, listener as EventListener);
  },
  start(): void {
    rawPortB.start();
  },
  close(): void {
    if (falsify) {
      traceB.portCloseSuppressed = true;
      return;
    }
    rawPortB.close();
  },
};

function observeWorkerCommands(rawPort: MessagePort, trace: M32PortTrace, eventKind: string): void {
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
    if (
      value.kind === 'intelligence-submit' ||
      value.kind === 'intelligence-poll' ||
      value.kind === 'intelligence-cancel' ||
      value.kind === 'intelligence-close'
    ) {
      trace.commandKinds.push(String(value.kind));
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
    if (value.kind === 'intelligence-rejected') return;
    if (value.kind === 'intelligence-close') return;
    if (value.kind === 'm32-fresh-port-request') {
      if (providerC !== undefined) return;
      freshChannelCreated = true;
      providerC = createM32Provider(M32_PROVIDER_C_ID);
      const channelC = new MessageChannel();
      rawPortC = channelC.port1;
      const traceC = {
        ...traceA,
        providerId: M32_PROVIDER_C_ID,
        submittedInputs: [],
        commandKinds: [],
      } as M32PortTrace;
      bindingC = bindIntelligencePort(
        createHostPort(rawPortC, traceC),
        createIntelligenceRuntime(providerC, { limits: M32_LIMITS }),
      );
      rawPortA.postMessage({ kind: 'm32-fresh-port', port: channelC.port2 }, [channelC.port2]);
      return;
    }
    if (value.kind !== eventKind || typeof value.event !== 'string') return;
    workerEvents = [...workerEvents, { event: value.event, detail: value.detail ?? null }];
    if (value.event === 'cleanup-requested') {
      cleanupRequestedResolve?.();
      void finalize().catch((error: unknown) => {
        failure = error;
        done = true;
        publish();
      });
    }
    if (value.event === 'worker-finished') {
      workerResult = value.detail;
      publish();
    }
  });
  rawPort.start();
}

observeWorkerCommands(rawPortA, traceA, 'm32-worker-event');
observeWorkerCommands(rawPortB, traceB, 'm32-unused-event-kind');

const bindingA = bindIntelligencePort(
  hostPortA,
  createIntelligenceRuntime(providerA, { limits: M32_LIMITS }),
);
bindingB = bindIntelligencePort(
  hostPortB,
  createIntelligenceRuntime(providerB, { limits: M32_HOST_LIMITS }),
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

diagnostics.__forgeaxM32Report = report;
publish();

async function start(): Promise<void> {
  const bootstrap = new URL('/assets/m32-bootstrap.js', location.href);
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
  rawPortA.postMessage({ kind: 'm32-provider-b-port', port: channelB.port2 }, [channelB.port2]);
  publish();
}

start().catch((error: unknown) => {
  failure = error;
  void closeBindings().then(() => {
    done = true;
    publish();
  });
});
