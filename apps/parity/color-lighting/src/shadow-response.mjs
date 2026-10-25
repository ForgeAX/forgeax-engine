import { createPublicationAssets } from '@forgeax/engine-runtime/internal/renderer-host';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRenderer } from '@forgeax/engine';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Camera, Materials, MeshFilter, MeshRenderer, PointLight, PointLightShadow, ShadowParticipation, SpotLight, TONEMAP_LINEAR } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import * as webgpu from '@forgeax/engine/rhi-webgpu';
import * as THREE from 'three/webgpu';
import { renderWorldResponse, responseRgb } from '../../../../packages/runtime/src/__tests__/skylight-response.fixture.ts';

const size = 256;
const recorder = new URLSearchParams(location.search).has('capture')
  ? (await import('@forgeax/engine/rhi-debug')).attachRecorder(webgpu).unwrap() : undefined;
const forgeax = (await createRenderer(document.querySelector('#forgeax'),
  { rhi: recorder?.backend.rhi ?? webgpu.rhi }, forgeaxBundlerAdapter())).unwrap();
const three = new THREE.WebGPURenderer({ canvas: document.querySelector('#three'), antialias: false });
await three.init(); three.setSize(size, size, false);
three.toneMapping = THREE.NoToneMapping; three.shadowMap.enabled = true;
const target = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace });
const boxes = [
  { pos: [0, 0, 0], scale: [1.3, 1.3, 1.3], cast: true },
  { pos: [0, 0, -1], scale: [6, 6, 0.1], cast: false },
];
function parameters(options) {
  return { kind: 'point', path: 'forward', kernel: 3, normalBias: 0, depthBias: 0,
    cameraX: 0, distance: 1, mapSize: 128, ...options };
}
async function nativeWorld(p, shadows) {
  const assets = await createPublicationAssets(forgeaxBundlerAdapter());
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1], roughness: 1, metallic: 0 })).unwrap();
  for (const box of boxes) world.spawn(
    { component: Transform, data: { pos: box.pos, scale: box.scale } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: ShadowParticipation, data: { cast: box.cast } },
  ).unwrap();
  world.spawn({ component: Transform, data: { pos: [p.cameraX, 0, 6] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 50, clearColor: [0, 0, 0, 1], antialias: 0, bloom: 0, tonemap: TONEMAP_LINEAR } }).unwrap();
  const position = [1.8 * p.distance, 2.6 * p.distance, 2.2 * p.distance];
  const shadow = { mapSize: p.mapSize, nearPlane: 0.5, farPlane: 50, pcfKernelSize: p.kernel, normalBias: p.normalBias, depthBias: p.depthBias };
  const light = { color: [1, 1, 1], intensity: 60 * p.distance ** 2, range: Infinity };
  world.spawn({ component: Transform, data: { pos: position } },
    ...(p.kind === 'point' ? [
      { component: PointLight, data: light },
      ...(shadows ? [{ component: PointLightShadow, data: shadow }] : []),
    ] : [{ component: SpotLight, data: { ...light, ...shadow, innerConeDeg: 60, outerConeDeg: 60, direction: position.map((v, i) => (i === 2 ? -1 : 0) - v), castShadow: shadows } }]),
  ).unwrap();
  return world;
}
async function reference(p, shadows) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50); camera.position.set(p.cameraX, 0, 6);
  for (const box of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...box.scale), new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.8, 0.8, 0.8), roughness: 1 }));
    mesh.position.set(...box.pos); mesh.castShadow = box.cast; mesh.receiveShadow = true; scene.add(mesh);
  }
  const light = p.kind === 'point' ? new THREE.PointLight(0xffffff, 60 * p.distance ** 2, 0, 2) : new THREE.SpotLight(0xffffff, 60 * p.distance ** 2, 0, Math.PI / 3, 0, 2);
  light.position.set(1.8 * p.distance, 2.6 * p.distance, 2.2 * p.distance); light.castShadow = shadows;
  if (p.kind === 'spot') { light.target.position.set(0, 0, -1); scene.add(light.target); }
  light.shadow.mapSize.set(p.mapSize, p.mapSize);
  light.shadow.camera.near = 0.5; light.shadow.camera.far = 50;
  light.shadow.normalBias = p.normalBias;
  // This comparison varies Spot's world-space normal offset. Point retains
  // its documented world/texel bias policy, tested separately at zero bias.
  light.shadow.bias = -p.depthBias; light.shadow.radius = (p.kernel - 1) / 2;
  three.shadowMap.type = p.kernel === 1 ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  scene.add(light);
  try {
    three.setRenderTarget(target); three.render(scene, camera);
    const data = await three.readRenderTargetPixelsAsync(target, 0, 0, size, size);
    three.setRenderTarget(null); three.render(scene, camera);
    return responseRgb(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } finally { scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); light.shadow.dispose(); }
}
function visibility(shadow, lit) {
  return Float32Array.from({ length: size * size }, (_, i) =>
    lit[i * 3] > 0.01 ? Math.min(1, shadow[i * 3] / lit[i * 3]) : 1);
}
function difference(a, b, cameraX) {
  const project = (x) => size / 2 + x * size / (2 * 5.35 * Math.tan(Math.PI / 8));
  const minX = project(-0.65 - cameraX) - 8, maxX = project(0.65 - cameraX) + 8;
  const minY = project(-0.65) - 8, maxY = project(0.65) + 8;
  let count = 0, sum = 0, max = 0, shadowPixels = 0, edgePixels = 0;
  let selfCount = 0, selfError = 0, selfVisibility = 0;
  for (let y = 24; y < size - 24; y++) for (let x = 24; x < size - 24; x++) {
    const i = y * size + x;
    // Exclude the central cube and its silhouette; measure the receiver.
    if (x > minX && x < maxX && y > minY && y < maxY) {
      if (x > minX + 16 && x < maxX - 16 && y > minY + 16 && y < maxY - 16) {
        selfCount++; selfError += Math.abs(a[i] - b[i]); selfVisibility += a[i];
      }
      continue;
    }
    const error = Math.abs(a[i] - b[i]); sum += error; max = Math.max(max, error); count++;
    if (b[i] < 0.5) shadowPixels++;
    if (b[i] > 0.01 && b[i] < 0.99) edgePixels++;
  }
  return { mean: sum / count, max, shadowPixels, edgePixels,
    self: { pixels: selfCount, meanError: selfError / selfCount, visibility: selfVisibility / selfCount } };
}
async function capture(draw) {
  if (!recorder) throw new Error('Open with ?capture');
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap(); await draw(); (await recorder.frameBoundary()).unwrap();
  const artifact = (await pending).unwrap();
  const url = URL.createObjectURL(new Blob([artifact.bytes]));
  const link = document.createElement('a'); link.href = url; link.download = 'shadow.rhitape'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function run(options = {}, record = false) {
  const p = parameters(options);
  const referenceLit = await reference(p, false), referenceShadow = await reference(p, true);
  const nativeLit = await renderWorldResponse(forgeax, await nativeWorld(p, false), p.path);
  const nativeShadow = await renderWorldResponse(forgeax, await nativeWorld(p, true), p.path, record ? capture : undefined);
  const actual = visibility(nativeShadow, nativeLit), expected = visibility(referenceShadow, referenceLit);
  const report = { ...p, threeRevision: THREE.REVISION, ...difference(actual, expected, p.cameraX), pointShadow: forgeax.inspect().pointShadow };
  document.querySelector('#status').textContent = JSON.stringify(report, null, 2);
  for (const key of ['kind', 'path', 'kernel', 'cameraX', 'distance', 'normalBias']) document.getElementById(key).value = String(p[key]);
  return { report, actual: Array.from(actual), expected: Array.from(expected) };
}
const controls = () => run(Object.fromEntries(['kind', 'path', 'kernel', 'cameraX', 'distance', 'normalBias'].map(key => [key, ['kind', 'path'].includes(key) ? document.getElementById(key).value : Number(document.getElementById(key).value)])));
document.querySelector('#run').onclick = controls;
for (const element of document.querySelectorAll('input,select')) element.onchange = controls;
globalThis.shadowResponse = { run };
globalThis.shadowResponse.initial = await run();
