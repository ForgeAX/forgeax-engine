import * as THREE from '@forgeax/engine/three';
import { OrbitControls } from '@forgeax/engine/three/addons/controls/OrbitControls.js';
import { buildFrameModel, decodeTape } from '@forgeax/engine/rhi-debug';

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
}
const canvas = element<HTMLCanvasElement>('#scene');
const status = element('#status');
const error = element('#error');
const capture = element<HTMLButtonElement>('#capture');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#19232f');
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
camera.position.set(4, 2.5, 6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.3, 0);
controls.enableDamping = true;
const material = new THREE.MeshPhysicalMaterial({ color: '#66c6b2', roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 });
const matcapMaterial = new THREE.MeshMatcapMaterial();
const cube = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.BoxGeometry(1.5, 1.5, 1.5), material);
cube.position.set(-1.05, 0.3, 0);
cube.name = 'shared-material-cube';
const sphere = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.SphereGeometry(0.85, 12, 8), material);
sphere.position.set(1.15, 0.3, 0);
sphere.name = 'shared-material-sphere';
const sphereNormals = sphere.geometry.getAttribute('normal');
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: '#202d3a' }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.55;
floor.name = 'ground';
scene.add(cube, sphere, floor);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(3, 5, 4);
const fill = new THREE.PointLight('#a4bfff', 30);
fill.position.set(-3, 1, 2);
scene.add(sun, fill);
const spot = new THREE.SpotLight(0xffffff, 180, 0, 0.3, 0.4);
spot.position.copy(sun.position);
spot.target.position.set(0, 0.3, 0);
spot.visible = false;
scene.add(spot, spot.target);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
let affine = false, shiftedLens = false;
const shearMatrix = new THREE.Matrix4().makeShear(0, 0, 0.45, 0, 0.2, -0.2);
function resize() {
  const parent = canvas.parentElement;
  if (parent === null) return;
  renderer.setSize(parent.clientWidth, parent.clientHeight, false);
  camera.aspect = parent.clientWidth / parent.clientHeight;
  if (shiftedLens)
    camera.setViewOffset(parent.clientWidth, parent.clientHeight,
      parent.clientWidth * 0.15, parent.clientHeight * 0.1, parent.clientWidth, parent.clientHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
if (canvas.parentElement !== null) new ResizeObserver(resize).observe(canvas.parentElement);
resize();
let paused = false, alternate = false, removed = false, frames = 0;
element('#material').onclick = (event) => {
  const showMatcap = cube.material !== matcapMaterial;
  cube.material = sphere.material = showMatcap ? matcapMaterial : material;
  (event.currentTarget as HTMLElement).textContent = showMatcap ? 'Use physical material' : 'Use matcap material';
  element<HTMLButtonElement>('#color').disabled = showMatcap;
  element<HTMLButtonElement>('#clearcoat').disabled = showMatcap;
  element<HTMLButtonElement>('#flat').disabled = showMatcap;
  element<HTMLButtonElement>('#normals').disabled = showMatcap;
  if (showMatcap) {
    sphere.geometry.setAttribute('normal', sphereNormals);
    element('#normals').textContent = 'Remove sphere normals';
  }
};
element('#flat').onclick = (event) => {
  material.flatShading = !material.flatShading;
  material.needsUpdate = true;
  (event.currentTarget as HTMLElement).textContent = material.flatShading ? 'Use smooth shading' : 'Use flat shading';
};
element('#normals').onclick = (event) => {
  const missing = sphere.geometry.hasAttribute('normal');
  if (missing) sphere.geometry.deleteAttribute('normal');
  else sphere.geometry.setAttribute('normal', sphereNormals);
  (event.currentTarget as HTMLElement).textContent = missing ? 'Restore sphere normals' : 'Remove sphere normals';
};
element('#exposure').onclick = (event) => {
  renderer.toneMappingExposure = renderer.toneMappingExposure === 1 ? 2 : 1;
  (event.currentTarget as HTMLElement).textContent = `Exposure: ${renderer.toneMappingExposure}×`;
};
element('#pause').onclick = (event) => { paused = !paused; (event.currentTarget as HTMLElement).textContent = paused ? 'Resume rotation' : 'Pause rotation'; };
element('#affine').onclick = (event) => {
  affine = !affine;
  cube.matrixAutoUpdate = !affine;
  (event.currentTarget as HTMLElement).textContent = affine ? 'Remove matrix shear' : 'Apply matrix shear';
};
element('#lens').onclick = (event) => {
  shiftedLens = !shiftedLens;
  resize();
  (event.currentTarget as HTMLElement).textContent = shiftedLens ? 'Center camera lens' : 'Offset camera lens';
};
element('#color').onclick = () => { alternate = !alternate; material.color.set(alternate ? '#eeaa68' : '#66c6b2'); };
element('#clearcoat').onclick = (event) => {
  material.clearcoat = material.clearcoat === 0 ? 0.8 : 0;
  (event.currentTarget as HTMLElement).textContent = material.clearcoat === 0 ? 'Enable clearcoat' : 'Disable clearcoat';
};
element('#light').onclick = (event) => {
  spot.visible = !spot.visible;
  sun.visible = !spot.visible;
  (event.currentTarget as HTMLElement).textContent = spot.visible ? 'Use directional light' : 'Use spot light';
};
element('#remove').onclick = (event) => {
  removed = !removed;
  if (removed) scene.remove(sphere); else scene.add(sphere);
  (event.currentTarget as HTMLElement).textContent = removed ? 'Add sphere' : 'Remove sphere';
};
const downloadUrls: string[] = [];
function download(name: string, bytes: Uint8Array | string) {
  const url = URL.createObjectURL(new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]));
  downloadUrls.push(url);
  const link = document.createElement('a');
  link.className = 'download'; link.href = url; link.download = name; link.textContent = name;
  element('#downloads').append(link);
}
capture.onclick = async () => {
  capture.disabled = true;
  element('#capture-status').textContent = 'Capturing GPU frame…';
  try {
    const result = await renderer.captureFrame(scene, camera);
    const model = buildFrameModel(decodeTape(result.tape.bytes).unwrap());
    element('#downloads').replaceChildren();
    for (const url of downloadUrls.splice(0)) URL.revokeObjectURL(url);
    download('three-compat.rhitape', result.tape.bytes);
    const { observations, ...observation } = result.observation;
    download('three-compat.sources.json', JSON.stringify({ sources: result.sources, observation: { ...observation,
      observations: observations?.map(({ bytes, ...item }) => ({ ...item, byteLength: bytes.byteLength })) },
      frameId: result.receipt.frameId }, null, 2));
    element('#capture-status').textContent = `Captured frame ${result.receipt.frameId}: ${model.works.length} GPU work items, ${model.resources.length} resources.`;
  } catch (cause) { error.textContent = JSON.stringify(cause instanceof Error ? { ...cause, message: cause.message } : cause, null, 2); }
  finally { capture.disabled = false; }
};
try {
  await renderer.init();
  renderer.subscribe((event) => {
    if (event.kind === 'error') {
      error.textContent = JSON.stringify(event, null, 2);
      renderer.setAnimationLoop(null);
    }
  });
  renderer.setAnimationLoop((time) => {
    try {
      if (!paused) { cube.rotation.y = time * 0.00025; cube.rotation.x = time * 0.00012; }
      if (affine) { cube.updateMatrix(); cube.matrix.multiply(shearMatrix); }
      controls.update();
      renderer.render(scene, camera);
      const info = renderer.inspect();
      if (info.receipt?.presentation === 'ready') frames++;
      status.textContent = `Forgeax ${info.receipt?.backendId ?? 'WebGPU'} · ${frames} ready frames · ${info.sources.length} objects`;
      capture.disabled = info.receipt?.presentation !== 'ready';
      document.documentElement.dataset.readyFrames = String(frames);
    } catch (cause) { renderer.setAnimationLoop(null); error.textContent = JSON.stringify(cause instanceof Error ? { ...cause, message: cause.message } : cause, null, 2); }
  });
} catch (cause) { error.textContent = JSON.stringify(cause instanceof Error ? { ...cause, message: cause.message } : cause, null, 2); }
