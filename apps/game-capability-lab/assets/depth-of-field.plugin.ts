import type { GameHost, GameProjectionValue } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { quat } from '@forgeax/engine-math';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Skylight,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';
import {
  installDepthOfField,
  type DepthOfFieldControls,
  type DepthOfFieldHandle,
  type DepthOfFieldPreset,
} from './plugins/depth-of-field';

type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

type Layer = {
  readonly id: 'near' | 'focus' | 'far';
  readonly title: string;
  readonly distance: number;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly panel: readonly [number, number, number, number];
  readonly stripe: readonly [number, number, number, number];
  readonly stripeAlt: readonly [number, number, number, number];
};

const LAYERS: readonly Layer[] = [
  {
    id: 'near',
    title: 'NEAR 4.5m',
    distance: 4.5,
    x: -1.0,
    z: 7.5,
    width: 1.8,
    height: 1.7,
    panel: [0.025, 0.05, 0.11, 1],
    stripe: [1, 0.13, 0.08, 1],
    stripeAlt: [1, 0.82, 0.16, 1],
  },
  {
    id: 'focus',
    title: 'FOCUS 9m',
    distance: 9,
    x: 0,
    z: 3,
    width: 2.8,
    height: 2.5,
    panel: [0.02, 0.07, 0.11, 1],
    stripe: [0.08, 0.82, 1, 1],
    stripeAlt: [0.72, 0.98, 1, 1],
  },
  {
    id: 'far',
    title: 'FAR 17m',
    distance: 17,
    x: 1.9,
    z: -5,
    width: 4.8,
    height: 4.2,
    panel: [0.035, 0.035, 0.08, 1],
    stripe: [0.72, 0.16, 1, 1],
    stripeAlt: [1, 0.34, 0.78, 1],
  },
];

const DEFAULT_CONTROLS: DepthOfFieldControls = Object.freeze({
  focusDistance: 9,
  fStop: 0.7,
  sensorHeight: 0.06,
  maxRadiusPixels: 16,
  quality: 'high',
  blurSide: 'both',
});

const PRESETS: Readonly<Record<DepthOfFieldPreset, Pick<DepthOfFieldControls, 'focusDistance' | 'blurSide'>>> = {
  off: { focusDistance: 9, blurSide: 'both' },
  near: { focusDistance: 9, blurSide: 'near' },
  far: { focusDistance: 9, blurSide: 'far' },
  both: { focusDistance: 9, blurSide: 'both' },
};

function asProjection<T>(value: T): GameProjectionValue {
  return value as unknown as GameProjectionValue;
}

function material(world: World, color: readonly [number, number, number, number]): MaterialHandle {
  return world.allocSharedRef('MaterialAsset', Materials.unlit(color) as MaterialAsset);
}

function spawnCube(world: World, mesh: MaterialHandle, pos: readonly [number, number, number], scale: readonly [number, number, number]): void {
  world.spawn(
    { component: Transform, data: { pos, scale } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [mesh] } },
  ).unwrap();
}

function spawnSphere(world: World, mesh: MaterialHandle, pos: readonly [number, number, number], radius: number): void {
  world.spawn(
    { component: Transform, data: { pos, scale: [radius, radius, radius] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [mesh] } },
  ).unwrap();
}

type DemoScene = { readonly camera: EntityHandle; readonly dof: DepthOfFieldHandle };

