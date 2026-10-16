import { type ExecutionWorkersOptions } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { ProfileCapture } from '@forgeax/engine-profiler';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const output = document.querySelector<HTMLPreElement>('#execution-report');
const summary = document.querySelector<HTMLParagraphElement>('#execution-summary');
const rebuildButton = document.querySelector<HTMLButtonElement>('#rebuild');
if (canvas === null || output === null || summary === null || rebuildButton === null) {
  throw new Error('execution demo DOM is incomplete');
}
const params = new URL(location.href).searchParams;
const tierParam = params.get('tier');
const scenarios: Record<string, ExecutionWorkersOptions> = {
  'main-serial': { engine: false },
  'engine-worker': { engine: true, render: false, kernels: false },
  'render-worker': { engine: true, render: true, kernels: false },
  shared: { engine: true, render: false, kernels: true },
  auto: {},
};
const requestedWorkers = scenarios[tierParam ?? 'auto'] ?? {};
type ExecutionTelemetry = {
  readonly registered: Array<{ readonly name: string; readonly worldIdentity: string }>;
  readonly cleanups: Array<{ readonly name: string; readonly worldIdentity: string }>;
  readonly updates: Array<{
    readonly keyMDown: boolean;
    readonly mousePrimaryDown: boolean;
    readonly keyMJustPressed: boolean;
    readonly worldIdentity: string;
  }>;
  readonly faultArmed: Array<{ readonly worldIdentity: string }>;
};
const telemetryEnabled = params.get('gauntlet') === '1';
const telemetry: ExecutionTelemetry | undefined = telemetryEnabled
  ? { registered: [], cleanups: [], updates: [], faultArmed: [] }
  : undefined;
const telemetryChannel = telemetryEnabled ? new MessageChannel() : undefined;
if (telemetry !== undefined && telemetryChannel !== undefined) {
  telemetryChannel.port1.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== 'object' || event.data === null) return;
    const message = event.data as {
      kind?: unknown;
      name?: unknown;
      worldIdentity?: unknown;
      keyMDown?: unknown;
      mousePrimaryDown?: unknown;
      keyMJustPressed?: unknown;
    };
    if (typeof message.worldIdentity !== 'string') return;
    if (message.kind === 'cleanup-registered' && typeof message.name === 'string') {
      telemetry.registered.push({ name: message.name, worldIdentity: message.worldIdentity });
    } else if (message.kind === 'cleanup' && typeof message.name === 'string') {
      telemetry.cleanups.push({ name: message.name, worldIdentity: message.worldIdentity });
    } else if (
      message.kind === 'update' &&
      typeof message.keyMDown === 'boolean' &&
      typeof message.mousePrimaryDown === 'boolean' &&
      typeof message.keyMJustPressed === 'boolean'
    ) {
      telemetry.updates.push({
        keyMDown: message.keyMDown,
        mousePrimaryDown: message.mousePrimaryDown,
        keyMJustPressed: message.keyMJustPressed,
        worldIdentity: message.worldIdentity,
      });
    } else if (message.kind === 'fault-armed') {
      telemetry.faultArmed.push({ worldIdentity: message.worldIdentity });
    }
  };
  telemetryChannel.port1.start();
}
const diagnostics = globalThis as {
  __forgeaxExecutionTelemetry?: ExecutionTelemetry;
  __forgeaxExecutionReport?: () => unknown;
  __forgeaxExecutionFrameSamples?: readonly number[];
  __forgeaxExecutionCapture?: () => ProfileCapture;
  __forgeaxExecutionStop?: () => unknown;
};
if (telemetry !== undefined) diagnostics.__forgeaxExecutionTelemetry = telemetry;
const bootstrap = new URL('/assets/shared-bootstrap.js', location.href);
if (params.get('fault') === '1') bootstrap.searchParams.set('fault', '1');
const profiler = params.get('profile') === '1'
  ? (await import('@forgeax/engine-profiler')).createProfiler()
  : undefined;
