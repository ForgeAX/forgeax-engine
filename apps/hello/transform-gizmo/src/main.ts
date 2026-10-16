import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import type { GizmoMode, GizmoSpace } from '@forgeax/engine-interaction';
import type { GpuPassTimingObservation } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '../../../shared/src/canvas-capture';
import { createGizmoScene } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
const perf = new URLSearchParams(location.search).has('perf');
const result = await createApp(
  canvas,
  { pointerLockAllowed: () => false, ...(perf ? { gpuPassTiming: {} } : {}) },
  forgeaxBundlerAdapter(),
);
if (!result.ok) throw result.error;
const app = result.value,
  scene = createGizmoScene(app.world, canvas.width, canvas.height);
let frames = 0;
const timings: number[] = [];
const gpuTimings: Array<{ mode: GizmoMode; enabled: boolean; timings: GpuPassTimingObservation }> =
  [];
app.renderer.subscribe((event) => {
  if (event.kind !== 'frame-submitted') return;
  const mode = scene.gizmo.options.mode,
    enabled = scene.gizmo.target !== undefined;
  void event.receipt.completed.then(async (done) => {
    if (!done.ok) throw done.error;
    frames++;
    if (perf) {
      const observed = await app.renderer.observe(event.receipt, { include: ['timings'] });
      if (!observed.ok) throw observed.error;
      if (observed.value.timings) {
        gpuTimings.push({ mode, enabled, timings: observed.value.timings });
        if (gpuTimings.length > 600) gpuTimings.shift();
      }
    }
  });
});
const sync = () => {
  const start = performance.now();
  scene.resize(canvas.width, canvas.height);
  scene.sync();
  timings.push(performance.now() - start);
  if (timings.length > 600) timings.shift();
  const pose = app.world.get(scene.target, Transform).unwrap();
  document.querySelector('#pose')!.textContent =
    `Position ${Array.from(pose.pos, (n) => n.toFixed(2)).join(' / ')}\nScale ${Array.from(pose.scale, (n) => n.toFixed(2)).join(' / ')}`;
  document.querySelector('#hint')!.textContent = scene.gizmo.dragging
    ? `Dragging ${scene.gizmo.hovered} · Esc to cancel`
    : scene.gizmo.hovered
      ? `${scene.gizmo.hovered} handle · drag to ${scene.gizmo.options.mode}`
      : 'Drag an axis, plane or center handle';
};
app.world
  .addSystem(Update, { name: 'transform-gizmo-presentation', queries: [], fn: sync })
  .unwrap();
const coordinates = (e: PointerEvent): [number, number] => {
  const rect = canvas.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) * canvas.width) / rect.width,
    ((e.clientY - rect.top) * canvas.height) / rect.height,
  ];
};
let captured: number | undefined;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || captured !== undefined) return;
  scene.sync();
  if (scene.gizmo.begin(...coordinates(e))) {
    captured = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
canvas.addEventListener('pointerleave', () => {
  if (captured === undefined) scene.gizmo.hovered = undefined;
});
canvas.addEventListener('pointermove', (e) => {
  if (captured !== undefined) {
    if (e.pointerId === captured) scene.gizmo.move(...coordinates(e));
  } else scene.gizmo.hover(...coordinates(e));
});
const release = () => {
  const id = captured;
  captured = undefined;
  if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
};
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== captured) return;
  scene.gizmo.commit();
  release();
});
canvas.addEventListener('pointercancel', () => {
  scene.gizmo.cancel();
  release();
});
canvas.addEventListener('lostpointercapture', () => {
  if (captured !== undefined) {
    scene.gizmo.cancel();
    captured = undefined;
  }
});
window.addEventListener('blur', () => {
  scene.gizmo.cancel();
  release();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    scene.gizmo.cancel();
    release();
  }
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))
  button.addEventListener('click', () => {
    const mode = button.dataset.mode as GizmoMode;
    scene.gizmo.configure({
      mode,
      snap: document.querySelector<HTMLInputElement>('#snap')!.checked
        ? mode === 'rotate'
          ? Math.PI / 12
          : 0.25
        : 0,
    });
    release();
    for (const b of document.querySelectorAll('[data-mode]'))
      b.setAttribute('aria-pressed', String(b === button));
  });
document
  .querySelector<HTMLSelectElement>('#space')!
  .addEventListener('change', (e) =>
    scene.gizmo.configure({ space: (e.target as HTMLSelectElement).value as GizmoSpace }),
  );
document.querySelector<HTMLInputElement>('#snap')!.addEventListener('change', (e) =>
  scene.gizmo.configure({
    snap: (e.target as HTMLInputElement).checked
      ? scene.gizmo.options.mode === 'rotate'
        ? Math.PI / 12
        : 0.25
      : 0,
  }),
);
document
  .querySelector<HTMLInputElement>('#ortho')!
  .addEventListener('change', (e) => scene.orthographic((e.target as HTMLInputElement).checked));
document
  .querySelector<HTMLInputElement>('#parent')!
  .addEventListener('change', (e) => scene.parented((e.target as HTMLInputElement).checked));
document.querySelector('#reset')!.addEventListener('click', () => scene.reset());
Object.assign(globalThis, {
  __captureGizmo: async () => {
    const pixels = await captureCanvasPixels(canvas);
    if (!pixels.ok) throw pixels.error;
    return pixels.value;
  },
  __gizmo: {
    scene,
    app,
    frames: () => frames,
    timings: () => timings.slice(),
    gpuTimings: () => gpuTimings.slice(),
    pose: () => {
      const p = app.world.get(scene.target, Transform).unwrap();
      return { pos: Array.from(p.pos), quat: Array.from(p.quat), scale: Array.from(p.scale) };
    },
  },
});
scene.sync();
app.start().unwrap();
