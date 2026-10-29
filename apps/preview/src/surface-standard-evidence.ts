import { type AssetKind, encodeBase64 } from '@forgeax/engine/types';
import type { App } from '@forgeax/engine-app';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  perspective,
  type RenderError,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import {
  assetGuid,
  PACKAGE_IDS,
  RUSTED_IRON_MATERIAL_GUID,
} from '../../../templates/game-3d/assets/shared/asset-refs';
import { surfaceEvidenceGuid } from './surface-standard-evidence-identity';

const DEFAULT_PHYSICAL_SOURCE_KEY = 'material/painted-evidence';
const CUSTOM_PHYSICAL_SOURCE_KEY = 'material/rusted-iron-custom-physical';
const DEFAULT_BASE_GUID = AssetGuid.format(assetGuid(PACKAGE_IDS.materials, 'material/ground'));
const CUSTOM_BASE_GUID = AssetGuid.format(RUSTED_IRON_MATERIAL_GUID);

const CELLS = [
  {
    id: 'default-base',
    guid: DEFAULT_BASE_GUID,
    sourceKey: 'material/ground',
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'custom-base',
    guid: CUSTOM_BASE_GUID,
    sourceKey: 'material/rusted-iron',
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'default-physical',
    guid: surfaceEvidenceGuid(DEFAULT_PHYSICAL_SOURCE_KEY),
    sourceKey: 'apps/preview/assets/surface-standard-evidence.pack.ts#material/painted-evidence',
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
  {
    id: 'custom-physical',
    guid: surfaceEvidenceGuid(CUSTOM_PHYSICAL_SOURCE_KEY),
    sourceKey:
      'apps/preview/assets/surface-standard-evidence.pack.ts#material/rusted-iron-custom-physical',
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
] as const;

const EVIDENCE_SOURCE_SHA =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable';
const EVIDENCE_BUILD_ID =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? 'unavailable';
const SURFACE_WIDTH = 960;
const SURFACE_HEIGHT = 540;

function sampleWebgl2Cell(
  pixels: Uint8Array,
  width: number,
  height: number,
  index: number,
): { sample: number[]; signalPixels: number; x: number; y: number } {
  const startX = Math.floor((index * width) / CELLS.length);
  const endX = Math.max(startX + 1, Math.floor(((index + 1) * width) / CELLS.length));
  const candidates: Array<{ sample: number[]; x: number; y: number }> = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = startX; x < endX; x += 4) {
      const offset = (y * width + x) * 4;
      const sample = [...pixels.slice(offset, offset + 4)];
      if ((sample[0] ?? 0) + (sample[1] ?? 0) + (sample[2] ?? 0) > 0) {
        candidates.push({ sample, x, y });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      (left.sample[0] ?? 0) +
      (left.sample[1] ?? 0) +
      (left.sample[2] ?? 0) -
      ((right.sample[0] ?? 0) + (right.sample[1] ?? 0) + (right.sample[2] ?? 0)),
  );
  const selected = candidates[Math.floor(candidates.length / 2)];
  if (selected !== undefined) return { ...selected, signalPixels: candidates.length };
  const x = Math.min(width - 1, Math.max(0, Math.floor(((index + 0.5) * width) / CELLS.length)));
  const y = Math.floor(height / 2);
  const offset = (y * width + x) * 4;
  return { sample: [...pixels.slice(offset, offset + 4)], signalPixels: 0, x, y };
}

async function exportPixels(
  backend: string,
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  format: string,
  origin: 'top-left' | 'bottom-left',
): Promise<void> {
  const receive = (
    globalThis as { __forgeaxCapturePixels?: (payload: Record<string, unknown>) => Promise<void> }
  ).__forgeaxCapturePixels;
  if (receive === undefined) return;
  await receive({
    backend,
    width,
    height,
    bytesPerRow,
    format,
    origin,
    base64: encodeBase64(bytes),
  });
}

function sourceClosureFor(cell: (typeof CELLS)[number]): readonly string[] {
  if (cell.id === 'custom-base') {
    return [
      'templates/game-3d/assets/materials.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ];
  }
  if (cell.id === 'custom-physical') {
    return [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ];
  }
  if (cell.id === 'default-physical') {
    return ['apps/preview/assets/surface-standard-evidence.pack.ts'];
  }
  return ['templates/game-3d/assets/materials.pack.ts'];
}

export interface SurfaceStandardEvidenceOptions {
  /** Keep the normal Preview frame loop paused while this isolated lane owns the renderer. */
  readonly resumeApp?: boolean;
}

type SurfaceEvidence = Record<string, unknown>;
type SurfaceCell = (typeof CELLS)[number];
type AppAssets = NonNullable<App['assets']>;
type AppRenderer = App['renderer'];
type PublicationRow = Awaited<ReturnType<typeof readPublicationRow>>;
type LoadedCell = Awaited<ReturnType<typeof loadSurfaceMaterials>>[number];
type CellReadback = ReturnType<typeof sampleWebgl2Cell>;
interface CatalogRow {
  guid: string;
  sourceKey?: string;
  packageUrl: string;
  publication?: { generation?: number };
}
interface RhiCaptureOutcome {
  readonly rhiDebugCapture: unknown;
  readonly preCapturePixels: Uint8Array | undefined;
}

const COMPLETED_FRAME_TARGET = 60;

function unavailableEvidence(blocker: Record<string, unknown>): SurfaceEvidence {
  return { status: 'unavailable', blocker, cells: [] };
}

function searchParam(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function captureCanvasFrame(frame: number): Promise<void> {
  const captureCanvas = (
    globalThis as { __forgeaxCaptureCanvas?: (frame: number) => Promise<void> }
  ).__forgeaxCaptureCanvas;
  await captureCanvas?.(frame);
}

function countSignalPixels(bytes: Uint8Array): number {
  let signalPixels = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    if ((bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) + (bytes[offset + 2] ?? 0) > 0)
      signalPixels += 1;
  }
  return signalPixels;
}

function identityCollisionEvidence(): SurfaceEvidence | undefined {
  const guidOwners = new Map<string, string[]>();
  for (const cell of CELLS) {
    const owners = guidOwners.get(cell.guid) ?? [];
    owners.push(cell.id);
    guidOwners.set(cell.guid, owners);
  }
  const identityCollision = [...guidOwners.entries()].find(([, owners]) => owners.length > 1);
  if (identityCollision === undefined) return undefined;
  return unavailableEvidence({
    code: 'surface-publication-identity-collision',
    stage: 'publication',
    detail: {
      guid: identityCollision[0],
      cells: identityCollision[1],
      expected:
        'each root contract has a unique GUID or an observed publication generation from Catalog',
      observed:
        'custom-physical reuses the custom-base GUID and no Catalog publication generation is exposed',
      sourceSha: EVIDENCE_SOURCE_SHA,
      buildId: EVIDENCE_BUILD_ID,
    },
  });
}

async function readPublicationRow(cell: SurfaceCell, catalog: readonly CatalogRow[]) {
  const row = catalog.find((entry) => entry.guid.toLowerCase() === cell.guid);
  if (row === undefined || row.packageUrl.length === 0) return { cell, row };
  const response = await fetch(row.packageUrl);
  if (!response.ok) return { cell, row };
  const pack = (await response.json()) as { generation?: unknown; digest?: unknown };
  return {
    cell,
    row,
    publicationGeneration:
      typeof pack.generation === 'number' && Number.isSafeInteger(pack.generation)
        ? pack.generation
        : undefined,
    publicationDigest: typeof pack.digest === 'string' ? pack.digest : undefined,
  };
}

function missingPublicationEvidence(
  publicationRows: readonly PublicationRow[],
): SurfaceEvidence | undefined {
  const missingPublication = publicationRows.find(
    ({ row, publicationGeneration }) =>
      row?.sourceKey === undefined || publicationGeneration === undefined,
  );
  if (missingPublication === undefined) return undefined;
  return unavailableEvidence({
    code: 'surface-publication-tuple-unavailable',
    stage: 'publication',
    detail: {
      cell: missingPublication.cell.id,
      guid: missingPublication.cell.guid,
      sourceKey: missingPublication.row?.sourceKey,
      publicationGeneration: missingPublication.publicationGeneration,
      expected:
        'Catalog to expose the published sourceKey and publication generation for every cooked root',
      observed: 'the Preview runtime catalog row does not expose a complete publication tuple',
      sourceSha: EVIDENCE_SOURCE_SHA,
      buildId: EVIDENCE_BUILD_ID,
    },
  });
}

function createIsolatedEvidenceAssets(appAssets: AppAssets): AssetRegistry {
  return new AssetRegistry({
    shaderRegistry: appAssets.shaderRegistry,
    ...(appAssets.catalogSource === undefined ? {} : { catalog: appAssets.catalogSource }),
    fetcher: appAssets.fetchAsset,
  });
}

function loadSurfaceMaterials(assets: AppAssets) {
  return Promise.all(
    CELLS.map(async (cell) => ({
      cell,
      result: await assets.load(cell.guid, 'material'),
    })),
  );
}

export async function captureSurfaceStandardEvidence(
  app: App,
  options: SurfaceStandardEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  const resumeApp = options.resumeApp ?? true;
  const appAssets = app.assets;
  if (appAssets === undefined) {
    return unavailableEvidence({ code: 'asset-registry-unavailable', stage: 'load' });
  }
  const identityCollision = identityCollisionEvidence();
  if (identityCollision !== undefined) return identityCollision;
  const catalog = appAssets.listCatalog() as readonly CatalogRow[];
  const publicationRows = await Promise.all(CELLS.map((cell) => readPublicationRow(cell, catalog)));
  const missingPublication = missingPublicationEvidence(publicationRows);
  if (missingPublication !== undefined) return missingPublication;
  const captureInAppWorld = searchParam('rhiCapture') === '1';
  const assets = captureInAppWorld ? appAssets : createIsolatedEvidenceAssets(appAssets);
  try {
    if (!captureInAppWorld) {
      for (const contribution of defaultAssetDecoderContributions)
        assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
    }
    return await renderSurfaceEvidence(app, assets, captureInAppWorld, resumeApp, publicationRows);
  } finally {
    if (!captureInAppWorld) assets.dispose();
  }
}

async function renderSurfaceEvidence(
  app: App,
  assets: AppAssets,
  captureInAppWorld: boolean,
  resumeApp: boolean,
  publicationRows: readonly PublicationRow[],
): Promise<SurfaceEvidence> {
  const loaded = await loadSurfaceMaterials(assets);
  const missing = loaded.find((entry) => !entry.result.ok);
  if (missing !== undefined) {
    return unavailableEvidence({
      code: 'surface-pack-load-failed',
      stage: 'load',
      detail: missing.cell.id,
    });
  }
  const world = captureInAppWorld ? app.world : new World({ assets });
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const stopped = resumeApp ? app.stop() : undefined;
  if (stopped !== undefined && !stopped.ok) {
    return unavailableEvidence({ code: 'surface-preview-stop-failed', stage: 'setup' });
  }
  const attached = app.renderer.attach(world);
  if (!attached.ok) {
    if (resumeApp) app.start();
    return unavailableEvidence({
      code: 'surface-renderer-attach-failed',
      stage: 'attach',
      detail: attached.error.code,
    });
  }
  const renderErrors: unknown[] = [];
  const unsubscribeRenderErrors = app.renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    renderErrors.push({
      code: event.error.code,
      expected: event.error.expected,
      hint: event.error.hint,
      ...('detail' in event.error ? { detail: event.error.detail } : {}),
    });
  });
  const lease = attached.value;
  try {
    if (!spawnSurfaceScene(world, sceneAssets, loaded)) {
      return unavailableEvidence({ code: 'surface-geometry-failed', stage: 'setup' });
    }
    const isWebGpuCapture = searchParam('surfaceCapture') === '1';
    const frameFailure = await renderEvidenceFrames(
      app,
      world,
      lease,
      renderErrors,
      isWebGpuCapture,
    );
    if (frameFailure !== undefined) return frameFailure;
    if (isWebGpuCapture) {
      await nextAnimationFrame();
      await captureCanvasFrame(COMPLETED_FRAME_TARGET);
    }
    const rhiCapture: RhiCaptureOutcome =
      searchParam('rhiCapture') === '1'
        ? await captureRhiDebugTape(app)
        : { rhiDebugCapture: undefined, preCapturePixels: undefined };
    await nextAnimationFrame();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const inspection = app.renderer.inspect();
    if (isWebGpuCapture && inspection.capabilities.backendKind === 'webgpu') {
      return webGpuSurfaceEvidence(renderErrors, publicationRows);
    }
    return await webgl2SurfaceEvidence(
      assets,
      loaded,
      publicationRows,
      renderErrors,
      rhiCapture,
      inspection,
    );
  } finally {
    lease.dispose();
    unsubscribeRenderErrors();
    if (resumeApp) app.start();
  }
}

function spawnSurfaceScene(
  world: World,
  sceneAssets: AssetRegistry,
  loaded: readonly LoadedCell[],
): boolean {
  const plane = createPlaneGeometry(1.3, 1.3);
  if (!plane.ok) return false;
  const mesh = sceneAssets.create(plane.value).unwrap();
  for (let index = 0; index < loaded.length; index += 1) {
    const entry = loaded[index];
    if (entry === undefined || !entry.result.ok) continue;
    const x = (index - 1.5) * 1.45;
    const material = entry.result.value;
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 4,
            aspect: SURFACE_WIDTH / SURFACE_HEIGHT,
            near: 0.1,
            far: 20,
          }),
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
    })
    .unwrap();
  return true;
}