function buildScene(world: World, host: GameHost): DemoScene {
  const background = material(world, [0.008, 0.012, 0.025, 1]);
  const floor = material(world, [0.03, 0.045, 0.075, 1]);
  const nearPanel = material(world, LAYERS[0]!.panel);
  const focusPanel = material(world, LAYERS[1]!.panel);
  const farPanel = material(world, LAYERS[2]!.panel);
  const nearStripe = material(world, LAYERS[0]!.stripe);
  const nearStripeAlt = material(world, LAYERS[0]!.stripeAlt);
  const focusStripe = material(world, LAYERS[1]!.stripe);
  const focusStripeAlt = material(world, LAYERS[1]!.stripeAlt);
  const farStripe = material(world, LAYERS[2]!.stripe);
  const farStripeAlt = material(world, LAYERS[2]!.stripeAlt);
  const white = material(world, [0.95, 0.98, 1, 1]);

  spawnCube(world, background, [0, 1.5, -8], [9, 5.5, 0.15]);
  spawnCube(world, floor, [0, -1.45, 0], [9, 0.12, 12]);

  const layerMaterials = [
    { panel: nearPanel, stripe: nearStripe, stripeAlt: nearStripeAlt },
    { panel: focusPanel, stripe: focusStripe, stripeAlt: focusStripeAlt },
    { panel: farPanel, stripe: farStripe, stripeAlt: farStripeAlt },
  ] as const;
  for (const [index, layer] of LAYERS.entries()) {
    const palette = layerMaterials[index]!;
    spawnCube(world, palette.panel, [layer.x, 0.15, layer.z], [layer.width, layer.height, 0.12]);
    const barWidth = Math.max(0.08, layer.width * 0.065);
    const barHeight = layer.height * 0.82;
    const spacing = layer.width * 0.17;
    for (let bar = -2; bar <= 2; bar += 1) {
      spawnCube(
        world,
        bar % 2 === 0 ? palette.stripe : palette.stripeAlt,
        [layer.x + bar * spacing, 0.18, layer.z + 0.15],
        [barWidth, barHeight, 0.08],
      );
    }
    spawnCube(world, palette.stripeAlt, [layer.x, 0.18, layer.z + 0.17], [layer.width * 0.82, 0.07, 0.1]);
    spawnSphere(world, white, [layer.x, layer.height + 0.55, layer.z + 0.18], Math.max(0.12, layer.width * 0.08));
  }

  // A foreground wire creates a controlled silhouette/occlusion edge across
  // the middle and far cards without adding animation or VFX noise.
  spawnCube(world, white, [0.35, 0.1, 7.1], [0.07, 2.1, 0.07]);
  world.spawn({ component: DirectionalLight, data: { direction: [-0.35, -0.8, -0.45], color: [1, 0.95, 0.9], intensity: 1.2 } }).unwrap();
  world.spawn({ component: Skylight, data: { color: [0.12, 0.18, 0.3], intensity: 0.35 } }).unwrap();

  const canvas = host.canvas;
  if (canvas === undefined) throw new Error('Depth-of-field scene requires a presentation canvas');
  const width = ('clientWidth' in canvas ? canvas.clientWidth : canvas.width) || canvas.width || 1280;
  const height = ('clientHeight' in canvas ? canvas.clientHeight : canvas.height) || canvas.height || 720;
  const aspect = width / Math.max(height, 1);
  const eye: [number, number, number] = [0, 0.9, 12];
  const camera = world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.2, 0], [0, 1, 0]) } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: (36 * Math.PI) / 180, aspect, near: 0.1, far: 40 }),
        tonemap: TONEMAP_NONE,
        bloom: BLOOM_DISABLED,
        antialias: ANTIALIAS_NONE,
        clearColor: [0.008, 0.012, 0.025, 1],
      },
    },
  ).unwrap();
  const dof = installDepthOfField(world, camera, false);
  dof.setControls(DEFAULT_CONTROLS);
  dof.setPreset('off');
  return { camera, dof };
}

