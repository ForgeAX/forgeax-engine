import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import { parseImage } from '@forgeax/engine-image/parse-image';
import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import type { RenderInspection } from '@forgeax/engine-render';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { chromium, type Page } from 'playwright';
import { build, createServer, preview, type Plugin } from 'vite';
import { expect, it } from 'vitest';
import { runtimeBrowserLaunchOptions } from './browser-launch.js';
import {
  observeRuntimePackGpuBuffers,
  observeRuntimePackTaskMemory,
} from './fixtures/runtime-pack-memory.js';
import {
  encodePressureTexture,
  observeRuntimePackTaskPool,
  pressureTextureSide,
} from './fixtures/runtime-pack-task-pressure.js';
import { createLiveSyncProjectDirectory, prepareLiveSyncSharedInputs } from '../scripts/live-sync-inputs.mjs';
import { executionWorkerEntries } from '../src/build/execution-workers.js';
import { prepareRuntimePackProgram } from '../src/build/pack-program.js';
import { runtimePacksSource } from '../src/build/runtime-packs-source.js';

type Fixture = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface Inspection {
  world: string;
  gameTicks: number;
  unrelated: number[];
  width?: number;
  typed?: boolean;
  frames: {
    submitted: number;
    completed: number;
    ready: number;
    backends: string[];
    errors: unknown[];
  };
  renderer?: string;
  refs: number;
  packs: number;
  programs: number;
  builds: number;
  pluginTicks: number;
  pluginActive: number;
}
const inspect = async (page: Page) => (await call(page, 'inspect')) as Inspection;
const countReadyRenderFrames = async (page: Page) =>
  (await host(page, 'countReadyRenderFrames')) as number;
const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ({ method, args }) => {
      const operation = (globalThis as unknown as { fixture: Fixture }).fixture.call;
      if (!operation) throw new Error('Worker fixture transport missing');
      return await operation(method, ...args);
    },
    { method, args },
  );
const host = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ({ method, args }) => {
      try {
        const operation = (globalThis as unknown as { fixture: Fixture }).fixture[method];
        if (!operation) throw new Error(`Host fixture operation missing: ${method}`);
        return await operation(...args);
      } catch (error) {
        throw new Error(
          JSON.stringify(error, (_key, value) =>
            value instanceof Error
              ? { ...value, message: value.message, stack: value.stack }
              : value,
          ),
        );
      }
    },
    { method, args },
  );

// Decode the same compositor PNG locally; no screenshot round trip back into Chromium.
const pixels = (png: Buffer) => {
  const decoded = parseImage(png, 'image/png');
  if (!decoded.ok) throw decoded.error;
  const { width, height, bytes } = decoded.value;
  let left = width, right = -1, top = height, bottom = -1, count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (Math.max(...[0, 1, 2].map((c) => Math.abs((bytes[offset + c] ?? 0) - (bytes[c] ?? 0)))) <= 15)
        continue;
      count++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  return { count, width: right - left + 1, height: bottom - top + 1 };
};

const core = process.env.FORGEAX_CI_CORE_VALIDATION === '1';
const coreDeliveryCases = new Set(['build-js', 'dev-ts']);
const meshMiB = Number(process.env.FORGEAX_RUNTIME_PACK_MESH_MIB ?? 0);
if (![0, 1, 16, 64].includes(meshMiB)) throw new Error('Expected 1, 16 or 64 MiB for the Mesh workload');
const renderMeshBudget = process.env.FORGEAX_RUNTIME_PACK_RENDER_MESH_BUDGET_BYTES === undefined
  ? undefined
  : Number(process.env.FORGEAX_RUNTIME_PACK_RENDER_MESH_BUDGET_BYTES);
const taskPressure = process.env.FORGEAX_RUNTIME_PACK_TASK_PRESSURE === '1';
const taskUnavailable = process.env.FORGEAX_RUNTIME_PACK_TASK_UNAVAILABLE === '1';
const replacementMeasurement = process.env.FORGEAX_RUNTIME_PACK_REPLACEMENT_MEMORY === '1';
const taskDiagnostic = taskPressure || taskUnavailable;
if (replacementMeasurement && (meshMiB !== 16 || taskPressure || taskUnavailable || renderMeshBudget !== undefined))
  throw new Error('The replacement memory comparison uses the 16 MiB workload and default budget');
if (taskDiagnostic && meshMiB === 0) throw new Error('Task diagnostics require a Mesh workload size');
if (taskPressure && taskUnavailable) throw new Error('Select one Task diagnostic at a time');
const workerRenderCase = ['build', 'ts', 'task-worker', 'split-render'] as const;
const browserCases = [
  ['build', 'js', 'engine', 'local-render'],
  ['build', 'ts', 'engine', 'local-render'],
  ['build', 'ts', 'task-worker', 'local-render'],
  ['dev', 'js', 'engine', 'local-render'],
  ['dev', 'ts', 'engine', 'local-render'],
  ['dev', 'ts', 'task-worker', 'local-render'],
  workerRenderCase,
] as const;
const workloadCases = [
  ['build', 'ts', 'engine', 'split-cpu'],
  ['build', 'ts', 'task-worker', 'split-cpu'],
  workerRenderCase,
] as const;
type RuntimePackBrowserCase = (typeof browserCases)[number] | (typeof workloadCases)[number];
const cases: readonly RuntimePackBrowserCase[] = taskDiagnostic
  ? [workerRenderCase]
  : meshMiB > 0 ? workloadCases : browserCases;

function evidenceNameOf(mode: string, language: string, execution: string, renderer: string) {
  return [
    mode,
    language,
    execution === 'engine' ? '' : execution,
    renderer === 'local-render' ? '' : renderer,
    meshMiB === 0 ? '' : `${meshMiB}mib`,
  ].filter(Boolean).join('-');
}