if (profiler !== undefined) {
  const captureStarted = profiler.startCapture({ frameLimit: 400, eventLimit: 2_000 });
  if (!captureStarted.ok) throw captureStarted.error;
}

const created = await createApp(
  canvas,
  {
    execution: {
      workers: requestedWorkers,
      bootstrap,
      ...(telemetryChannel === undefined
        ? {}
        : { bootstrapData: { telemetry: true }, bootstrapPort: telemetryChannel.port2 }),
      // The production demo carries the complete shader manifest in both realms.
      startupTimeoutMs: 30_000,
      frameTimeoutMs: 5_000,
    },
    ...(profiler === undefined ? {} : { profiler }),
  },
  forgeaxBundlerAdapter(),
);

if (!created.ok) {
  output.dataset.status = 'failed';
  const detail = 'detail' in created.error ? created.error.detail : undefined;
  const message =
    created.error instanceof Error
      ? created.error.message
      : 'createApp failed';
  output.textContent = JSON.stringify({
    code: 'code' in created.error ? created.error.code : created.error.name,
    message,
    requestedWorkers,
    expected: 'expected' in created.error ? created.error.expected : undefined,
    hint: 'hint' in created.error ? created.error.hint : undefined,
    capabilityTruth:
      typeof detail === 'object' && detail !== null
        ? {
            missingCapabilities: 'missingCapabilities' in detail ? detail.missingCapabilities : [],
          }
        : null,
    ...('detail' in created.error ? { detail: created.error.detail } : {}),
  });
  throw created.error;
}

const app = created.value;
diagnostics.__forgeaxExecutionReport = () => app.execution.report();
diagnostics.__forgeaxExecutionStop = () => app.stop();
if (profiler !== undefined) {
  diagnostics.__forgeaxExecutionCapture = () => {
    const stopped = app.stop();
    if (!stopped.ok) throw stopped.error;
    const capture = profiler.latestCapture();
    if (capture === undefined) throw new Error('execution profile capture is unavailable');
    return capture;
  };
}
const start = app.start();
if (!start.ok) throw start.error;

let rebuilding = false;
let previousReportSamples = 0;
let previousFrameAt = 0;
let publishedFrames = 0;
const frameSamples: number[] = [];
rebuildButton.addEventListener('click', () => {
  if (rebuilding) return;
  rebuilding = true;
  rebuildButton.disabled = true;
  void app.execution.rebuild().then((result) => {
    rebuilding = false;
    rebuildButton.disabled = false;
    if (!result.ok) throw result.error;
    const restarted = app.start();
    if (!restarted.ok) throw restarted.error;
    previousReportSamples = 0;
    previousFrameAt = 0;
  });
});

const publish = (): void => {
  publishedFrames += 1;
  const report = app.execution.report();
  const reportSamples = report.performance.hostFrameMs?.samples ?? 0;
  if (reportSamples > previousReportSamples) {
    const now = performance.now();
    if (previousFrameAt > 0) frameSamples.push(now - previousFrameAt);
    previousFrameAt = now;
    previousReportSamples = reportSamples;
    diagnostics.__forgeaxExecutionFrameSamples = frameSamples;
  }
  summary.textContent = report.fault === null
    ? `Engine: ${report.engine.health}`
    : `Engine: ${report.engine.health} | Fault: ${report.fault.code}`;
  output.dataset.status = report.engine.health;
  output.textContent = JSON.stringify(report, null, 2);
  rebuildButton.hidden = report.world.health !== 'poisoned';
  if (
    report.engine.health === 'running' &&
    (report.performance.engineUpdateMs !== null ||
      (!report.workers.engine.enabled && publishedFrames >= 2))
  ) {
    (globalThis as { __forgeaxExecutionReady?: boolean }).__forgeaxExecutionReady = true;
  }
  requestAnimationFrame(publish);
};
publish();