// Authored Surface PSOs are compiled lazily on first use. Submit the same
// world through the real Renderer until those immutable pipelines are
// ready, matching the Browser/Dawn evidence lanes instead of treating a
// first-touch skip-draw as a backend failure.
async function renderEvidenceFrames(
  app: App,
  world: World,
  lease: RenderWorldLease,
  renderErrors: unknown[],
  isWebGpuCapture: boolean,
): Promise<SurfaceEvidence | undefined> {
  const frameInspections: unknown[] = [];
  const captureFrames = new Set([0, COMPLETED_FRAME_TARGET - 1]);
  for (let frame = 0; frame < COMPLETED_FRAME_TARGET; frame += 1) {
    world.update(1 / 60).unwrap();
    const finalWebGpuFrame = isWebGpuCapture && frame === COMPLETED_FRAME_TARGET - 1;
    if (finalWebGpuFrame) armFinalDisplayObservation(app.renderer);
    const draw = app.renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'direct',
    });
    if (!draw.ok) return drawFailureEvidence(draw.error, renderErrors);
    if (finalWebGpuFrame) await readSwapchainEvidence(app.renderer);
    const completion = await draw.value.completed;
    if (!completion.ok) return completionFailureEvidence(completion.error, renderErrors);
    if (isWebGpuCapture && captureFrames.has(frame)) {
      await recordFrameInspection(app.renderer, draw.value, frame, renderErrors, frameInspections);
    }
  }
  Object.assign(globalThis, { __forgeaxSurfaceFrameInspections: frameInspections });
  return undefined;
}