async function measureWorkload(
  page: Page,
  renderer: string,
  execution: string,
  evidencePath: string,
) {
  const report = () => host(page, 'report') as Promise<ExecutionReport>;
  const initialRenderMeshStorage = await host(page, 'meshResidency');
  await call(page, 'startTickSample');
  const requested = performance.now();
  expect(await call(page, 'generate', 2)).toEqual({ ok: true });
  const published = performance.now();
  const unconsumedDecoded = await call(page, 'meshSourceReady');
  const residency = await call(page, 'mountVisual', renderer === 'split-render' ? 'render' : 'cpu');
  const budgetFallback = meshMiB === 64 ? 'recovery-budget-exceeded' : 'render-budget-exceeded';
  if (renderer === 'split-render' && (meshMiB === 64 || renderMeshBudget !== undefined))
    expect(residency).toMatchObject({
      read: 'available',
      residency: { mode: 'cpu', cpuRetentionReason: budgetFallback },
    });
  const adopted = performance.now();
  await expect
    .poll(async () => pixels(await page.screenshot()).count, { timeout: 120000 })
    .toBeGreaterThan(1000);
  const firstVisible = performance.now();
  const visibleFrame = (await report()).frame.completed;
  await expect
    .poll(async () => (await report()).frame.completed, { timeout: 120000 })
    .toBeGreaterThanOrEqual(visibleFrame + 60);
  const tickGaps = await call(page, 'finishTickSample');
  const stableRenderMeshStorage = (await host(page, 'meshResidency')) as RenderInspection['meshResidency'];
  expect(stableRenderMeshStorage).toMatchObject({
    gpuBuffers: { activeBytes: expect.any(Number), retiringBytes: 0 },
    publication: { reservedTransferBytes: 0 },
  });
  const meshBytes = meshMiB * 1024 * 1024;
  expect(stableRenderMeshStorage?.gpuBuffers.activeBytes).toBeGreaterThanOrEqual(meshBytes);
  if (renderer === 'split-render' && meshMiB < 64 && renderMeshBudget === undefined)
    expect(stableRenderMeshStorage?.publication?.preparedBytes).toBeGreaterThanOrEqual(meshBytes);
  else expect(stableRenderMeshStorage?.publication?.preparedBytes).toBe(0);
  const warmed = performance.now();
  expect(await call(page, 'generate', 2)).toEqual({ ok: true });
  const warmPublishMs = performance.now() - warmed;
  const final = await report();
  const rendered = pixels(await page.screenshot({ path: `${evidencePath}-visual.png` }));
  const sourceDecoded = await call(page, 'meshSourceReady');
  const cancelled = execution === 'task-worker' ? await assertCancelledBuild(page) : undefined;
  let programFailure: unknown;
  if (cancelled !== undefined) {
    expect(cancelled.bytes).toBeGreaterThan(meshMiB * 1024 * 1024 - 48);
    programFailure = await assertFailedTaskProgram(page);
    expect(await call(page, 'generate', 4)).toEqual({ ok: true });
  }
  expect(final).toMatchObject({
    render: { state: 'alive', capabilities: { backendKind: 'webgpu' } },
    fault: null,
  });
  await writeFile(`${evidencePath}-result.json`, JSON.stringify({
    meshMiB, execution, renderer, unconsumedDecoded, sourceDecoded, residency, rendered,
    renderMeshBudget,
    renderMeshStorage: { before: initialRenderMeshStorage, stable: stableRenderMeshStorage },
    requestedToPublishedMs: published - requested,
    publishedToAdoptedMs: adopted - published,
    publishedToFirstVisibleSampleMs: firstVisible - published,
    warmPublishMs, tickGaps, final, cancelled, programFailure,
  }, null, 2));
}

interface PressureSample {
  kind: 'runtime-pack.build' | 'ktx2.transcode';
  priority: 'normal' | 'background';
  worker: number;
  submittedMs: number;
  dispatchedMs: number;
  finishedMs: number;
  status: 'done' | 'fail';
}

async function measureTaskPressure(page: Page, evidencePath: string) {
  const sample = (await call(page, 'taskPressure', 3)) as {
    generated: unknown;
    transcoded: unknown[];
    rows: PressureSample[];
    tickGaps: { samples: number; max: number };
    encodedBytes: number;
  };
  expect(sample.generated).toEqual({ ok: true });
  expect(sample.transcoded).toHaveLength(8);
  for (const texture of sample.transcoded) {
    expect(texture).toMatchObject({
      width: pressureTextureSide, height: pressureTextureSide, format: 'rgba8unorm',
    });
  }
  expect(sample.rows).toHaveLength(9);
  expect(new Set(sample.rows.map(({ worker }) => worker)).size).toBe(1);
  const ordered = [...sample.rows].sort((a, b) => a.dispatchedMs - b.dispatchedMs);
  for (const [index, row] of ordered.entries()) {
    expect(row.status).toBe('done');
    expect(row.dispatchedMs).toBeGreaterThanOrEqual(row.submittedMs);
    expect(row.finishedMs).toBeGreaterThan(row.dispatchedMs);
    expect(row.dispatchedMs).toBeGreaterThanOrEqual(ordered[index - 1]?.finishedMs ?? 0);
  }
  const generation = ordered.find(({ kind }) => kind === 'runtime-pack.build');
  if (generation === undefined) throw new Error('No Runtime Pack build used the measured Worker');
  expect(generation.priority).toBe('background');
  expect(ordered.some(({ kind, priority, finishedMs, dispatchedMs }) =>
    kind === 'ktx2.transcode' && finishedMs > generation.submittedMs &&
    dispatchedMs < generation.dispatchedMs && priority === 'normal')).toBe(true);
  expect(sample.tickGaps.samples).toBeGreaterThan(0);
  await writeFile(`${evidencePath}-task-pressure.json`, JSON.stringify({
    meshMiB,
    encodedBytes: sample.encodedBytes,
    tickGaps: sample.tickGaps,
    tasks: ordered.map((row) => ({
      ...row,
      queueMs: row.dispatchedMs - row.submittedMs,
      dispatchToReplyMs: row.finishedMs - row.dispatchedMs,
    })),
  }, null, 2));
}

async function assertCancelledBuild(page: Page) {
  const result = await call(page, 'cancelBuildAfterMesh') as { bytes: number };
  expect(result).toMatchObject({ code: 'runtime-pack-cancelled', previousPublication: true });
  expect(result.bytes).toBeGreaterThan(0);
  return result;
}

async function assertFailedTaskProgram(page: Page) {
  const result = await call(page, 'failTaskProgram');
  expect(result).toEqual({
    code: 'runtime-pack-execution-failed',
    cause: 'fixture worker module evaluation failed',
    previousPublication: true,
  });
  return result;
}

async function assertUnavailableTaskWorker(page: Page, evidencePath: string) {
  const initial = await inspect(page);
  const before = await call(page, 'catalogRows');
  const result = await call(page, 'generate', 2);
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'runtime-pack-execution-failed',
      detail: { cause: { message: "task kind 'runtime-pack.build' requires a Worker" } },
    },
  });
  const denied = await page.evaluate(() => Reflect.get(globalThis, 'deniedTaskWorkers'));
  expect(denied).toBeGreaterThan(0);
  expect(await call(page, 'catalogRows')).toEqual(before);
  const report = () => host(page, 'report') as Promise<ExecutionReport>;
  const failureFrame = (await report()).render?.completedFrame ?? 0;
  await expect
    .poll(async () => (await report()).render?.completedFrame ?? 0, { timeout: 120000 })
    .toBeGreaterThanOrEqual(failureFrame + 60);
  const final = await report();
  expect(final).toMatchObject({ world: { identity: initial.world }, fault: null });
  expect(await inspect(page)).toMatchObject({ builds: 0, world: initial.world });
  await writeFile(`${evidencePath}-unavailable.json`, JSON.stringify({
    meshMiB, denied, result, failureFrame, final,
  }, null, 2));
}

interface TaskBackingSample {
  readonly packageId: string;
  readonly phase: 'isolate' | 'encode';
  readonly groups: Readonly<Record<string, number>>;
  readonly uniqueBytes: number;
}

interface StagedMeshStorage {
  readonly loadStartedMs: number;
  readonly loadCompletedMs: number;
  readonly old: { mode: string; registryBytes: number; recoveryArtifactBytes: number };
  readonly next: { mode: string; registryBytes: number; recoveryArtifactBytes: number };
  readonly sourceDecoded: readonly boolean[];
  readonly task: readonly (PressureSample & { readonly outputBackingBytes: number })[];
  readonly transfers: readonly {
    requestId: number;
    before: number;
    after: number;
    sentMs: number;
    acceptedMs: number;
    reservation: { requestedMs: number; confirmedMs: number };
    engine: { mode: string; registryBytes: number };
  }[];
}

interface ReplacementDrawTraffic {
  readonly frames: number;
  readonly assetTransfers: readonly { frameId: number; before: number; after: number }[];
}

interface ReplacementStartup {
  readonly navigationToEngineMs: number;
  readonly navigationToRendererMs: number;
  readonly generatorAdmissionMs: number;
}

interface ReplacementFrameMark {
  readonly observedMs: number;
  readonly submitted: number;
  readonly completed: number;
}

interface ReplacementRenderFrames {
  readonly submitted: readonly ReplacementRenderFrame[];
  readonly completed: readonly ReplacementRenderFrame[];
}

