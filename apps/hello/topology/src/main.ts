// hello-topology -- the focused public Points/Lines carrier.
//
// The query-free URL remains the legacy line-list topology oracle. The two
// focused URLs use the same public MeshAsset and Materials.unlit authoring
// with Points and Lines attached; evidenceLane selects only the carrier URL.

import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';
import {
  createMeshBuilder,
  createBoxGeometry,
  createEdgesGeometry,
  createWireframeGeometry,
} from '@forgeax/engine-geometry';
import {
  Camera,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointShapeValue,
  Points,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const FOCUSED_ROUTES = ['?evidenceLane=webgpu', '?evidenceLane=wgpu-webgl2'] as const;

function createFocusedMesh(topology: 'point-list' | 'line-list'): MeshAsset {
  const positions = topology === 'point-list'
    ? [[-0.65, 0.25, 0], [-0.2, 0.55, 0], [0.25, 0.2, 0], [0.65, 0.5, 0]]
    : [[-0.8, -0.45, 0], [0.8, -0.45, 0], [-0.8, -0.1, 0], [0.8, -0.1, 0], [-0.8, 0.25, 0], [0.8, 0.25, 0]];
  return createMeshBuilder({
    attributes: { position: new Float32Array(positions.flat()) },
    submeshes: [{ topology }],
    materialSlots: [{ slotName: 'focused-points-lines' }],
  }).build().unwrap();
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('[topology] missing <canvas id="app"> in index.html');

const query = new URLSearchParams(window.location.search);
const evidenceLane = query.get('evidenceLane');
const falsify = query.get('falsify');
const authoringSandbox = query.get('authoringSandbox') === '1';
void (evidenceLane === 'webgpu' || evidenceLane === 'wgpu-webgl2'
  ? bootstrapFocused(canvas, evidenceLane, falsify, authoringSandbox)
  : bootstrapLegacy(canvas));

async function bootstrapFocused(
  target: HTMLCanvasElement,
  lane: 'webgpu' | 'wgpu-webgl2',
  falsify: string | null,
  authoringSandbox: boolean,
): Promise<void> {
  const appOptions = lane === 'wgpu-webgl2' ? await loadWebGl2Options() : {};
  const appResult = await createApp(target, appOptions, forgeaxBundlerAdapter());
  if (!appResult.ok) return reportAppError(appResult.error);
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('topology requires runtime assets');
  const world = app.world;
  const material = Materials.unlit([0.1, 0.9, 1, falsify === 'alpha' ? 0.4 : 1], {
    renderState: {
      ...(falsify === 'depth-sort' || falsify === 'alpha'
        ? { depthWriteEnabled: false }
        : {}),
      ...(falsify === 'alpha'
        ? {
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          }
        : {}),
    },
    queue: falsify === 'sort' ? 3001 : 3000,
  });
  const materialHandle = assets.create(material).unwrap();
  const pointMeshHandle = assets.create(createFocusedMesh('point-list')).unwrap();
  const lineMeshHandle = assets.create(createFocusedMesh('line-list')).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [falsify === 'frustum' ? 0.85 : 0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    {
      component: Points,
      data: {
        sizePx: 16,
        shape: falsify === 'point-square' ? PointShapeValue.square : PointShapeValue.circle,
      },
    },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: lineMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    { component: Lines, data: { width: falsify === 'line-width' ? 1 : 4 } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2], quat: [0, 0, 0, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  ).unwrap();

  const start = app.start();
  if (!start.ok) return reportAppError(start.error);
  let frameCount = 0;
  const rendererErrors: unknown[] = [];
  app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') frameCount = event.frameId;
    if (event.kind === 'error' && rendererErrors.length < 10) {
      rendererErrors.push({
        code: event.error.code,
        expected: event.error.expected,
        hint: event.error.hint,
        ...('detail' in event.error ? { detail: event.error.detail } : {}),
      });
    }
  });
  const backend = app.renderer.inspect().capabilities.backendKind;
  const hud = document.querySelector<HTMLDivElement>('#topology-hud');
  if (hud !== null) hud.textContent = `evidenceLane=${lane} backend=${backend} points-lines`;
  const host = window as typeof window & {
    __pointsLinesEvidence?: {
      readonly evidenceLane: typeof lane;
      readonly routes: readonly string[];
      readonly backend: typeof backend;
      readonly backendKind: typeof backend;
      readonly authoringSandbox: boolean;
      readonly validationErrors: number;
      readonly frameCount: number;
      readonly rendererErrors: readonly unknown[];
      readonly falsify: string | null;
      readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
      readonly authoring: {
        readonly pointSizePx: number;
        readonly pointShape: string;
        readonly lineWidthPx: number;
        readonly depthWriteEnabled: boolean;
        readonly alpha: number;
        readonly sortQueue: number;
        readonly frustumMarginPx: number;
      };
      readonly inspect: () => unknown;
      readonly capture: () => string;
      readonly captureRhi: () => Promise<unknown>;
    };
  };
  host.__pointsLinesEvidence = {
    evidenceLane: lane,
    routes: FOCUSED_ROUTES,
    backend,
    backendKind: backend,
    authoringSandbox,
    get validationErrors() { return rendererErrors.length; },
    get frameCount() { return frameCount; },
    get rendererErrors() { return rendererErrors; },
    falsify,
    get viewport() {
      return { width: target.width, height: target.height, dpr: globalThis.devicePixelRatio || 1 };
    },
    authoring: {
      pointSizePx: 16,
      pointShape: falsify === 'point-square' ? 'square' : 'circle',
      lineWidthPx: falsify === 'line-width' ? 1 : 4,
      depthWriteEnabled: falsify !== 'depth-sort',
      alpha: falsify === 'alpha' ? 0.4 : 1,
      sortQueue: falsify === 'sort' ? 3001 : 3000,
      frustumMarginPx: falsify === 'frustum' ? 8 : 0,
    },
    inspect: () => app.renderer.inspect().renderScene.pointsLines,
    capture: () => target.toDataURL('image/png'),
    captureRhi: async () => {
      const capture = await app.rhiCapture?.captureFrame({ seed: { maxResourceBytes: 8 * 1024 * 1024 } });
      if (capture === undefined) return { code: 'capture-unavailable' };
      if (!capture.ok) return { code: capture.error.code, detail: capture.error.detail };
      const uploaded = await app.rhiCapture?.upload(capture.value, {
        runId: `topology-webgl2-${Date.now()}`,
      });
      return {
        digest: capture.value.digest,
        byteLength: capture.value.byteLength,
        upload: uploaded,
      };
    },
  };
  console.warn(`[topology] evidenceLane=${lane} backend=${backend}`);
}

async function loadWebGl2Options(): Promise<{
  readonly rhi: import('@forgeax/engine-rhi').RhiInstance;
}> {
  const backend = await import('@forgeax/engine-rhi-wgpu');
  await backend.ensureReady();
  return { rhi: backend.rhi };
}

async function bootstrapLegacy(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return reportAppError(appResult.error);
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[topology] AssetRegistry is null (renderer construction failed)');
    return;
  }
  const sourceResult = createBoxGeometry(1.4, 1.4, 1.4);
  if (!sourceResult.ok) return reportGeometryError(sourceResult.error);
  const wireframeResult = createWireframeGeometry(sourceResult.value);
  if (!wireframeResult.ok) return reportGeometryError(wireframeResult.error);
  const edgesResult = createEdgesGeometry(sourceResult.value, 1);
  if (!edgesResult.ok) return reportGeometryError(edgesResult.error);

  const world = app.world;
  const wireframeHandle = assets.create(wireframeResult.value).unwrap();
  const edgesHandle = assets.create(edgesResult.value).unwrap();
  const wireMaterialHandle = assets.create(Materials.unlit([0.1, 0.9, 1, 1])).unwrap();
  const edgesMaterialHandle = assets.create(Materials.unlit([1, 0.65, 0.12, 1])).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [-1.1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: wireframeHandle } },
    { component: MeshRenderer, data: { materials: [wireMaterialHandle] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [1.1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: edgesHandle } },
    { component: MeshRenderer, data: { materials: [edgesMaterialHandle] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0.35, 5.4], quat: [0, 0, 0, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  ).unwrap();
  const start = app.start();
  if (!start.ok) return reportAppError(start.error);
  const backend = app.renderer.inspect().capabilities.backendKind;
  const hud = document.querySelector<HTMLDivElement>('#topology-hud');
  if (hud !== null) {
    hud.textContent = [
      'factory=createWireframeGeometry + createEdgesGeometry',
      `wireframe edgeCount=${edgeCount(wireframeResult.value)} topology=line-list indexed=false`,
      `edges edgeCount=${edgeCount(edgesResult.value)} topology=line-list indexed=false threshold=1deg`,
      `backend=${backend} provenance=renderer.inspect().capabilities.backendKind`,
      'failure recovery=branch AssetError.code/detail, retry Geometry owner input',
    ].join('\n');
  }
  console.warn(`[topology] legacy backend=${backend}`);
}

function edgeCount(mesh: MeshAsset): number {
  return (mesh.submeshes[0]?.vertexCount ?? 0) / 2;
}

function reportGeometryError(error: AssetError): void {
  if (error.code === 'asset-parse-failed') {
    const detail = error.detail;
    if (detail !== undefined && 'field' in detail && 'value' in detail && 'reason' in detail) {
      console.error(
        `[topology] geometry recovery: ${error.code} field=${detail.field} ` +
          `value=${String(detail.value)} reason=${detail.reason}`,
      );
      return;
    }
  }
  console.error(`[topology] geometry recovery: ${error.code} hint=${error.hint}`);
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[topology] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[topology] ${err.code}: ${err.hint}`);
}
