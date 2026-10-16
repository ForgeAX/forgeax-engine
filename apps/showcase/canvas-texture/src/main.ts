import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine/app/browser';
import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine/assets-runtime';
import { Time, Update } from '@forgeax/engine/ecs';
import {
  Camera,
  CanvasTexture,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import { ChildOf, Transform } from '@forgeax/engine/scene';
import { type Example, paintBlank, paintDepartures, paintTelemetry, paintWelcome } from './paint';
import './style.css';

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing showcase element: ${selector}`);
  return node;
}

const canvas = element<HTMLCanvasElement>('#source');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is unavailable');
const ctx = context;
paintWelcome(ctx);

async function start() {
  const view = element<HTMLCanvasElement>('#world');
  const app = (await createApp(view, {}, forgeaxBundlerAdapter())).unwrap();
  const { world } = app;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  const texture = new CanvasTexture(canvas, { flipY: false });
  const source = world.allocSharedRef('CanvasTextureSource', texture.source);
  const display = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit('#ffffff', { baseColorTexture: source }),
  );
  const frame = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: '#25483e', roughness: 0.75, metallic: 0.15 }),
  );
  const foot = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: '#78917a', roughness: 0.9 }),
  );
  const ground = world.allocSharedRef('MaterialAsset', Materials.unlit('#d9e2d7'));
  const stripe = world.allocSharedRef('MaterialAsset', Materials.unlit('#c3d0c1'));
  const pivot = world.spawn({ component: Transform, data: {} }).unwrap();
  function box(
    pos: [number, number, number],
    scale: [number, number, number],
    material = frame,
    parent = pivot,
  ) {
    return world
      .spawn(
        { component: Transform, data: { pos, scale } },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  box([0, 2.15, 0], [4.3, 2.8, 0.22]);
  for (const x of [-1.4, 1.4]) {
    box([x, 0.52, -0.03], [0.13, 1.05, 0.16]);
    box([x, 0.045, 0], [0.6, 0.09, 0.8], foot);
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 2.15, 0.116], scale: [4, 2.5, 1] } },
      { component: ChildOf, data: { parent: pivot } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [display] } },
    )
    .unwrap();
  const stage = world.spawn({ component: Transform, data: {} }).unwrap();
  box([0, -0.09, 0], [10, 0.1, 8], ground, stage);
  for (let i = -4; i <= 4; i++) {
    box([i, -0.035, 0], [0.012, 0.005, 8], stripe, stage);
    box([0, -0.035, i], [10, 0.005, 0.012], stripe, stage);
  }
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 2.7, 5.8], quat: [-0.073, 0, 0, Math.sqrt(1 - 0.073 ** 2)] },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: 0.78,
            aspect: view.width / view.height,
            near: 0.1,
            far: 50,
          }),
          tonemap: 0,
          exposure: 1,
          clearColor: [0.737, 0.8, 0.746, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -0.8, -1], color: [1, 1, 1], intensity: 3 },
    })
    .unwrap();

  let mode: Example = 'paint';
  let paused = false;
  let color = '#ff6840';
  let stroke: { id: number; x: number; y: number } | undefined;
  let lastPaintTime = -1;
  let submittedFrames = 0;
  const status = element('#sync-status');
  const sync = element<HTMLButtonElement>('#sync');
  const brush = element<HTMLInputElement>('#brush');
  const angle = element<HTMLInputElement>('#angle');
  const sourceCaption = element('#source-caption');
  const modelCaption = element('#model-caption');
  const paintTools = element('#paint-tools');
  const note = element('#preset-note');
  const challenge = element('#challenge');

  function updateTexture() {
    if (!paused) texture.update();
  }
  function syncLabels() {
    status.textContent = paused ? 'Sync paused' : 'Live sync';
    status.dataset.paused = String(paused);
    sync.textContent = paused ? 'Resume sync' : 'Pause sync';
    sync.setAttribute('aria-pressed', String(paused));
    modelCaption.textContent = paused
      ? 'The sign is frozen. Resume to apply the latest canvas.'
      : 'Same canvas. Real depth. Move the angle to explore.';
  }
  sync.addEventListener(
    'click',
    () => {
      paused = !paused;
      updateTexture();
      syncLabels();
    },
    options,
  );
  function rotate() {
    const yaw = (Number(angle.value) * Math.PI) / 180;
    world.set(pivot, Transform, { quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }).unwrap();
  }
  angle.addEventListener('input', rotate, options);
  rotate();
  element('#clear').addEventListener(
    'click',
    () => {
      paintBlank(ctx);
      updateTexture();
    },
    options,
  );
  const swatches = document.querySelectorAll<HTMLButtonElement>('[data-color]');
  for (const swatch of swatches)
    swatch.addEventListener(
      'click',
      () => {
        color = swatch.dataset.color ?? color;
        for (const item of swatches) item.setAttribute('aria-pressed', String(item === swatch));
      },
      options,
    );
  function point(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    };
  }
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (mode !== 'paint' || stroke || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      stroke = { id: event.pointerId, ...point(event) };
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(stroke.x, stroke.y, Number(brush.value) / 2, 0, Math.PI * 2);
      ctx.fill();
      updateTexture();
    },
    options,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (!stroke || stroke.id !== event.pointerId) return;
      const next = point(event);
      ctx.strokeStyle = color;
      ctx.lineWidth = Number(brush.value);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(stroke.x, stroke.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      stroke = { id: stroke.id, ...next };
      updateTexture();
    },
    options,
  );
  function endStroke(event: PointerEvent) {
    if (stroke?.id === event.pointerId) stroke = undefined;
  }
  canvas.addEventListener('pointerup', endStroke, options);
  canvas.addEventListener('pointercancel', endStroke, options);
  canvas.addEventListener('lostpointercapture', endStroke, options);

  const presets = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
  for (const preset of presets)
    preset.addEventListener(
      'click',
      () => {
        const nextMode = preset.dataset.mode;
        if (nextMode !== 'paint' && nextMode !== 'departures' && nextMode !== 'telemetry') return;
        mode = nextMode;
        stroke = undefined;
        lastPaintTime = -1;
        for (const item of presets) item.setAttribute('aria-pressed', String(item === preset));
        canvas.dataset.readonly = String(mode !== 'paint');
        canvas.setAttribute(
          'aria-label',
          mode === 'paint' ? 'Drawing canvas. Drag to paint.' : `${mode} canvas with live updates`,
        );
        paintTools.hidden = mode !== 'paint';
        note.hidden = mode === 'paint';
        if (mode === 'paint') {
          paintWelcome(ctx);
          sourceCaption.textContent = 'Drag to draw. Every mark appears on the sign.';
          challenge.textContent = 'Pause sync, add a mark, then resume. The sign catches up.';
        } else {
          note.textContent =
            mode === 'departures'
              ? 'A live timetable, painted with ordinary 2D text.'
              : 'A moving gauge and chart, painted on the same canvas.';
          sourceCaption.textContent = 'The canvas keeps running even when model sync is paused.';
          challenge.textContent = 'Pause sync: the canvas keeps moving while the sign freezes.';
          paintExample(world.getResource(Time).elapsed);
        }
        updateTexture();
      },
      options,
    );
  function paintExample(time: number) {
    if (mode === 'departures') paintDepartures(ctx, time);
    else if (mode === 'telemetry') paintTelemetry(ctx, time);
  }
  world
    .addSystem(Update, {
      name: 'canvas-showcase-animation',
      queries: [],
      fn: (world) => {
        if (mode === 'paint') return;
        const time = world.getResource(Time).elapsed;
        // Canvas content needs 20 Hz; App remains the sole frame scheduler.
        if (time - lastPaintTime < 0.05) return;
        lastPaintTime = time;
        paintExample(time);
        updateTexture();
      },
    })
    .unwrap();
  const unlisten = app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') submittedFrames++;
  });
  const unlistenError = app.onError((error) => {
    element('#error').hidden = false;
    element('#error').textContent = `${error.code}: ${error.hint}`;
    status.textContent = 'Renderer error';
    console.error(error);
  });
  async function dispose() {
    lifetime.abort();
    unlisten();
    unlistenError();
    texture.dispose();
    (await app.dispose()).unwrap();
  }
  if (import.meta.env.DEV) {
    // Dev-only bridge for the browser gate and the App-owned RHI recorder.
    Object.assign(window, {
      canvasShowcase: {
        app,
        get submittedFrames() {
          return submittedFrames;
        },
        dispose,
      },
    });
    import.meta.hot?.dispose(() => {
      void dispose();
    });
  }
  window.addEventListener(
    'pagehide',
    () => {
      void dispose();
    },
    { once: true, ...options },
  );
  app.start().unwrap();
  sync.disabled = false;
  syncLabels();
}

start().catch((error: unknown) => {
  element('#error').hidden = false;
  element('#error').textContent = error instanceof Error ? error.message : String(error);
  element('#sync-status').textContent = 'Unable to start';
  console.error(error);
});
