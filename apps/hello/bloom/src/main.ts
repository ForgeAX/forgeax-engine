import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
// apps/hello/bloom -- Bloom real-time comparison demo
// (feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w18).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource (feat-20260518-app-shell-game-loop).
//   - BUILTIN_SPHERE + BUILTIN_CUBE -- builtin mesh handles with
//     default-standard-pbr material and emissiveIntensity > 1.0 to
//     drive HDR-bright pixels above the bloom threshold.
//   - Space toggle runtime: reads InputSnapshot.keyboard.down(' '),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.bloom between BLOOM_DISABLED and BLOOM_ENABLED via
//     world.set(camEntity, Camera, { bloom }). The engine extract
//     stage re-reads bloom every frame; the shared Standard post chain
//     retires the disabled roster before re-admitting it.
//   - DOM HUD overlay (charter F2 text over image): #bloom-hud span
//     updates textContent to "Bloom: ON" / "Bloom: OFF" on every toggle.
//   - Tonemap: this scene explicitly selects TONEMAP_REINHARD_EXTENDED.
//     Bloom also admits linear HDR work when tone mapping is disabled.
//
// Scene: emissive sphere + cube under a slant directional light. The
// sphere has emissiveIntensity=2.0 to produce pixels >1.0 in HDR that
// Bloom extracts it. The cube has emissiveIntensity=0.5
// to stay below this scene's explicit 1.0 threshold.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) define the 5 standard components via defineComponent (globally live)
//   (3) assets.create(standard PBR) -> materialHandle for non-emissive
//   (4) assets.create(standard PBR emissive) -> emissiveHandle for emissive
//   (5) world.spawn emissive sphere + cube, DirectionalLight, Camera (save entity)
//   (6) world.addSystem press-edge toggle + HUD sync
//   (7) app.start()

import { createApp } from '@forgeax/engine/app/browser';
import type { CanvasAppError } from '@forgeax/engine/app';


import { Transform } from '@forgeax/engine/scene';

import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
import { EngineEnvironmentError } from '@forgeax/engine/runtime';
import { waitForReadyFrames } from './wait-for-ready-frames';