interface ReplacementRenderFrame {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly observedMs: number;
  readonly renderSubmitToCompleteMs?: number;
}

interface MeshGpuBufferEvent {
  readonly kind: 'allocate' | 'destroy';
  readonly id: number;
  readonly label: string;
  readonly bytes: number;
  readonly liveBytes: number;
}

function verifyReplacementGpuBuffers(events: readonly MeshGpuBufferEvent[], finalBytes: number) {
  const live = new Map<number, number>();
  let bytes = 0;
  for (const event of events) {
    if (event.kind === 'allocate') {
      expect(live.has(event.id)).toBe(false);
      live.set(event.id, event.bytes);
      bytes += event.bytes;
    } else {
      expect(live.get(event.id)).toBe(event.bytes);
      live.delete(event.id);
      bytes -= event.bytes;
    }
    expect(event.liveBytes).toBe(bytes);
  }
  const vertexBuffers = events.filter((event) => event.label.endsWith('-vbo'));
  expect(vertexBuffers.map((event) => event.kind).sort()).toEqual(['allocate', 'allocate', 'destroy']);
  expect(bytes).toBe(finalBytes);
}

function verifyStagedReplacement(
  usage: 'render' | 'cpu',
  before: NonNullable<RenderInspection['meshResidency']>,
  overlap: NonNullable<RenderInspection['meshResidency']>,
  staged: StagedMeshStorage,
) {
  const backingFloor = meshMiB * 1024 * 1024 - 64;
  const modes = [staged.old, staged.next];
  if (usage === 'cpu') {
    for (const mesh of modes) {
      expect(mesh.mode).toBe('cpu');
      expect(mesh.registryBytes).toBeGreaterThan(backingFloor);
      expect(mesh.recoveryArtifactBytes).toBe(0);
    }
    expect(overlap.publication?.preparedBytes).toBe(0);
    expect(overlap.gpuBuffers).toEqual(before.gpuBuffers);
    expect(staged.transfers).toHaveLength(0);
    return;
  }
  expect(staged.sourceDecoded).toEqual([false, false]);
  for (const mesh of modes) {
    expect(mesh.mode).toBe('render');
    expect(mesh.registryBytes).toBeLessThan(8192);
    expect(mesh.recoveryArtifactBytes).toBeGreaterThan(backingFloor);
  }
  expect(overlap.publication?.preparedBytes).toBe(2 * (before.publication?.preparedBytes ?? 0));
  expect(overlap.publication?.reservedTransferBytes).toBe(0);
  expect(overlap.publication?.peakBudgetBytes).toBeGreaterThanOrEqual(2 * backingFloor);
  expect(overlap.gpuBuffers.activeBytes).toBeGreaterThanOrEqual(2 * backingFloor);
  expect(staged.transfers).toHaveLength(2);
  const replacement = staged.transfers.at(-1);
  expect(replacement?.reservation.requestedMs).toBeGreaterThanOrEqual(staged.loadStartedMs);
  expect(replacement?.acceptedMs).toBeLessThanOrEqual(staged.loadCompletedMs);
  for (const row of staged.transfers) {
    expect(row.before).toBeGreaterThan(backingFloor);
    expect(row.after).toBe(0);
    expect(row.sentMs).toBeGreaterThanOrEqual(row.reservation.confirmedMs);
    expect(row.reservation.confirmedMs).toBeGreaterThanOrEqual(row.reservation.requestedMs);
    expect(row.acceptedMs).toBeGreaterThanOrEqual(row.sentMs);
    expect(row.engine.mode).toBe('cpu');
    expect(row.engine.registryBytes).toBeGreaterThan(backingFloor);
  }
}

function verifyReplacementTraffic(
  usage: 'render' | 'cpu',
  execution: string,
  staged: StagedMeshStorage,
  taskBackings: readonly TaskBackingSample[],
  drawTraffic: ReplacementDrawTraffic,
) {
  const backingFloor = meshMiB * 1024 * 1024 - 64;
  expect(staged.task).toHaveLength(execution === 'task-worker' ? 2 : 0);
  for (const row of staged.task) {
    expect(row.status).toBe('done');
    expect(row.outputBackingBytes).toBeGreaterThan(backingFloor);
  }
  for (const sample of taskBackings) {
    const owned = sample.groups.owned ?? 0;
    expect(owned).toBeGreaterThan(backingFloor);
    if (sample.phase === 'isolate') {
      expect(sample.uniqueBytes).toBe(2 * owned);
    } else {
      expect(sample.groups.encoded).toBe(sample.groups.publication);
      expect(sample.uniqueBytes).toBe(owned + (sample.groups.encoded ?? 0));
    }
  }
  const bulkRows = drawTraffic.assetTransfers.filter((row) => row.before > backingFloor);
  expect(bulkRows).toHaveLength(usage === 'cpu' ? 2 : 0);
  for (const row of bulkRows) expect(row.after).toBe(0);
}

