/// <reference types="vite/client" />
import { createCatalogHotSubscription, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { vec3 } from '@forgeax/engine-math';
import { physicsPlugin, type PhysicsWorld } from '@forgeax/engine-physics';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import { querySubmittedTerrainHeight, type FrameReceipt } from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { Terrain } from '@forgeax/engine-terrain';
import { materialTerrainGuid, terrainGuid } from './identity.ts';
import { buildTerrainWorld } from './scene.ts';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';
import { installTerrainWalker } from './walker.ts';
import { terrainReloadPolicy } from './reload-policy.ts';
import { startTerrainWorkerProbe } from './worker-probe.ts';
import { installTerrainHmrProbe } from './hmr-probe.ts';
function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const submitRejectionExpected = 'the terrain fixture deliberately rejects before queue acceptance';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('missing terrain canvas');
async function start() {
  const encoding = new URL(location.href).searchParams.get('material');
  const rootGuid =
    encoding === 'ids' || encoding === 'weights' ? materialTerrainGuid(encoding) : terrainGuid;
  const workerMode = new URL(location.href).searchParams.get('workers');
  if (workerMode === '1' || workerMode === 'engine') {
    await startTerrainWorkerProbe(canvas!, workerMode === 'engine', rootGuid);
    return;
  }
  const app = (
    await createApp(
      canvas!,
      {
        plugins: [physicsPlugin('rapier-3d')],
        rhiInstrumentation: {
          beforeSubmit() {
            if (!window.__terrainRejectNextSubmit) return;
            window.__terrainRejectNextSubmit = false;
            return new RhiError({
              code: 'webgpu-runtime-error',
              expected: submitRejectionExpected,
              hint: 'retry the next normal frame',
            });
          },
        },
        gpuPassTiming: {},
        ...(runtimeBinding !== undefined
          ? {
              assetRuntimeBinding: runtimeBinding,
              assetCatalog: createCatalogSource({
                url: runtimeBinding.catalogUrl,
                expectedScope: runtimeBinding,
                subscribe: createCatalogHotSubscription(import.meta.hot),
              }),
            }
          : {}),
      },
      forgeaxBundlerAdapter(),
    )
  ).unwrap();
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const subjects = await buildTerrainWorld(app, rootGuid);
  const errors: unknown[] = [];
  const rejections: unknown[] = [];
  app.onError((error) => {
    if (
      error.code === 'frame-submit-rejected' ||
      (error.code === 'device-operation-failed' &&
        error.detail.cause.code === 'webgpu-runtime-error' &&
        error.detail.cause.expected === submitRejectionExpected)
    ) {
      rejections.push({
        error,
        gate: window.__terrainGate?.(),
        walker: { ...(app.world.getResource('TerrainWalker') as object) },
        position: Array.from(app.world.get(subjects.walker, Transform).unwrap().pos),
      });
      return;
    }
    errors.push(error);
    console.error('terrain', JSON.stringify(error));
  });
  const lease = value(app.renderer.attach(app.world));
  let latest: FrameReceipt | undefined;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind === 'state-changed' && event.current !== 'alive') latest = undefined;
    if (event.kind === 'frame-submitted' && event.receipt.presentation === 'ready') {
      const receipt = event.receipt;
      void receipt.completed.then((result) => {
        if (result.ok && (latest === undefined || receipt.frameId > latest.frameId))
          latest = receipt;
      });
    }
  });
  if (app.assets === undefined) throw new Error('terrain requires assets');
  const policy = terrainReloadPolicy(
    app.world,
    app.assets,
    subjects.terrain,
    (request) => {
      if (latest === undefined)
        return Promise.resolve(
          err({
            code: 'terrain-query-unavailable',
            expected: 'a completed ready terrain frame',
            hint: 'wait for presentation',
            detail: { field: 'FrameReceipt' },
          }),
        );
      return querySubmittedTerrainHeight(latest, request);
    },
    rootGuid,
  );
  const disposeWalker = installTerrainWalker(app.world, subjects, policy.gate);
  window.__terrain = { app, subjects, errors, rejections, policy };
  window.__terrainGate = () => ({ ...policy.gate });
  const disposeProbe = installTerrainHmrProbe(app, subjects, policy);
  window.__disposeTerrain = async () => {
    disposeProbe();
    disposeWalker();
    policy.dispose();
    unsubscribe();
    await app.dispose();
  };
  window.__prepareTerrainCapture = async () => {
    app.pause().unwrap();
    let receipt;
    let completed = 0;
    const deadline = performance.now() + 60000;
    while (completed < 60 && performance.now() < deadline) {
      app.world.update(1 / 60).unwrap();
      receipt = value(
        app.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      value(await receipt.completed);
      if (receipt.presentation === 'ready') completed++;
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (completed !== 60)
      throw new Error('terrain did not complete 60 ready frames within 60 seconds');
    const query = await querySubmittedTerrainHeight(receipt!, {
      worldId: 0,
      entity: subjects.terrain,
      x: 62,
      z: 62,
    });
    const hit = app.world
      .getResource<PhysicsWorld>('PhysicsWorld')
      .raycast(vec3.create(62, 50, 62), vec3.create(0, -1, 0), 100);
    if (!query.ok || hit === undefined)
      throw new Error('terrain render and collision queries must be available');
    if (errors.length > 0 || rejections.length > 0)
      throw new Error('terrain runtime errors fail capture preparation');
    window.__transmissionFrameCount = 60;
    const root = app.world.get(subjects.terrain, Terrain).unwrap().asset;
    const source = app.assets!.read(root).unwrap();
    if (app.assets!.source(root).unwrap()?.guid !== AssetGuid.format(rootGuid))
      throw new Error('capture must retain the selected source root');
    const sha = async (bytes: Uint8Array) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const authorHeightSha256 = await sha(
      new Uint8Array(source.heights.buffer, source.heights.byteOffset, source.heights.byteLength),
    );
    const authorWeightSha256 = await sha(
      new Uint8Array(source.weights.buffer, source.weights.byteOffset, source.weights.byteLength),
    );
    const descriptor = {
      columns: source.columns,
      rows: source.rows,
      spacing: source.spacing,
      subsectionVertices: source.subsectionVertices,
      layers: source.layers,
      authorHeightSha256,
      authorWeightSha256,
    };
    window.__terrainReport = {
      source: {
        rootGuid: AssetGuid.format(rootGuid),
        encoding: source.materialEncoding,
        descriptor,
        sourceSha256: await sha(new TextEncoder().encode(JSON.stringify(descriptor))),
      },
      completedFrames: 60,
      query,
      collisionHeight: hit.point[1],
      errors: [...errors],
      inspection: app.renderer.inspect(),
    };
    app.resume().unwrap();
  };
  window.__readTerrainCapture = async () => {
    app.stop().unwrap();
    return value(await captureCanvasPixels(canvas!));
  };
  window.__captureTerrain = async () => {
    app.stop().unwrap();
    app.world.update(1 / 60).unwrap();
    const receipt = value(
      app.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    window.__terrainReceipt = receipt;
    window.__terrainQuery = await querySubmittedTerrainHeight(receipt, {
      worldId: 0,
      entity: subjects.terrain,
      x: 62,
      z: 62,
    });
    return value(await captureCanvasPixels(canvas!));
  };
  window.__replayTerrainCapture = replayCapturedFrameInBrowser;
  app.start().unwrap();
}
start().catch((error) => console.error('terrain bootstrap', error));
declare global {
  interface Window {
    __terrain?: unknown;
    __terrainRejectNextSubmit?: boolean;
    __terrainGate?: () => unknown;
    __disposeTerrain?: () => Promise<void>;
    __terrainReport?: unknown;
    __transmissionFrameCount?: number;
    __prepareTerrainCapture?: () => Promise<void>;
    __readTerrainCapture?: () => Promise<Uint8Array>;
    __terrainReceipt?: unknown;
    __terrainQuery?: unknown;
    __captureTerrain?: () => Promise<Uint8Array>;
    __replayTerrainCapture?: typeof replayCapturedFrameInBrowser;
  }
}
