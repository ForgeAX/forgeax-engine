import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { createRenderer, defaultAssetDecoderContributions } from '@forgeax/engine/runtime';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import * as THREE from '@forgeax/engine/three';
import type { AssetKind } from '@forgeax/engine/types';

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing ${selector}`);
  return value;
}
const canvas = element<HTMLCanvasElement>('#scene');
const status = element('#status');
const depth = element<HTMLButtonElement>('#depth');
const unmount = element<HTMLButtonElement>('#unmount');
// The example retains the native renderer's default resolution policy.
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;
const assets = new AssetRegistry();
for (const contribution of defaultAssetDecoderContributions)
  assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
const world = new World({ assets });
const result = await createRenderer(canvas, { pipeline: THREE.createThreePipeline() });
if (!result.ok) throw result.error;
const renderer = result.value;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#18212c');
const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 100);
camera.position.z = 5;
const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshBasicMaterial({ color: 0xff3344 }));
cube.position.set(-0.3, 0, 0.5);
scene.add(cube);
const geometry = assets.create(createBoxGeometry(1.5, 1.5, 1.5).unwrap()).unwrap();
const material = assets.create(Materials.unlit([0.05, 0.3, 1, 1])).unwrap();
const native = world.spawn(
  { component: Transform, data: { pos: [0.3, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: geometry } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
const mount = (await THREE.mountThreeScene({ world, renderer, scene, camera })).unwrap();
const lease = renderer.attach(world);
if (!lease.ok) throw lease.error;
const nativeSource = lease.value;
let mounted = true;
let selectedCamera = mount.entityFor(camera).unwrap();
let front = false;
depth.onclick = () => {
  front = !front;
  world.set(native, Transform, { pos: [0.3, 0, front ? 1.5 : 0] }).unwrap();
};
unmount.onclick = () => {
  mount.dispose().unwrap();
  mounted = false;
  selectedCamera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 5] } },
    { component: Camera, data: { fov: 50 * Math.PI / 180, aspect: canvas.width / canvas.height, near: 0.1, far: 100 } },
  ).unwrap();
  unmount.disabled = true;
};
let stopped = false;
function frame() {
  if (stopped) return;
  try {
    // Source authoring -> native simulation (if scheduled) -> propagation -> one draw.
    if (mounted) mount.sync().unwrap();
    propagateTransforms(world).unwrap();
    const draw = renderer.draw({ source: mounted ? mount.source : nativeSource, camera: { entityKey: selectedCamera }, geometryLane: 'direct' });
    if (!draw.ok) throw draw.error;
    status.textContent = `${draw.value.presentation} · ${mounted ? 'Three + native' : 'native survives unmount'}`;
    void draw.value.completed.then((completed) => { if (!completed.ok) fail(completed.error); });
    requestAnimationFrame(frame);
  } catch (error) { fail(error); }
}
function fail(error: unknown) { stopped = true; status.textContent = String(error); }
window.addEventListener('pagehide', () => {
  stopped = true;
  mount.dispose().unwrap();
  nativeSource.dispose();
  void renderer.dispose().then(() => {
    assets.dispose();
    cube.geometry.dispose();
    cube.material.dispose();
  });
}, { once: true });
frame();