async function measureReplacementMemory(
  page: Page,
  renderer: string,
  generation: string,
  evidence: string,
  startup: ReplacementStartup,
) {
  const usage = renderer === 'split-render' ? 'render' : 'cpu';
  const inspectRender = async () =>
    (await host(page, 'meshResidency')) as NonNullable<RenderInspection['meshResidency']>;
  const report = () => host(page, 'report') as Promise<ExecutionReport>;
  const readDrawTraffic = () => call(page, 'readDrawTraffic') as Promise<ReplacementDrawTraffic>;
  const markFrameWindow = () =>
    call(page, 'markReplacementFrameWindow') as Promise<ReplacementFrameMark>;
  const measurementPath = `${evidence}-replacement-memory.json`;
  await call(page, 'beginReplacementMeasurement');
  await call(page, 'startTickSample');
  const coldRequested = await markFrameWindow();
  expect(await call(page, 'generate', 2)).toEqual({ ok: true });
  const coldPublished = await markFrameWindow();
  const unconsumedDecoded = await call(page, 'meshSourceReady');
  const initial = await call(page, 'mountVisual', usage);
  const coldAdopted = await markFrameWindow();
  expect(initial).toMatchObject({
    read: usage === 'render' ? 'asset-cpu-data-unavailable' : 'available',
    residency: { mode: usage },
  });
  await expect.poll(async () => pixels(await page.screenshot()).count, { timeout: 120_000 })
    .toBeGreaterThan(1000);
  const coldVisible = await markFrameWindow();
  const coldTickGaps = await call(page, 'finishTickSample');
  const firstLoad = {
    meshMiB,
    renderer,
    generation,
    startup,
    cold: {
      requested: coldRequested, published: coldPublished, adopted: coldAdopted,
      visible: coldVisible, tickGaps: coldTickGaps, unconsumedDecoded,
    },
  };
  await writeFile(measurementPath, JSON.stringify(firstLoad, null, 2));
  const beforeImage = await page.screenshot({ path: `${evidence}-before.png` });
  const before = await inspectRender();
  await call(page, 'startTickSample');
  const replacementRequested = await markFrameWindow();
  const requested = performance.now();
  expect(await call(page, 'generateReplacement')).toEqual({ ok: true });
  const published = performance.now();
  const replacementPublished = await markFrameWindow();
  const staged = (await call(page, 'stageReplacement', usage)) as StagedMeshStorage;
  const prepared = performance.now();
  const replacementPrepared = await markFrameWindow();
  const overlap = await inspectRender();
  const readTaskBackings = () => call(page, 'readTaskBackings') as Promise<readonly TaskBackingSample[]>;
  await expect.poll(async () => (await readTaskBackings()).length, { timeout: 15_000 })
    .toBe(generation === 'task-worker' ? 4 : 0);
  const taskBackings = await readTaskBackings();
  const record = { ...firstLoad, before, overlap, staged, taskBackings, requested, published, prepared };
  await writeFile(measurementPath, JSON.stringify(record, null, 2));
  const overlapImage = await page.screenshot();
  expect(pixels(overlapImage)).toEqual(pixels(beforeImage));
  verifyStagedReplacement(usage, before, overlap, staged);
  const adopted = await call(page, 'commitStagedReplacement');
  expect(adopted).toMatchObject({ residency: staged.next });
  const committed = performance.now();
  const replacementCommitted = await markFrameWindow();
  const initialWidth = pixels(beforeImage).width;
  await expect.poll(async () => pixels(await page.screenshot()).width, { timeout: 120_000 })
    .toBeGreaterThan(1.7 * initialWidth);
  const visible = performance.now();
  const ready = (await report()).frame.completed;
  const firstVisibleTraffic = await readDrawTraffic();
  const firstVisibleStorage = await inspectRender();
  const replacementVisible = await markFrameWindow();
  const tickGaps = await call(page, 'finishTickSample');
  await call(page, 'startTickSample');
  const stableStart = await markFrameWindow();
  await expect.poll(async () => (await report()).frame.completed, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(ready + 60);
  await expect.poll(async () => (await markFrameWindow()).completed, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(stableStart.completed + 60);
  const stableEnd = await markFrameWindow();
  const stableTickGaps = await call(page, 'finishTickSample');
  const stableVisual = await call(page, 'inspectVisual');
  const stableSourceDecoded = await call(page, 'meshSourceReady', true);
  const renderFrames = await call(page, 'readReplacementFrameTimings') as ReplacementRenderFrames;
  const final = await inspectRender();
  const execution = await report();
  const drawTraffic = await readDrawTraffic();
  const gpuBuffers = (await call(page, 'readGpuBuffers')) as readonly MeshGpuBufferEvent[];
  await page.screenshot({ path: `${evidence}-after.png` });
  await writeFile(measurementPath, JSON.stringify({
    ...record, final, adopted, committed, visible, execution, tickGaps,
    drawTraffic, firstVisibleTraffic, firstVisibleStorage, gpuBuffers, renderFrames,
    replacement: {
      requested: replacementRequested, published: replacementPublished,
      prepared: replacementPrepared, committed: replacementCommitted, visible: replacementVisible,
    },
    stable: {
      start: stableStart, end: stableEnd, tickGaps: stableTickGaps,
      visual: stableVisual, sourceDecoded: stableSourceDecoded,
    },
    completedFramesAfterVisibility: execution.frame.completed - ready,
  }, null, 2));
  const presented = renderFrames.completed.slice(stableStart.completed, stableEnd.completed);
  const key = ({ deviceGeneration, frameId }: ReplacementRenderFrame) => `${deviceGeneration}:${frameId}`;
  const submitted = new Set(renderFrames.submitted.map(key));
  expect(new Set(presented.map(key)).size).toBeGreaterThanOrEqual(60);
  for (const frame of presented) {
    expect(submitted.has(key(frame))).toBe(true);
    expect(frame.renderSubmitToCompleteMs).toBeGreaterThanOrEqual(0);
  }
  verifyReplacementTraffic(usage, generation, staged, taskBackings, drawTraffic);
  verifyReplacementGpuBuffers(gpuBuffers, final.gpuBuffers.activeBytes + final.gpuBuffers.retiringBytes);
  expect(drawTraffic.assetTransfers).toEqual(firstVisibleTraffic.assetTransfers);
  expect(final.publication?.preparedBytes).toBe(before.publication?.preparedBytes);
  expect(final.gpuBuffers).toEqual(before.gpuBuffers);
  expect(stableVisual).toEqual(adopted);
  if (usage === 'render') expect(stableSourceDecoded).toBe(false);
  expect(execution).toMatchObject({
    engine: { realm: 'worker' },
    render: { state: 'alive', capabilities: { backendKind: 'webgpu' } },
    fault: null,
  });
}

async function exerciseWorkload(page: Page, renderer: string, execution: string, evidence: string) {
  if (taskUnavailable) {
    await assertUnavailableTaskWorker(page, evidence);
    return;
  }
  await measureWorkload(page, renderer, execution, evidence);
  if (taskPressure) await measureTaskPressure(page, evidence);
}

async function verifyReloadedVisual(
  page: Page,
  previous: { handle: number; revision: number; guid: string },
  narrowWidth: number,
  evidence: string,
) {
  const reloaded = await call(page, 'reloadVisual') as { revision: number };
  expect(reloaded).toMatchObject({
    handle: previous.handle,
    guid: previous.guid,
    width: 4,
    read: 'available',
    residency: { mode: 'cpu', cpuRetentionReason: 'cpu-required' },
  });
  expect(reloaded.revision).toBeGreaterThan(previous.revision);
  await expect.poll(async () => pixels(await page.screenshot()).width, { timeout: 120_000 })
    .toBeGreaterThan(1.7 * narrowWidth);
  const frame = await countReadyRenderFrames(page);
  await expect.poll(() => countReadyRenderFrames(page), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(frame + 60);
  const png = await page.screenshot({ path: evidence });
  expect(pixels(png).width).toBeGreaterThan(1.7 * narrowWidth);
  return { reloaded, pixels: pixels(png), completedFramesAfterVisibility: (await countReadyRenderFrames(page)) - frame };
}

function renderDeviceLossHook(channel: string): Plugin {
  return {
    name: 'fixture-render-device-loss',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0]?.endsWith('/packages/app/dist/render-worker-runtime.mjs')) return;
      return `
        const deviceCommand = new BroadcastChannel(${JSON.stringify(channel)});
        let lastDevice;
        const requestDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function (...args) {
          lastDevice = await requestDevice.apply(this, args);
          return lastDevice;
        };
        deviceCommand.onmessage = ({ data }) => {
          if (data !== 'destroy' || lastDevice === undefined) return;
          lastDevice.destroy();
          deviceCommand.postMessage('destroyed');
          deviceCommand.close();
        };
      ${code}`;
    },
  };
}

const destroyRenderDevice = (page: Page, name: string) => page.evaluate((channelName) =>
  new Promise<void>((resolve, reject) => {
    const port = new BroadcastChannel(channelName);
    const timer = setTimeout(() => {
      port.close();
      reject(new Error('Render Worker did not acknowledge native GPUDevice.destroy()'));
    }, 30_000);
    port.onmessage = ({ data }) => {
      if (data !== 'destroyed') return;
      clearTimeout(timer);
      port.close();
      resolve();
    };
    port.postMessage('destroy');
  }), name);

async function checkRecoveredVisual(
  page: Page,
  before: ExecutionReport,
  visual: unknown,
  original: Buffer,
  screenshotPath: string,
) {
  const report = () => host(page, 'report') as Promise<ExecutionReport>;
  await expect
    .poll(async () => (await report()).render, { timeout: 90000 })
    .toMatchObject({ state: 'alive', epoch: (before.render?.epoch ?? 0) + 1 });
  const recovered = await report();
  expect(recovered.world.identity).toBe(before.world.identity);
  expect(await call(page, 'inspectVisual')).toEqual(visual);
  const frame = await countReadyRenderFrames(page);
  try {
    await expect
      .poll(() => countReadyRenderFrames(page), { timeout: 120000 })
      .toBeGreaterThanOrEqual(frame + 60);
  } catch (cause) {
    const trace = await page.evaluate(() => Reflect.get(globalThis, 'recoveryTrace'));
    await writeFile(
      screenshotPath.replace(/\.png$/, '-stalled.json'),
      JSON.stringify({ before, recovered, latest: await report(), trace }, null, 2),
    );
    throw cause;
  }
  const png = await page.screenshot({ path: screenshotPath });
  expect(png.equals(original)).toBe(true);
  return recovered;
}