import type { MaterialAsset } from '@forgeax/engine/types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
const BUILTIN_SPHERE = createPrimitiveMesh('sphere').unwrap();


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[bloom] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[bloom] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[bloom] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('Demo requires the host AssetRegistry');
  const cubeMesh = assets.create(BUILTIN_CUBE).unwrap();
  const sphereMesh = assets.create(BUILTIN_SPHERE).unwrap();
  console.warn(`[bloom] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const world = app.world;
  const carrierErrors: Array<{ code: string; hint: string; detail: unknown }> = [];
  const submittedFrames: Array<{ frameId: number; deviceGeneration: number }> = [];
  const rendererTransitions: Array<{ previous: string; current: string }> = [];
  let carrierStage = 'on';
  app.onError((error) => {
    carrierErrors.push({
      code: error.code,
      hint: error.hint,
      detail: 'detail' in error ? error.detail : undefined,
    });
  });
  app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') {
      submittedFrames.push({ frameId: event.frameId, deviceGeneration: event.deviceGeneration });
    }
    if (event.kind === 'state-changed') {
      rendererTransitions.push({ previous: event.previous, current: event.current });
    }
  });

  // Step 2: create standard PBR material in this World's asset owner.
  const materialHandle = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  } as MaterialAsset).unwrap();

  // Step 3: alloc emissive PBR material (emissiveIntensity > 1.0).
  // The default-standard-pbr emissive factor produces >1.0 HDR values
  // that Bloom extracts (threshold 1.0).
  const emissiveHandle = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [1.0, 0.85, 0.55],
      metallic: 0.0,
      roughness: 0.3,
      emissive: [1.0, 0.7, 0.3],
      emissiveIntensity: 2.0,
    },
  } as MaterialAsset).unwrap();

  // Step 4: spawn emissive sphere (left) and non-emissive cube (right).
  // The sphere produces HDR-bright pixels for bloom; the cube stays
  // below threshold as a visual reference.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-0.6, 0.2, 0], quat: [0, 0, 0, 1], scale: [0.6, 0.6, 0.6],},
    },
    { component: MeshFilter, data: { assetHandle: sphereMesh } },
    { component: MeshRenderer, data: { materials: [emissiveHandle] } },
  ).unwrap();

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0.6, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4],},
    },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // Step 6: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  }).unwrap();

  // Step 7: spawn camera with tonemap=Reinhard-Extended (HDR path
  // required for bloom) and bloom=DISABLED (zero-overhead default).
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 5]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        bloom: BLOOM_DISABLED,
        bloomThreshold: 1.0,
        bloomIntensity: 1.0,
        bloomSmoothWidth: 0.01,
        bloomRadius: 0,
      },
    },
  ).unwrap();

  // Step 8: Space-key press-edge toggle system.
  // InputSnapshot.keyboard matches KeyboardEvent.key (browser backend
  // stores ev.key), so the spacebar is the literal ' ' -- NOT 'Space'
  // (that is ev.code). See packages/input/src/input-snapshot.ts down() doc.
  let prevSpace = false;
  let currentBloom: number = BLOOM_DISABLED;
  let currentBloomIntensity = 1.0;

  const hudEl = document.getElementById('bloom-hud');
  const updateBloomHud = (): void => {
    if (hudEl) hudEl.textContent = currentBloom === BLOOM_ENABLED && currentBloomIntensity > 0 ? 'Bloom: ON' : 'Bloom: OFF';
  };
  const applyBloom = (enabled: boolean): boolean => {
    const bloom = enabled ? BLOOM_ENABLED : BLOOM_DISABLED;
    const result = world.set(camEntity, Camera, { bloom });
    if (!result.ok) {
      console.error('[bloom] bloom update failed:', result.error.code);
      return false;
    }
    currentBloom = bloom;
    updateBloomHud();
    return true;
  };

  world.addSystem(Update, {
    name: 'bloom-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;

      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        applyBloom(currentBloom !== BLOOM_ENABLED);
      }
      prevSpace = cur;
    },
  });

  const inspectCarrier = () => {
    const inspection = app.renderer.inspect();
    return {
      stage: carrierStage,
      frame: inspection.frame,
      state: inspection.state,
      passes: [...inspection.perFramePassNames],
      bloom: inspection.bloom,
      hud: hudEl?.textContent ?? '',
      submittedFrames: submittedFrames.length,
      rendererTransitions: [...rendererTransitions],
      errors: [...carrierErrors],
    };
  };
  (globalThis as unknown as {
    __bloomCarrierProbe?: {
      ready: () => boolean;
      setStage: (stage: string) => void;
      setBloom: (enabled: boolean) => boolean;
      setBloomIntensity: (intensity: number) => boolean;
      setBloomRadius: (radius: number) => boolean;
      resize: (width: number, height: number) => void;
      reconfigureSurface: () => { release: unknown; restore: unknown };
      recoverDeviceLoss: () => Promise<unknown>;
      waitForReadyFrames: (count: number) => Promise<number>;
      inspect: () => ReturnType<typeof inspectCarrier>;
    };
  }).__bloomCarrierProbe = {
    ready: () => app.renderer.state() === 'alive',
    setStage: (stage) => {
      carrierStage = stage;
    },
    setBloom: (enabled) => {
      return applyBloom(enabled);
    },
    setBloomIntensity: (intensity) => {
      const result = world.set(camEntity, Camera, { bloomIntensity: intensity });
      if (!result.ok) {
        console.error('[bloom] bloom intensity update failed:', result.error.code);
        return false;
      }
      currentBloomIntensity = intensity;
      updateBloomHud();
      return true;
    },
    setBloomRadius: (radius) => {
      const result = world.set(camEntity, Camera, { bloomRadius: radius });
      if (!result.ok) {
        console.error('[bloom] bloom radius update failed:', result.error.code);
        return false;
      }
      return true;
    },
    resize: (width, height) => {
      target.style.width = `${width}px`;
      target.style.height = `${height}px`;
      target.width = width;
      target.height = height;
      window.dispatchEvent(new Event('resize'));
    },
    reconfigureSurface: () => {
      const release = app.renderer.releaseSurface();
      const restore = app.renderer.restoreSurface();
      return { release, restore };
    },
    recoverDeviceLoss: () => app.renderer.recover(),
    waitForReadyFrames: (count) => waitForReadyFrames(app.renderer, count),
    inspect: inspectCarrier,
  };

  // Step 9: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[bloom] running. Press Space to toggle Bloom.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[bloom] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[bloom] ${err.code}: ${err.hint}`);
}