function mountPanel(host: GameHost, dof: DepthOfFieldHandle): { readonly dispose: () => void; readonly update: () => void } {
  const root = host.uiRoot ?? document.body;
  const style = document.createElement('style');
  style.textContent = `
    .forgeax-dof-panel { position: fixed; z-index: 20; top: 18px; left: 18px; width: 286px; padding: 16px; color: #e9f3ff; background: rgb(7 13 26 / 88%); border: 1px solid rgb(143 211 255 / 42%); border-radius: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 35%); font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; backdrop-filter: blur(8px); }
    .forgeax-dof-panel h1 { margin: 0 0 5px; font: 700 17px/1.2 system-ui, sans-serif; letter-spacing: .02em; }
    .forgeax-dof-panel p { margin: 0 0 12px; color: #a9bdd6; }
    .forgeax-dof-buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
    .forgeax-dof-buttons button { padding: 7px 3px; color: #d9edff; background: #13253e; border: 1px solid #2d557e; border-radius: 6px; cursor: pointer; font: inherit; }
    .forgeax-dof-buttons button:hover, .forgeax-dof-buttons button[data-active='true'] { color: #06111f; background: #8fd3ff; }
    .forgeax-dof-row { display: grid; grid-template-columns: 112px 1fr 48px; gap: 8px; align-items: center; margin: 8px 0; }
    .forgeax-dof-row input { width: 100%; accent-color: #8fd3ff; }
    .forgeax-dof-value { color: #fff; text-align: right; }
    .forgeax-dof-status { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgb(143 211 255 / 22%); color: #9ec7ea; white-space: pre-line; }
    .forgeax-dof-legend { position: fixed; z-index: 10; right: 18px; bottom: 18px; padding: 10px 12px; color: #d7e8fa; background: rgb(7 13 26 / 76%); border: 1px solid rgb(143 211 255 / 28%); border-radius: 8px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .forgeax-dof-legend span { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 2px; }
  `;
  const panel = document.createElement('section');
  panel.className = 'forgeax-dof-panel';
  panel.innerHTML = `
    <h1>Depth of Field Lab</h1>
    <p>Static focus chart: near, focus, and far planes share one camera.</p>
    <div class="forgeax-dof-buttons" role="group" aria-label="Depth of field preset">
      <button type="button" data-preset="off">Off</button>
      <button type="button" data-preset="near">Near</button>
      <button type="button" data-preset="far">Far</button>
      <button type="button" data-preset="both">Both</button>
    </div>
    <label class="forgeax-dof-row"><span>Focus distance</span><input data-control="focus" type="range" min="3.5" max="18" step="0.1" value="9"><span class="forgeax-dof-value" data-value="focus">9.0m</span></label>
    <label class="forgeax-dof-row"><span>F-stop</span><input data-control="fstop" type="range" min="0.7" max="8" step="0.1" value="0.7"><span class="forgeax-dof-value" data-value="fstop">f/0.7</span></label>
    <div class="forgeax-dof-status" data-status></div>
  `;
  const legend = document.createElement('div');
  legend.className = 'forgeax-dof-legend';
  legend.innerHTML = '<span style="background:#ff311b"></span>near 4.5m &nbsp; <span style="background:#14d7ff"></span>focus 9m &nbsp; <span style="background:#c02aff"></span>far 17m';
  root.append(style, panel, legend);
  const controller = new AbortController();
  const focus = panel.querySelector<HTMLInputElement>('[data-control="focus"]');
  const fstop = panel.querySelector<HTMLInputElement>('[data-control="fstop"]');
  const status = panel.querySelector<HTMLElement>('[data-status]');
  const apply = (next: DepthOfFieldPreset): void => {
    const selected = PRESETS[next];
    dof.setControls({ ...selected, fStop: Number(fstop?.value ?? DEFAULT_CONTROLS.fStop) });
    dof.setPreset(next);
    update();
  };
  panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => apply(button.dataset.preset as DepthOfFieldPreset), { signal: controller.signal });
  });
  focus?.addEventListener('input', () => {
    dof.setControls({ focusDistance: Number(focus.value) });
    dof.setPreset('both');
    update();
  }, { signal: controller.signal });
  fstop?.addEventListener('input', () => {
    dof.setControls({ fStop: Number(fstop.value) });
    update();
  }, { signal: controller.signal });

  function update(): void {
    const snapshot = dof.snapshot();
    const activePreset: DepthOfFieldPreset = snapshot.enabled ? snapshot.preset : 'off';
    panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
      button.dataset.active = String(button.dataset.preset === activePreset);
    });
    const focusValue = panel.querySelector<HTMLElement>('[data-value="focus"]');
    const fstopValue = panel.querySelector<HTMLElement>('[data-value="fstop"]');
    if (focus) focus.value = String(snapshot.controls.focusDistance);
    if (fstop) fstop.value = String(snapshot.controls.fStop);
    if (focusValue) focusValue.textContent = `${snapshot.controls.focusDistance.toFixed(1)}m`;
    if (fstopValue) fstopValue.textContent = `f/${snapshot.controls.fStop.toFixed(1)}`;
    if (status) status.textContent = `${snapshot.enabled ? snapshot.preset.toUpperCase() : 'OFF'}\nfocus=${snapshot.focalDistance.toFixed(1)}m  aperture=f/${snapshot.aperture.toFixed(1)}\nScene: 4.5m / 9m / 17m`;
  }
  update();
  return {
    dispose: () => {
      controller.abort();
      panel.remove();
      legend.remove();
      style.remove();
    },
    update,
  };
}