function fixturePlugins(splitRender: boolean, deviceLossChannel: string) {
  return [
    ...(splitRender && meshMiB === 0 ? [renderDeviceLossHook(deviceLossChannel)] : []),
    ...(taskPressure || replacementMeasurement ? [observeRuntimePackTaskPool(taskPressure)] : []),
    ...(replacementMeasurement ? [
      observeRuntimePackTaskMemory(`${deviceLossChannel}-replacement-memory`),
      observeRuntimePackGpuBuffers(`${deviceLossChannel}-replacement-memory`),
    ] : []),
    executionWorkerEntries([
      '@forgeax/engine/assets-runtime',
      '@forgeax/engine/geometry',
      '@forgeax/engine/pack/source',
      '@forgeax/engine/render',
      '@forgeax/engine/scene',
      '@forgeax/engine/plugin',
      '@forgeax/engine/ecs',
    ]),
    forgeaxShader(),
  ];
}

async function installFixturePageHooks(page: Page, splitRender: boolean) {
  if (taskUnavailable)
    await page.addInitScript(() => {
      const NativeWorker = globalThis.Worker;
      let denied = 0;
      Reflect.set(globalThis, 'deniedTaskWorkers', denied);
      globalThis.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (options?.name === 'forgeax-task') {
            Reflect.set(globalThis, 'deniedTaskWorkers', ++denied);
            throw new DOMException('Task Worker creation unavailable', 'NotSupportedError');
          }
          super(url, options);
        }
      };
    });
  if (splitRender && meshMiB === 0)
    await page.addInitScript(() => {
      const trace: unknown[] = [];
      Reflect.set(globalThis, 'recoveryTrace', trace);
      Reflect.set(globalThis, '__forgeaxFramePhaseDiagnostics', {
        execution: {
          enabled: true,
          failures: 0,
          emit(event: unknown) {
            if (trace.length === 128) trace.shift();
            trace.push(event);
          },
        },
      });
    });
}

// Mac/Windows use native Metal/D3D12. Linux uses SwiftShader for WebGPU correctness.
interface SceneGroupState {
  world: string;
  entities: number[];
  bindings: number[];
  collisions: (number | null)[];
  hits: (number | null)[];
  bodiesReady: boolean;
  pendingBindings?: number[];
  publications?: { digest: string; generation: number; outputSetDigest: string }[];
  adoptedStep: number | null;
  firstFrames: ({
    frameId: number;
    fixedStep: number;
    publicationFixedStep: number;
    recordStageConsumed: boolean;
  } | null)[];
  refusedCode: string | null;
  releaseAcknowledgements: number;
  recoveries: (string | null)[];
}

function sceneGroupStage(stage: string): void {
  console.info(`[runtime-pack-scene-group] ${stage}`);
}

function expectSceneGroupPublication(state: SceneGroupState): void {
  expect(state.publications).toHaveLength(2);
  expect(state.publications?.[0]).toMatchObject({
    digest: expect.any(String), generation: expect.any(Number), outputSetDigest: expect.any(String),
  });
  expect(state.publications?.[1]).toEqual(state.publications?.[0]);
}

