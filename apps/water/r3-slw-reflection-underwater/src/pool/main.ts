import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, FixedTime, FixedUpdate, Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  ANTIALIAS_NONE,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  perspective,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { PoolControls } from './controls';
import { createPoolFeature } from './feature';
import { POOL_PACKAGE } from './identity';
import { PoolRipples } from './ripples';
import './style.css';

const node = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing pool element ${selector}`);
  return element;
};

async function main() {
  const canvas = node<HTMLCanvasElement>('#pool');
  const panel = node('#panel');
  const optics = createPoolFeature();
  const app = (
    await createApp(
      canvas,
      {
        features: [optics.feature],
        canvasPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
        time: { fixedDeltaSeconds: 1 / 120, maxStepsPerUpdate: 8, maxDeltaSeconds: 0.1 },
        pointerLockAllowed: () => false,
        uiRoot: panel,
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const assets = app.assets;
  if (assets === undefined) throw new Error('Pool asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(POOL_PACKAGE, key));
  const field = (await assets.load(guid('material/field'), 'material')).unwrap();
  const scene = (await assets.load(guid('material/scene'), 'material')).unwrap();
  const height = (await assets.load(guid('texture/height'), 'texture')).unwrap();
  optics.configure({ assets, field, scene });
  const camera = app.world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 1, near: 0.01, far: 100 }),
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          clearColor: [0.01, 0.02, 0.03, 1],
        },
      },
    )
    .unwrap();
  const ripples = new PoolRipples();
  const controls = new PoolControls(ripples);
  controls.reset();
  const errors: string[] = [];
  let completedFrames = 0;
  let lastReceipt = 0;
  let startedAt = 0;
  let completionRate = 0;
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (errors.length < 32) errors.push(message);
    node('#status').textContent = `渲染错误：${message}`;
    console.error(error);
  };
  app.onError(report);
  let panelState = '';
  const syncPanel = () => {
    const state = `${controls.caustics}:${controls.gravity}:${controls.paused}`;
    if (state === panelState) return;
    panelState = state;
    node<HTMLInputElement>('#caustics').checked = controls.caustics;
    node<HTMLInputElement>('#gravity').checked = controls.gravity;
    node('#pause').innerHTML = `${controls.paused ? '继续波动' : '暂停波动'} <kbd>SPACE</kbd>`;
  };
  const abort = new AbortController();
  const listen = (selector: string, event: string, action: () => void) =>
    node(selector).addEventListener(event, action, { signal: abort.signal });
  listen('#pause', 'click', () => {
    controls.paused = !controls.paused;
    syncPanel();
  });
  listen('#reset', 'click', () => controls.reset());
  listen('#reference-view', 'click', () => controls.setView('reference'));
  listen('#underwater-view', 'click', () => controls.setView('underwater'));
  listen('#caustics', 'change', () => {
    controls.caustics = node<HTMLInputElement>('#caustics').checked;
  });
  listen('#gravity', 'change', () => {
    controls.gravity = node<HTMLInputElement>('#gravity').checked;
  });
  listen('#field', 'change', () => {
    controls.fieldView = node<HTMLInputElement>('#field').checked;
  });
  listen('#gain', 'input', () => {
    controls.gain = Number(node<HTMLInputElement>('#gain').value);
    node<HTMLOutputElement>('#gain-value').value = controls.gain.toFixed(2);
  });
  // Context menu suppression is Host UI policy; gameplay consumes frozen Engine input.
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), {
    signal: abort.signal,
  });
  const simulation = defineSystem({
    name: 'pool-ripple-simulation',
    queries: [],
    fn(world) {
      controls.step(world.getResource(FixedTime).delta);
      if (!controls.paused) ripples.step();
    },
  });
  const interaction = defineSystem({
    name: 'pool-input-and-surface-publication',
    queries: [],
    fn(world) {
      controls.update(world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY), canvas.width, canvas.height);
      assets
        .writeRange(height, {
          origin: { x: 0, y: 0 },
          size: { width: ripples.size, height: ripples.size },
          data: ripples.bytes,
        })
        .unwrap();
      const basis = controls.basis();
      world
        .set(camera, Transform, {
          pos: basis.eye,
          quat: quat.fromLookAt(quat.create(), basis.eye, [0, -0.5, 0], [0, 1, 0]),
        })
        .unwrap();
      const shared = {
        lightDirection: controls.light,
        ball: [...controls.sphere, controls.radius],
      };
      assets.update(field, { values: shared }).unwrap();
      assets
        .update(scene, {
          values: {
            ...shared,
            viewport: [canvas.width, canvas.height, 0.41421356, 1],
            appearance: [controls.caustics ? 1 : 0, controls.gain, 1, controls.fieldView ? 1 : 0],
          },
        })
        .unwrap();
      syncPanel();
    },
  });
  app.world.addSystem(FixedUpdate, simulation).unwrap();
  app.world.addSystem(Update, interaction).unwrap();
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind === 'error') report(event.error);
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed
      .then((result) => {
        if (!result.ok) {
          report(result.error);
          return;
        }
        if (event.receipt.presentation !== 'ready' || optics.readState().submissions === 0) return;
        completedFrames++;
        lastReceipt = event.receipt.frameId;
        if (completedFrames % 30 === 0) {
          const now = performance.now();
          if (startedAt > 0) completionRate = 30000 / (now - startedAt);
          startedAt = now;
          if (errors.length === 0)
            node('#status').textContent =
              `WEBGPU · ${completionRate.toFixed(0)} 完成帧/秒 · ${controls.paused ? '波动已暂停' : '实时折射焦散'}`;
        }
      })
      .catch(report);
  });
  const api = {
    capture: () => app.rhiCapture?.captureFrame(),
    readState: () => ({
      completedFrames,
      lastReceipt,
      errors: [...errors],
      ...optics.readState(),
      paused: controls.paused,
      caustics: controls.caustics,
      sphere: [...controls.sphere],
      gravity: controls.gravity,
      waveRevision: ripples.revision,
      maximumHeight: ripples.height.reduce((m, h) => Math.max(m, Math.abs(h)), 0),
      camera: controls.basis(),
      renderer: app.renderer.inspect(),
    }),
    disturb: (x: number, z: number, radius = 0.06, strength = 0.01) =>
      ripples.disturb(x, z, radius, strength),
    setPaused: (paused: boolean) => {
      controls.paused = paused;
      syncPanel();
    },
    reset: () => controls.reset(),
    setView: (view: 'reference' | 'underwater') => {
      controls.setView(view);
    },
    async dispose() {
      abort.abort();
      unsubscribe();
      await app.dispose();
    },
  };
  Object.assign(window, { __poolDemo: api });
  window.addEventListener(
    'pagehide',
    () => {
      void api.dispose();
    },
    { once: true },
  );
  app.start().unwrap();
}

void main().catch((error: unknown) => {
  node('#status').textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
