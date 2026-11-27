import * as OriginalCore from 'three/src/Three.Core.js';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import * as Native from '@forgeax/engine-three';

export async function runComparison(lane, changed, objects, frames, materialKind = 'basic') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 384;
  document.body.replaceChildren(canvas);
  const options = { canvas, antialias: false, alpha: true };
  const coldStart = performance.now();
  const renderer =
    lane === 'forgeax' ? new Native.WebGPURenderer(options) : new OriginalRenderer(options);
  const THREE = lane === 'three' ? OriginalCore : Native;
  const scene = new THREE.Scene();
  const side = Math.ceil(Math.sqrt(objects));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, side * 10);
  camera.position.z = (0.55 * side) / Math.tan((25 * Math.PI) / 180);
  scene.background = new THREE.Color(0x202020);
  const material = materialKind === 'physical'
    ? new THREE.MeshPhysicalMaterial({ color: 0x49bf70, roughness: 0.8, clearcoat: 0.4 })
    : new THREE.MeshBasicMaterial({ color: 0x91c983 });
  if (materialKind === 'physical') {
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(1, 2, 5);
    scene.add(sun, new THREE.AmbientLight(0xffffff, 0.4));
  }
  const geometry = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  const rows = [];
  for (let i = 0; i < objects; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((i % side) - (side - 1) / 2, Math.floor(i / side) - (side - 1) / 2, 0);
    scene.add(mesh);
    rows.push(mesh);
  }
  await renderer.init();
  const initMs = performance.now() - coldStart;
  let maxColdSubmitMs = 0;
  if (lane === 'three' && !renderer.backend.isWebGPUBackend)
    throw Error('Reference requires native WebGPU');
  renderer.setPixelRatio(1);
  renderer.setSize(384, 384, false);
  const submit = [],
    complete = [],
    intervals = [];
  let previousReady;
  let completed = 0,
    attempts = 0,
    firstReadyMs;
  const warmup = 24;
  const deadline = performance.now() + 120000;
  try {
    while (completed < warmup + frames) {
      if (performance.now() > deadline)
        throw Error('Renderer failed to complete requested workload');
      for (let j = 0; j < changed; j++)
        rows[(completed * 17 + j) % objects].rotation.y = 0.03 * (1 + completed);
      const start = performance.now();
      renderer.render(scene, camera);
      const submitted = performance.now();
      if (completed === 0) maxColdSubmitMs = Math.max(maxColdSubmitMs, submitted - start);
      await (lane === 'three'
        ? renderer.backend.device.queue.onSubmittedWorkDone()
        : renderer.waitForGPU());
      const end = performance.now();
      attempts++;
      if (lane === 'forgeax') {
        const receipt = Native.readThreeFrame(renderer)?.receipt;
        if (!receipt) throw Error('Missing submission receipt');
        (await receipt.completed).unwrap();
        if (receipt.presentation !== 'ready') {
          await receipt.preparationCompleted;
          continue;
        }
      }
      const ready = performance.now();
      if (firstReadyMs === undefined) firstReadyMs = ready - coldStart;
      if (completed >= warmup) {
        submit.push(submitted - start);
        complete.push(end - start);
        intervals.push(ready - previousReady);
      }
      previousReady = ready;
      completed++;
      if (completed === warmup && globalThis.beginRendererProfile) {
        await globalThis.beginRendererProfile();
        performance.mark('renderer-benchmark-start');
        previousReady = performance.now();
      }
    }
    if (globalThis.endRendererProfile) {
      performance.mark('renderer-benchmark-end');
      await globalThis.endRendererProfile();
    }
    // Read the final canvas in the same animation task as its draw.
    renderer.render(scene, camera);
    const pixels = document.createElement('canvas');
    pixels.width = canvas.width;
    pixels.height = canvas.height;
    const context = pixels.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const rgba = context.getImageData(0, 0, pixels.width, pixels.height).data;
    let foreground = 0;
    const mask = new Uint8Array(Math.ceil(rgba.length / 32));
    for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
      if (rgba[4 * pixel + 1] <= rgba[4 * pixel] + 10) continue;
      mask[pixel >> 3] |= 1 << (pixel & 7);
      foreground++;
    }
    if (foreground < objects || foreground > pixels.width * pixels.height * 0.95)
      throw Error('Missing or invalid rendered geometry: ' + foreground);
    return {
      lane,
      changed,
      objects,
      warmup,
      completed,
      attempts,
      firstReadyMs,
      foreground,
      coverageMask: mask.toBase64(),
      materialKind,
      initMs,
      maxColdSubmitMs,
      threeRevision: OriginalCore.REVISION,
      submit,
      complete,
      intervals,
    };
  } finally {
    geometry.dispose();
    material.dispose();
    await renderer.dispose();
  }
}