async function exerciseSceneGroup(page: Page, evidencePath: string): Promise<void> {
  const report = () => host(page, 'report') as Promise<ExecutionReport>;
  const inspectGroup = () => call(page, 'inspectSceneGroup') as Promise<SceneGroupState>;
  sceneGroupStage('generate and mount the first pair');
  expect(await call(page, 'generate', 1)).toEqual({ ok: true });
  const current = (await call(page, 'mountSceneGroup')) as SceneGroupState;
  expectSceneGroupPublication(current);
  await expect.poll(async () => (await inspectGroup()).bodiesReady).toBe(true);
  // The first visible mesh frame can hold simulation credit during cold pipeline
  // preparation. Observe it before testing the fixed-step collision admission.
  await expect.poll(async () => pixels(await page.screenshot()).count, { timeout: 90_000 })
    .toBeGreaterThan(1000);
  sceneGroupStage('arm and draw the original colliders');
  await call(page, 'armInitialSceneGroup');
  await expect.poll(async () => (await inspectGroup()).collisions).toEqual([1, 1]);
  expect((await inspectGroup()).hits).toEqual([null, null]);
  const oldPicture = await page.screenshot({ path: `${evidencePath}-old.png` });
  expect(pixels(oldPicture).count).toBeGreaterThan(1000);

  sceneGroupStage('generate and prepare the replacement pair');
  expect(await call(page, 'generateReplacement')).toEqual({ ok: true });
  const prepared = (await call(page, 'prepareNextSceneGroup')) as SceneGroupState;
  expectSceneGroupPublication(prepared);
  expect(prepared.publications?.[0]?.digest).not.toBe(current.publications?.[0]?.digest);
  expect(prepared.bindings).toEqual(current.bindings);
  expect(prepared.pendingBindings).toHaveLength(2);
  expect(prepared.pendingBindings).not.toEqual(current.bindings);
  expect(prepared.collisions).toEqual([1, 1]);
  expect(prepared.hits).toEqual([null, null]);
  expect((await page.screenshot()).equals(oldPicture)).toBe(true);

  sceneGroupStage('adopt the replacement and await its first shared frame');
  await call(page, 'admitSceneGroup', 2, 4);
  await expect.poll(async () => (await inspectGroup()).firstFrames.filter(Boolean).length,
    { timeout: 90_000 }).toBe(2);
  const adopted = await inspectGroup();
  expect(adopted).toMatchObject({
    world: current.world,
    bindings: prepared.pendingBindings,
    collisions: [2, 2],
    hits: current.entities,
  });
  const first = adopted.firstFrames[0];
  if (first == null || adopted.adoptedStep === null)
    throw new Error('Scene group has no fixed-step Render Worker receipt');
  expect(first).toMatchObject({
    frameId: expect.any(Number),
    fixedStep: adopted.adoptedStep,
    recordStageConsumed: true,
  });
  expect(first.publicationFixedStep).toBeGreaterThanOrEqual(adopted.adoptedStep);
  expect(adopted.firstFrames[1]).toEqual(first);
  sceneGroupStage('complete 60 frames with the adopted group');
  const start = (await report()).frame.completed;
  await expect.poll(async () => (await report()).frame.completed, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(start + 60);
  const after = await report();
  const newPicture = await page.screenshot({ path: `${evidencePath}-adopted.png` });
  expect(pixels(newPicture).count).toBeGreaterThan(2 * pixels(oldPicture).count);

  sceneGroupStage('reject a stale candidate and draw the retained group');
  await call(page, 'prepareStaleSceneGroup');
  await call(page, 'admitSceneGroup', 3, 1);
  await expect.poll(async () => (await inspectGroup()).recoveries)
    .toEqual(['old-state-retained', 'old-state-retained']);
  const refused = await inspectGroup();
  expect(refused.refusedCode).toEqual(expect.any(String));
  expect(refused).toMatchObject({
    world: current.world,
    bindings: adopted.bindings,
    collisions: [2, 2],
    hits: current.entities,
    adoptedStep: adopted.adoptedStep,
    firstFrames: adopted.firstFrames,
  });
  await call(page, 'cancelRefusedSceneGroup');
  await expect.poll(async () => (await inspectGroup()).releaseAcknowledgements, { timeout: 30_000 })
    .toBe(refused.releaseAcknowledgements + 2);
  const released = await inspectGroup();
  const settled = (await report()).frame.completed;
  await expect.poll(async () => (await report()).frame.completed)
    .toBeGreaterThan(settled);
  const retainedPicture = await page.screenshot({ path: `${evidencePath}-retained.png` });
  expect(retainedPicture.equals(newPicture)).toBe(true);
  const final = await report();
  expect(final).toMatchObject({ render: { state: 'alive', capabilities: { backendKind: 'webgpu' } }, fault: null });
  await writeFile(`${evidencePath}-result.json`, JSON.stringify({
    current, prepared, adopted, refused, released,
    completedAfterAdoption: after.frame.completed - start, final,
  }, null, 2));
}

const workloadTitle = taskUnavailable
  ? '%s %s %s %s rejects generation without a Task Worker and renders 60 more frames'
  : '%s %s %s %s generates and renders assets after Engine Worker startup';
it.each<RuntimePackBrowserCase>(cases)(workloadTitle, (...browserCase) => runRuntimePackCase(...browserCase));
if (meshMiB === 0 && !taskDiagnostic) {
  it('production scene-group adopts Runtime Pack Mesh and collision across Engine and Render Workers', () =>
    runRuntimePackCase(...workerRenderCase, true));
}

async function startRuntimePackFixture(
  mode: RuntimePackBrowserCase[0],
  repository: string,
  root: string,
  temporaryRoot: string,
  splitRender: boolean,
  deviceLossChannel: string,
  sceneGroup: boolean,
) {
  const base = '/games/runtime-worker/';
  const manifestPath = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  if (manifestPath)
    await prepareLiveSyncSharedInputs({
      sourceRoot: repository,
      projectRoot: root,
      temporaryRoot,
      manifestPath,
    });
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await mkdir(resolve(root, 'public'), { recursive: true });
  await writeFile(resolve(root, 'public/pack-index.json'), '[]');
  if (taskPressure)
    await writeFile(resolve(root, 'public/pressure.ktx2'), await encodePressureTexture(repository));
  await symlink(
    resolve(repository, 'packages/engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  await writeFile(resolve(root, 'runtime-packs.ts'), runtimePacksSource);
  for (const name of [
    'execution-bootstrap.ts',
    'runtime-pack-worker-host.mjs',
    'runtime-pack-scene-group.mjs',
  ]) {
    await writeFile(
      resolve(root, name),
      await readFile(
        new URL(`./fixtures/${name.replace('.ts', '.mjs')}`, import.meta.url),
        'utf8',
      ),
    );
  }
  await writeFile(
    resolve(root, 'convex-geometry-fixture.mjs'),
    await readFile(resolve(repository, 'scripts/test/convex-geometry-fixture.mjs')),
  );
  await writeFile(
    resolve(root, 'main.js'),
    "import * as fixture from './runtime-pack-worker-host.mjs'; globalThis.fixture = fixture;",
  );
  await writeFile(
    resolve(root, 'index.html'),
    `<link rel="icon" href="data:,"><style>body{margin:0;background:#151921}canvas{display:block;width:384px;height:384px}</style><canvas width="384" height="384" data-forgeax-render-width-limit="${testQuality.squareSize}" data-forgeax-render-height-limit="${testQuality.squareSize}"></canvas><script type="module" src="/main.js"></script>`,
  );
  const config = {
    root,
    base,
    configFile: false as const,
    logLevel: 'error' as const,
    plugins: fixturePlugins(splitRender, deviceLossChannel),
    define: {
      'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"',
      __FORGEAX_TEST_SCENE_GROUP__: JSON.stringify(sceneGroup),
    },
  };
  if (mode === 'build') {
    if (sceneGroup) sceneGroupStage('build the consumer');
    await build({
      ...config,
      build: {
        target: 'es2022',
        // Match DevKit Host's realm-neutral build (no DOM preload helper).
        modulePreload: false,
        rolldownOptions: {
          preserveEntrySignatures: 'strict',
          input: {
            main: resolve(root, 'index.html'),
            'execution-bootstrap': resolve(root, 'execution-bootstrap.ts'),
          },
          output: { entryFileNames: '[name].js' },
        },
      },
    });
    const server = await preview({
      root,
      base,
      configFile: false,
      logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0 },
    });
    return {
      url: server.resolvedUrls?.local[0],
      close: () => new Promise<void>((done) => server.httpServer.close(() => done())),
    };
  }

  const dev = await createServer({
    ...config,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repository] } },
  });
  try {
    await dev.listen();
    return { url: dev.resolvedUrls?.local[0], close: () => dev.close() };
  } catch (error) {
    await dev.close();
    throw error;
  }
}