function armFinalDisplayObservation(renderer: AppRenderer): void {
  const armed = renderer.requestObservation?.(['final-display']);
  if (armed !== undefined && !armed.ok) {
    Object.assign(globalThis, {
      __forgeaxWebGpuFinalReadback: {
        ok: false,
        error: armed.error.code,
        detail: 'detail' in armed.error ? armed.error.detail : undefined,
      },
    });
  }
}

function drawFailureEvidence(error: RenderError, renderErrors: unknown[]): SurfaceEvidence {
  return unavailableEvidence({
    code: 'surface-render-failed',
    stage: 'draw',
    detail: {
      code: error.code,
      message: error.message,
      expected: 'expected' in error ? error.expected : undefined,
      hint: 'hint' in error ? error.hint : undefined,
      cause: 'cause' in error ? String(error.cause) : undefined,
      detail: 'detail' in error ? error.detail : undefined,
      renderErrors,
    },
  });
}

function completionFailureEvidence(error: RenderError, renderErrors: unknown[]): SurfaceEvidence {
  return unavailableEvidence({
    code: 'surface-render-completion-failed',
    stage: 'draw',
    detail: {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: 'detail' in error ? error.detail : undefined,
      renderErrors,
    },
  });
}

async function readSwapchainEvidence(renderer: AppRenderer): Promise<void> {
  const native = renderer.nativeDevice();
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  const context = canvas?.getContext('webgpu');
  if (
    !native.ok ||
    canvas === null ||
    canvas === undefined ||
    context === null ||
    context === undefined
  ) {
    return;
  }
  let buffer: GPUBuffer | undefined;
  try {
    const width = canvas.width;
    const height = canvas.height;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    buffer = native.value.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = native.value.createCommandEncoder();
    const swapchainTexture = context.getCurrentTexture();
    encoder.copyTextureToBuffer(
      { texture: swapchainTexture },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    native.value.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    Object.assign(globalThis, {
      __forgeaxWebGpuSwapchainReadback: {
        ok: true,
        width,
        height,
        format: swapchainTexture.format,
        signalPixels: countSignalPixels(bytes),
      },
    });
    await exportPixels(
      'webgpu-swapchain',
      bytes,
      width,
      height,
      bytesPerRow,
      swapchainTexture.format,
      'top-left',
    );
  } catch (cause) {
    Object.assign(globalThis, {
      __forgeaxWebGpuSwapchainReadback: { ok: false, cause: String(cause) },
    });
  } finally {
    buffer?.destroy();
  }
}

async function recordFrameInspection(
  renderer: AppRenderer,
  receipt: FrameReceipt,
  frame: number,
  renderErrors: unknown[],
  frameInspections: unknown[],
): Promise<void> {
  const inspection = renderer.inspect();
  frameInspections.push({
    frame,
    observation: inspection.observation,
    renderScene: inspection.renderScene,
    frustumStats: inspection.frustumStats,
    passes: inspection.perFramePassNames,
    renderErrors,
  });
  if (frame === COMPLETED_FRAME_TARGET - 1) await recordFinalDisplayReadback(renderer, receipt);
  await captureCanvasFrame(frame);
}

async function recordFinalDisplayReadback(
  renderer: AppRenderer,
  receipt: FrameReceipt,
): Promise<void> {
  const readback = await renderer.observe(receipt, { include: ['final-display'] });
  const display = readback.ok
    ? readback.value.observations?.find((entry) => entry.domain === 'final-display')
    : undefined;
  const bytes = display?.bytes;
  const signalPixels = bytes === undefined ? 0 : countSignalPixels(bytes);
  Object.assign(globalThis, {
    __forgeaxWebGpuFinalReadback: {
      ok: readback.ok,
      error: readback.ok ? undefined : readback.error.code,
      detail: readback.ok
        ? undefined
        : 'detail' in readback.error
          ? readback.error.detail
          : undefined,
      metadata: display?.metadata,
      signalPixels,
    },
  });
  if (bytes !== undefined && display !== undefined) {
    await exportPixels(
      'webgpu',
      bytes,
      display.metadata.width,
      display.metadata.height,
      display.metadata.bytesPerRow,
      display.metadata.format,
      'top-left',
    );
  }
}

function readCanvasPixelsBeforeCapture(): Uint8Array | undefined {
  const canvasBeforeCapture = document.querySelector<HTMLCanvasElement>('#app');
  const glBeforeCapture = canvasBeforeCapture?.getContext('webgl2');
  if (
    canvasBeforeCapture === null ||
    canvasBeforeCapture === undefined ||
    glBeforeCapture === null ||
    glBeforeCapture === undefined
  ) {
    return undefined;
  }
  const preCapturePixels = new Uint8Array(
    canvasBeforeCapture.width * canvasBeforeCapture.height * 4,
  );
  glBeforeCapture.readPixels(
    0,
    0,
    canvasBeforeCapture.width,
    canvasBeforeCapture.height,
    glBeforeCapture.RGBA,
    glBeforeCapture.UNSIGNED_BYTE,
    preCapturePixels,
  );
  return preCapturePixels;
}

function recordRhiCapturePhase(phase: string): void {
  Object.assign(globalThis, { __forgeaxRhiCapturePhase: { phase, at: Date.now() } });
}

async function captureRhiDebugTape(app: App): Promise<RhiCaptureOutcome> {
  const preCapturePixels = readCanvasPixelsBeforeCapture();
  let rhiDebugCapture: unknown;
  recordRhiCapturePhase('app-start');
  const started = app.start();
  if (!started.ok) {
    rhiDebugCapture = { code: 'app-start-failed', detail: started.error.code };
  } else {
    await nextAnimationFrame();
    recordRhiCapturePhase('capture-frame');
    rhiDebugCapture = await captureAndUploadRhiFrame(app);
    app.stop();
    recordRhiCapturePhase('done');
  }
  Object.assign(globalThis, { __forgeaxRhiCaptureResult: rhiDebugCapture });
  return { rhiDebugCapture, preCapturePixels };
}

async function captureAndUploadRhiFrame(app: App): Promise<unknown> {
  const controller = new AbortController();
  const seedBytes = Number(searchParam('rhiSeedBytes') ?? '0');
  const snapshotTimeoutMs = Number(searchParam('rhiSnapshotTimeoutMs') ?? '10000');
  const timeout = setTimeout(() => controller.abort(), snapshotTimeoutMs + 20_000);
  const captured = await app.rhiCapture?.captureFrame({
    snapshotTimeoutMs,
    seed: { maxResourceBytes: seedBytes },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (captured === undefined) return { code: 'capture-unavailable' };
  if (!captured.ok) return { code: captured.error.code, detail: captured.error.detail };
  recordRhiCapturePhase('upload');
  const uploaded = await app.rhiCapture?.upload(captured.value, {
    runId: `webgl2-surface-${crypto.randomUUID().replaceAll('-', '')}`,
  });
  return uploaded?.ok
    ? {
        path: uploaded.value.path,
        digest: captured.value.digest,
        bytes: captured.value.byteLength,
      }
    : {
        code: uploaded?.error.code ?? 'upload-unavailable',
        detail: uploaded?.error.detail,
      };
}

function renderErrorsEvidence(renderErrors: unknown[]): SurfaceEvidence {
  return unavailableEvidence({
    code: 'surface-render-errors',
    stage: 'draw',
    detail: { errors: renderErrors },
  });
}

function webGpuSurfaceEvidence(
  renderErrors: unknown[],
  publicationRows: readonly PublicationRow[],
): SurfaceEvidence {
  if (renderErrors.length > 0) return renderErrorsEvidence(renderErrors);
  return {
    status: 'pass',
    backend: 'browser-webgpu',
    completedFrames: COMPLETED_FRAME_TARGET,
    cells: CELLS.map((cell) => {
      const publication = publicationRows.find(({ cell: candidate }) => candidate.id === cell.id);
      return {
        id: cell.id,
        materialGuid: cell.guid,
        sourceKey: publication?.row?.sourceKey ?? cell.sourceKey,
        publicationGeneration: publication?.publicationGeneration,
        publicationDigest: publication?.publicationDigest,
        sourceClosure: sourceClosureFor(cell),
      };
    }),
  };
}

async function webgl2SurfaceEvidence(
  assets: AppAssets,
  loaded: readonly LoadedCell[],
  publicationRows: readonly PublicationRow[],
  renderErrors: unknown[],
  rhiCapture: RhiCaptureOutcome,
  inspection: ReturnType<AppRenderer['inspect']>,
): Promise<SurfaceEvidence> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  const gl = canvas?.getContext('webgl2');
  if (
    gl === null ||
    gl === undefined ||
    canvas === null ||
    inspection.capabilities.backendKind !== 'wgpu-webgl2'
  ) {
    return unavailableEvidence({
      code: 'surface-webgl2-readback-unavailable',
      stage: 'readback',
      detail: inspection.capabilities.backendKind,
    });
  }
  const pixels = rhiCapture.preCapturePixels ?? new Uint8Array(canvas.width * canvas.height * 4);
  if (rhiCapture.preCapturePixels === undefined)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  if (searchParam('pixelExport') === '1') {
    // The wgpu-wasm GL surface presents readPixels row zero as the canvas
    // top row; exporting it with a second flip reverses authored textures.
    await exportPixels(
      'webgl2',
      pixels,
      canvas.width,
      canvas.height,
      canvas.width * 4,
      'rgba8unorm',
      'top-left',
    );
  }
  const cellReadbacks = CELLS.map((_, index) =>
    sampleWebgl2Cell(pixels, canvas.width, canvas.height, index),
  );
  if (renderErrors.length > 0) return renderErrorsEvidence(renderErrors);
  const missingSignal = cellReadbacks.findIndex((cell) => cell.signalPixels === 0);
  if (missingSignal >= 0) return emptyWebgl2ReadbackEvidence(missingSignal, cellReadbacks, canvas);
  const cells = CELLS.map((cell, index) => {
    const publication = publicationRows.find(({ cell: candidate }) => candidate.id === cell.id);
    const loadedEntry = loaded.find(({ cell: candidate }) => candidate.id === cell.id);
    const material = loadedEntry?.result.ok
      ? assets.read(loadedEntry.result.value).unwrap()
      : undefined;
    const program = material?.passes?.[0]?.program;
    const programIdentity = program?.module ?? 'unavailable';
    const pipelineIdentity = `${cell.pass}:${cell.rootPlan}:${programIdentity}`;
    const actualPasses = material?.passes?.map((entry) => entry.name) ?? [];
    const readback = cellReadbacks[index];
    const sample = readback?.sample ?? [0, 0, 0, 0];
    return {
      id: cell.id,
      record: {
        backend: 'chromium-webgl2',
        adapter: 'wgpu-webgl2',
        lane: 'direct',
        status: 'pass',
        pass: cell.pass,
        actualPasses,
        materialGuid: cell.guid,
        sourceKey: publication?.row?.sourceKey ?? cell.sourceKey,
        publicationGeneration: publication?.publicationGeneration,
        publicationDigest: publication?.publicationDigest,
        closure: 'forgeax_material::surface_v1',
        cookIdentity: publication?.publicationDigest,
        programIdentity,
        pipelineIdentity,
        sourceClosure: sourceClosureFor(cell),
        rootPlan: cell.rootPlan,
        samples: sample,
        signalPixels: readback?.signalPixels ?? 0,
        observed: `rgba8unorm readback ${sample.join(',')}`,
        verdict: 'pixel',
        confidence: 1,
        provenance: {
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
          frameId: inspection.frame.frameId,
          artifact: `${publication?.row?.packageUrl ?? 'catalog-unavailable'}#${cell.guid}`,
          sourceClosure: sourceClosureFor(cell),
          readbackKind: 'webgl2-readPixels',
          readbackFormat: 'rgba8unorm',
          readbackWidth: canvas.width,
          readbackHeight: canvas.height,
          readbackOrigin: 'bottom-left',
          readbackSample: { x: readback?.x ?? 0, y: readback?.y ?? 0 },
          clearColor: [0, 0, 0, 1],
          actualPasses,
          cookIdentity: publication?.publicationDigest,
          programIdentity,
          pipelineIdentity,
        },
      },
    };
  });
  return {
    status: 'pass',
    backend: 'chromium-webgl2',
    completedFrames: COMPLETED_FRAME_TARGET,
    cells,
    rhiDebugCapture: rhiCapture.rhiDebugCapture,
  };
}

function emptyWebgl2ReadbackEvidence(
  missingSignal: number,
  cellReadbacks: readonly CellReadback[],
  canvas: HTMLCanvasElement,
): SurfaceEvidence {
  return unavailableEvidence({
    code: 'surface-webgl2-readback-empty',
    stage: 'readback',
    detail: {
      expected: 'every Surface cell has non-clear RGB after the custom Renderer draw',
      observed: `cell ${CELLS[missingSignal]?.id ?? missingSignal} has no non-clear samples`,
      readbackKind: 'webgl2-readPixels',
      readbackFormat: 'rgba8unorm',
      readbackWidth: canvas.width,
      readbackHeight: canvas.height,
      signalPixels: cellReadbacks.map((cell) => cell.signalPixels),
    },
  });
}