function installProjection(ctx: Context, host: GameHost, dof: DepthOfFieldHandle, panel: { readonly update: () => void }): void {
  const disposers = [host.gameProjection?.registerRead({
    id: 'depth-of-field.snapshot',
    title: 'Read static DoF lab state',
    description: 'Read the static near/focus/far calibration scene and the current camera DoF authoring state.',
    read: () => asProjection({
      scene: { layers: LAYERS.map(({ id, title, distance }) => ({ id, title, distance })), animated: false },
      depthOfField: dof.snapshot(),
      renderer: host.renderer?.inspect().depthOfField ?? null,
    }),
  }), host.gameProjection?.registerAction({
    id: 'depth-of-field.set-preset',
    title: 'Set DoF lab preset',
    description: 'Switch the static calibration scene between off, near, far, and both.',
    run: (input) => {
      const requested = input as { readonly preset?: unknown };
      const next = requested.preset;
      if (next !== 'off' && next !== 'near' && next !== 'far' && next !== 'both') return asProjection({ error: 'preset must be off, near, far, or both' });
      const selected = PRESETS[next];
      dof.setControls(selected);
      dof.setPreset(next);
      panel.update();
      return asProjection({ preset: next, depthOfField: dof.snapshot() });
    },
  })].filter((dispose): dispose is () => void => dispose !== undefined);
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'depth-of-field-demo/projection');
}

const depthOfFieldDemo: Plugin = {
  name: 'depth-of-field-demo',
  inject: ['world', 'gameHost'],
  apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('depth-of-field-demo requires GameHost');
    const { dof } = buildScene(ctx.world, host);
    const panel = mountPanel(host, dof);
    installProjection(ctx, host, dof, panel);
    const global = globalThis as unknown as { __forgeaxDepthOfFieldDemo?: unknown };
    const demo = {
      setPreset: (preset: DepthOfFieldPreset) => {
        const selected = PRESETS[preset];
        dof.setControls(selected);
        dof.setPreset(preset);
        panel.update();
      },
      setControls: (controls: Partial<DepthOfFieldControls>) => {
        dof.setControls(controls);
        panel.update();
      },
      reset: () => {
        dof.setControls(DEFAULT_CONTROLS);
        dof.setPreset('off');
        panel.update();
      },
      snapshot: () => ({
        scene: { layers: LAYERS.map(({ id, title, distance }) => ({ id, title, distance })), animated: false },
        depthOfField: dof.snapshot(),
        renderer: host.renderer?.inspect().depthOfField ?? null,
        rendererState: host.renderer?.state() ?? 'unavailable',
      }),
    };
    global.__forgeaxDepthOfFieldDemo = demo;
    ctx.effect(() => () => {
      panel.dispose();
      dof.dispose();
      if (global.__forgeaxDepthOfFieldDemo === demo) delete global.__forgeaxDepthOfFieldDemo;
    }, 'depth-of-field-demo');
  },
};

export default depthOfFieldDemo;