async function runRuntimePackCase(
  mode: RuntimePackBrowserCase[0],
  language: RuntimePackBrowserCase[1],
  execution: RuntimePackBrowserCase[2],
  renderer: RuntimePackBrowserCase[3],
  sceneGroup = false,
) {
  const repository = resolve(import.meta.dirname, '../../..');
  const directory = await createLiveSyncProjectDirectory('forgeax-runtime-worker-', repository, process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST);
  const root = await realpath(directory.root);
  const temporaryRoot = await realpath(directory.temporaryRoot);
  const evidence =
    process.env.FORGEAX_RUNTIME_PACK_EVIDENCE ??
    resolve(repository, 'artifacts/runtime-pack-worker');
  const splitRender = renderer !== 'local-render';
  const deviceLossChannel = `fixture-render-device-loss-${crypto.randomUUID()}`;
  const evidenceName = evidenceNameOf(mode, language, execution, renderer) +
    (sceneGroup ? '-scene-group' : '');
  let fixture: Awaited<ReturnType<typeof startRuntimePackFixture>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  try {
    await mkdir(evidence, { recursive: true });
    fixture = await startRuntimePackFixture(
      mode,
      repository,
      root,
      temporaryRoot,
      splitRender,
      deviceLossChannel,
      sceneGroup,
    );
    const { url } = fixture;
    if (!url) throw new Error('Vite URL unavailable');
    const browserEnv = Object.fromEntries(
      ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    const launch = () => {
      const options = runtimeBrowserLaunchOptions();
      return chromium.launch({
        ...options,
        env: browserEnv,
        args: [...options.args, '--disable-gpu-watchdog'],
        chromiumSandbox: true,
      });
    };
    if (sceneGroup) sceneGroupStage('launch Chromium');
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
    await installFixturePageHooks(page, splitRender);
    const workers = new Set();
    const watch = (page: Page) => {
      page.on('worker', (worker) => {
        workers.add(worker);
        worker.on('close', () => workers.delete(worker));
      });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) =>
        errors.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    watch(page);
    const navigationStarted = performance.now();
    await page.goto(url);
    await page.waitForFunction(() => 'fixture' in globalThis);
    if (sceneGroup) sceneGroupStage('start the Engine and Render Workers');
    const opened = await host(
      page,
      'open',
      mode === 'build' ? 'execution-bootstrap.js' : 'execution-bootstrap.ts',
      splitRender,
      taskPressure,
      renderMeshBudget,
      replacementMeasurement ? `${deviceLossChannel}-replacement-memory` : undefined,
    );
    expect(opened).toMatchObject({ engine: { realm: 'worker', health: 'running' }, fault: null });
    const engineReady = performance.now();
    const admit = async () => {
      const sources = (await call(page, 'sources', language, execution, meshMiB)) as Record<string, PackProgramSource>;
      const programs =
        language === 'js'
          ? await call(page, 'prepareJs', sources)
          : Object.fromEntries(
              Object.entries(sources).map(([key, source]) => [key, prepareRuntimePackProgram(source).unwrap()]),
            );
      await call(page, 'admit', programs, language, execution);
    };
    if (splitRender) {
      const report = () => host(page, 'report') as Promise<ExecutionReport>;
      await expect.poll(async () => (await report()).render?.state, { timeout: 90000 }).toBe('alive');
      const rendererReady = performance.now();
      if (sceneGroup) sceneGroupStage('admit the Task Worker generator');
      await admit();
      const generatorAdmitted = performance.now();
      if (sceneGroup) {
        await exerciseSceneGroup(page, resolve(evidence, evidenceName));
        expect(await host(page, 'close')).toMatchObject({ errors: [], pending: 0 });
        await expect.poll(() => workers.size).toBe(0);
        expect(errors).toEqual([]);
        return;
      }
      if (meshMiB > 0) {
        const path = resolve(evidence, evidenceName);
        if (replacementMeasurement) {
          await measureReplacementMemory(page, renderer, execution, path, {
            navigationToEngineMs: engineReady - navigationStarted,
            navigationToRendererMs: rendererReady - navigationStarted,
            generatorAdmissionMs: generatorAdmitted - rendererReady,
          });
        } else {
          await exerciseWorkload(page, renderer, execution, path);
        }
        expect(await host(page, 'close')).toMatchObject({ errors: [], pending: 0 });
        await expect.poll(() => workers.size).toBe(0);
        expect(errors).toEqual([]);
        return;
      }
      expect(await call(page, 'generate', 2)).toEqual({ ok: true });
      expect(await call(page, 'meshSourceReady')).toBe(false);
      const visual = await call(page, 'mountVisual') as {
        handle: number; revision: number; guid: string; read: string;
        residency: { mode: string; recoveryArtifactBytes: number; recoveryArtifactStorage?: string };
      };
      expect(visual.read).toBe('asset-cpu-data-unavailable');
      expect(visual.residency.mode).toBe('render');
      expect(visual.residency.recoveryArtifactBytes).toBeGreaterThan(0);
      expect(visual.residency.recoveryArtifactStorage).toBe('publication');
      expect(await call(page, 'meshSourceReady')).toBe(false);
      const before = await countReadyRenderFrames(page);
      await expect.poll(() => countReadyRenderFrames(page), { timeout: 120000 }).toBeGreaterThanOrEqual(before + 60);
      const visualPng = await page.screenshot({
        path: resolve(evidence, `${evidenceName}-visual.png`),
      });
      const rendered = pixels(visualPng);
      expect(rendered.count).toBeGreaterThan(1000);
      expect(await call(page, 'pickVisual')).toMatchObject({
        status: 'unavailable', reason: 'cpu-geometry-unavailable', boundsHit: true,
      });
      await assertCancelledBuild(page);
      await assertFailedTaskProgram(page);
      // The active Mesh still uses width 2 after its source publishes width 4.
      expect(await call(page, 'generate', 4)).toEqual({ ok: true });
      expect(await call(page, 'inspectVisual')).toEqual(visual);
      const old = await report();
      await call(page, 'terminateRender');
      const recovered = await checkRecoveredVisual(
        page, old, visual, visualPng, resolve(evidence, `${evidenceName}-recovered.png`),
      );
      const beforeDeviceLoss = await report();
      await destroyRenderDevice(page, deviceLossChannel);
      const recoveredDevice = await checkRecoveredVisual(
        page, beforeDeviceLoss, visual, visualPng, resolve(evidence, `${evidenceName}-recovered-device.png`),
      );
      const full = await call(page, 'readVisual');
      expect(full).toEqual({ handle: visual.handle, revision: visual.revision, typed: true });
      expect(await call(page, 'pickVisual')).toMatchObject({ status: 'hit', boundsHit: true });
      const promoted = await countReadyRenderFrames(page);
      await expect
        .poll(() => countReadyRenderFrames(page), { timeout: 90000 })
        .toBeGreaterThanOrEqual(promoted + 10);
      const cpuPng = await page.screenshot({ path: resolve(evidence, `${evidenceName}-cpu.png`) });
      const after = pixels(cpuPng);
      expect(after).toEqual(rendered);
      expect(cpuPng.equals(visualPng)).toBe(true);
      const sameGuidReplacement = await verifyReloadedVisual(
        page, visual, rendered.width, resolve(evidence, `${evidenceName}-reloaded.png`),
      );
      const final = await report();
      expect(final).toMatchObject({
        render: { state: 'alive', capabilities: { backendKind: 'webgpu' } },
        fault: null,
      });
      expect(await host(page, 'close')).toMatchObject({ errors: [], pending: 0 });
      await expect.poll(() => workers.size).toBe(0);
      expect(errors).toEqual([]);
      await writeFile(
        resolve(evidence, `${evidenceName}-result.json`),
        JSON.stringify({ visual, full, rendered, recovered, recoveredDevice, after, sameGuidReplacement, final }, null, 2),
      );
      return;
    }
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(2);
    expect(
      await page.locator('canvas').evaluate((canvas) => [
        Number(canvas.getAttribute('width')), Number(canvas.getAttribute('height')),
      ]),
    ).toEqual([testQuality.squareSize, testQuality.squareSize]);
    const initial = await inspect(page);
    expect(initial).toMatchObject({
      packs: 0,
      programs: 0,
      renderer: 'alive',
      unrelated: [12, 3, 1],
    });
    await admit();
    const generation = await call(page, 'generate', 2);
    expect(generation, JSON.stringify(generation)).toEqual({ ok: true });
    expect(await call(page, 'replace')).toMatchObject({
      width: 2,
      typed: true,
      world: initial.world,
      unrelated: [12, 3, 1],
    });
    expect(await call(page, 'install')).toEqual({ lazy: true, lazyExecutor: true, active: 1 });
    expect(await call(page, 'tool')).toMatchObject({
      outcome: 'succeeded',
      result: { value: 42, active: 1 },
    });
    const first = await inspect(page);
    if (core && coreDeliveryCases.has(evidenceName)) {
      await expect
        .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
        .toBeGreaterThan(first.frames.ready);
      expect(first.frames.errors).toEqual([]);
      expect(first.frames.backends).toEqual(['webgpu']);
      expect(await call(page, 'disposePlugin')).toMatchObject({ state: 'disposed', pluginActive: 0 });
      expect(await host(page, 'close')).toMatchObject({ errors: [], pending: 0 });
      await expect.poll(() => workers.size).toBe(0);
      expect(errors).toEqual([]);
      await writeFile(
        resolve(evidence, `${mode}-${language}-result.json`),
        JSON.stringify({ scope: 'delivery', initial, first, errors }, null, 2),
      );
      return;
    }
    // Cold GPU preparation can hold World frame credits. Check gameplay
    // progress after the existing completed-frame gate releases them.
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(first.frames.ready + 10);
    expect((await inspect(page)).pluginTicks).toBeGreaterThan(first.pluginTicks);
    expect(first.builds).toBe(execution === 'engine' ? 1 : 0);
    const narrowImage = await page.screenshot({
      path: resolve(evidence, `${evidenceName}-width-2.png`),
    });
    const narrowPixels = pixels(narrowImage);
    expect(await call(page, 'generate', 2)).toEqual({ ok: true });
    expect((await inspect(page)).builds).toBe(first.builds);
    expect(await call(page, 'generate', 4)).toEqual({ ok: true });
    expect((await inspect(page)).width).toBe(2);
    const replacement = (await call(page, 'replace')) as Inspection;
    expect(replacement).toMatchObject({
      width: 4,
      typed: true,
      refs: first.refs,
      world: initial.world,
      unrelated: [12, 3, 1],
      pluginActive: 1,
    });
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(replacement.frames.ready + 10);
    const wideImage = await page.screenshot({
      path: resolve(evidence, `${evidenceName}-width-4.png`),
    });
    const widePixels = pixels(wideImage);
    expect(narrowPixels.count).toBeGreaterThan(1000);
    expect(widePixels.width).toBeGreaterThan(narrowPixels.width * 1.7);
    expect(widePixels.count).toBeGreaterThan(narrowPixels.count * 1.7);
    expect(Math.abs(widePixels.height - narrowPixels.height)).toBeLessThanOrEqual(3);
    const publication = await call(page, 'publication');
    const beforeInvalid = await inspect(page);
    expect(await call(page, 'generate', 6)).toMatchObject({ ok: false });
    expect(await call(page, 'publication')).toEqual(publication);
    expect((await inspect(page)).builds).toBe(beforeInvalid.builds);
    expect(await call(page, 'generate', 3, true)).toMatchObject({ ok: false });
    expect(await call(page, 'publication')).toEqual(publication);
    expect((await inspect(page)).width).toBe(4);
    await writeFile(
      resolve(evidence, `${evidenceName}-snapshot.json`),
      JSON.stringify(await call(page, 'snapshot')),
    );
    expect(await call(page, 'withdraw')).toMatchObject({ programs: 0, width: 4, pluginActive: 1 });
    expect(await call(page, 'tool')).toMatchObject({
      outcome: 'succeeded',
      result: { value: 42, active: 1 },
    });
    const withdrawn = await inspect(page);
    await expect
      .poll(async () => (await inspect(page)).pluginTicks)
      .toBeGreaterThan(withdrawn.pluginTicks);
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 120000 })
      .toBeGreaterThanOrEqual(first.frames.ready + 60);
    const detached = (await call(page, 'disposePlugin')) as Inspection;
    expect(detached).toMatchObject({ state: 'disposed', pluginActive: 0 });
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 120000 })
      .toBeGreaterThan(detached.frames.ready + 10);
    const final = await inspect(page);
    expect(final.pluginTicks).toBe(detached.pluginTicks);
    expect(final.gameTicks).toBeGreaterThan(initial.gameTicks);
    expect(final.frames.errors).toEqual([]);
    expect(final.frames.backends).toEqual(['webgpu']);
    expect(final).toMatchObject({
      world: initial.world,
      unrelated: [12, 3, 1],
      width: 4,
      renderer: 'alive',
    });
    const report = (await host(page, 'report')) as ExecutionReport;
    expect(report).toMatchObject({ engine: { realm: 'worker', health: 'running' }, fault: null });
    expect(report.frame.completed).toBeGreaterThanOrEqual(60);
    const closed = await host(page, 'close');
    expect(closed).toMatchObject({ errors: [], pending: 0 });
    await expect.poll(() => workers.size).toBe(0);
    expect(errors).toEqual([]);
    let recovery: unknown;
    if (mode === 'build') {
      // Close the process, preserve only the saved Pack, then prepare the new
      // consumer's Engine modules, empty Catalog and Host SW.
      // No generated program has been admitted in this new browser yet.
      await browser.close();
      expect(browser.isConnected()).toBe(false);
      browser = await launch();
      const context = await browser.newContext({ viewport: { width: 384, height: 384 } });
      const restored = await context.newPage();
      watch(restored);
      await restored.goto(url);
      await restored.waitForFunction(() => 'fixture' in globalThis);
      await host(restored, 'open', 'execution-bootstrap.js');
      await expect
        .poll(async () => (await inspect(restored)).frames.ready, { timeout: 90000 })
        .toBeGreaterThan(2);
      const empty = await inspect(restored);
      expect(empty).toMatchObject({ packs: 0, programs: 0, builds: 0, pluginTicks: 0 });
      // World identity is realm-local and may restart at world-1 in a new process.
      await call(restored, 'publication');
      expect(await restored.evaluate(() => caches.keys())).toEqual([]);
      expect(await host(restored, 'prepareDelivery')).toHaveProperty('scope');
      expect(
        await restored.evaluate(
          async () =>
            (
              await Promise.all(
                (await caches.keys()).map(async (name) => (await caches.open(name)).keys()),
              )
            ).flat().length,
        ),
      ).toBe(0);
      const saved = JSON.parse(
        await readFile(resolve(evidence, `${evidenceName}-snapshot.json`), 'utf8'),
      );
      // Legacy local builds also prove offline replay. Worker builds re-fetch
      // the deployed Task Worker entry in this fresh browser process.
      const recoveryMode = execution === 'engine' ? 'offline' : 'cold';
      if (recoveryMode === 'offline') await context.setOffline(true);
      await call(restored, 'restore', saved);
      const recovered = (await call(restored, 'replace')) as Inspection;
      expect(recovered).toMatchObject({ width: 4, typed: true, world: empty.world });
      expect(await call(restored, 'install')).toEqual({
        lazy: true,
        lazyExecutor: true,
        active: 1,
      });
      expect(await call(restored, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      expect(await call(restored, 'generate', 2)).toEqual({ ok: true });
      const regenerated = (await call(restored, 'replace')) as Inspection;
      expect(regenerated).toMatchObject({ width: 2, typed: true, world: empty.world });
      await expect
        .poll(async () => (await inspect(restored)).frames.ready, { timeout: 120000 })
        .toBeGreaterThanOrEqual(regenerated.frames.ready + 60);
      expect((await inspect(restored)).pluginTicks).toBeGreaterThan(2);
      const offlineImage = await restored.screenshot({
        path: resolve(evidence, `${evidenceName}-${recoveryMode}.png`),
      });
      const offlinePixels = pixels(offlineImage);
      expect(offlinePixels).toEqual(narrowPixels);
      const offlineFinal = await inspect(restored);
      expect(offlineFinal.frames.errors).toEqual([]);
      expect(offlineFinal.pluginActive).toBe(1);
      expect(offlineFinal.pluginTicks).toBeGreaterThan(regenerated.pluginTicks);
      const offlineDetached = (await call(restored, 'disposePlugin')) as Inspection;
      expect(offlineDetached).toMatchObject({ state: 'disposed', pluginActive: 0 });
      await expect
        .poll(async () => (await inspect(restored)).frames.ready)
        .toBeGreaterThan(offlineDetached.frames.ready + 10);
      expect((await inspect(restored)).pluginTicks).toBe(offlineDetached.pluginTicks);
      expect(offlineFinal.frames.backends).toEqual(['webgpu']);
      const offlineClosed = await host(restored, 'close');
      expect(offlineClosed).toMatchObject({ errors: [], pending: 0 });
      await expect.poll(() => workers.size).toBe(0);
      expect(errors).toEqual([]);
      recovery = { recoveryMode, empty, recovered, regenerated, offlinePixels, offlineFinal, offlineClosed };
    }
    await writeFile(
      resolve(evidence, `${evidenceName}-result.json`),
      JSON.stringify(
        {
          initial,
          first,
          replacement,
          detached,
          final,
          report,
          closed,
          recovery,
          narrowPixels,
          widePixels,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      resolve(evidence, `${evidenceName}-failure.json`),
      JSON.stringify({ errors, message: String(error) }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    await fixture?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
