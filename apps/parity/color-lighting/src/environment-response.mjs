import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRenderer } from '@forgeax/engine';
import * as webgpu from '@forgeax/engine/rhi-webgpu';
import * as THREE from 'three/webgpu';
import {
  RESPONSE_FOV,
  RESPONSE_RADIUS,
  RESPONSE_SIZE,
  RESPONSE_SPHERES,
  renderResponse,
  responsePanorama,
  responsePixelErrors,
  responseRgb,
  responseSamples,
} from '../../../../packages/runtime/src/__tests__/skylight-response.fixture.ts';

const three = new THREE.WebGPURenderer({
  canvas: document.querySelector('#three'),
  antialias: false,
});
await three.init();
if (!three.backend.isWebGPUBackend) throw new Error('WebGPU is required');
three.setSize(RESPONSE_SIZE, RESPONSE_SIZE, false);
three.toneMapping = THREE.NoToneMapping;
three.outputColorSpace = THREE.SRGBColorSpace;
const environments = new Map(['panorama', 'studio'].map((source) => {
  const { width, height, data } = responsePanorama(source);
  const texture = new THREE.DataTexture(new Uint16Array(data.buffer), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  // HDRLoader uses flipY=true for top-to-bottom Radiance scanlines.
  texture.flipY = true;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return [source, texture];
}));
const camera = new THREE.PerspectiveCamera((RESPONSE_FOV * 180) / Math.PI, 1, 0.1, 30);
function referenceScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
for (const { color, metallic, roughness, center } of RESPONSE_SPHERES) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(RESPONSE_RADIUS, 96, 64),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...color.slice(0, 3)),
      metalness: metallic,
      roughness,
    }),
  );
  mesh.position.set(...center);
  scene.add(mesh);
}
  return scene;
}
const target = new THREE.RenderTarget(RESPONSE_SIZE, RESPONSE_SIZE, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  colorSpace: THREE.LinearSRGBColorSpace,
});
async function renderReference(source, rotation) {
  // Match the native fixture: each case owns a new scene and material set.
  const scene = referenceScene();
  scene.environment = environments.get(source === 'studio' ? 'studio' : 'panorama');
  scene.environmentRotation.set(0, rotation, 0);
  three.setRenderTarget(target);
  three.render(scene, camera);
  const pixels = await three.readRenderTargetPixelsAsync(target, 0, 0, RESPONSE_SIZE, RESPONSE_SIZE);
  const rgb = responseRgb(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  three.setRenderTarget(null);
  three.render(scene, camera);
  scene.traverse((object) => {
    if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); }
  });
  return rgb;
}
const recorder = new URLSearchParams(location.search).has('capture')
  ? (await import('@forgeax/engine/rhi-debug')).attachRecorder(webgpu).unwrap()
  : undefined;
const forgeax = (
  await createRenderer(document.querySelector('#forgeax'), { rhi: recorder?.backend.rhi ?? webgpu.rhi }, forgeaxBundlerAdapter())
).unwrap();
const status = document.querySelector('#status');
let running = false;
let selectedPath = 'forward';
let selectedSource = 'solid';
let selectedRotation = 0;
async function run(path = selectedPath, source = selectedSource, rotation = selectedRotation, capture = false) {
  if (running) throw new Error('response render already running');
  running = true;
  selectedPath = path;
  selectedSource = source;
  selectedRotation = rotation;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    const referenceRgb = await renderReference(source, rotation);
    const reference = responseSamples(referenceRgb);
    let tape;
    const actualRgb = await renderResponse(forgeax, source, path, rotation, capture ? async (draw) => {
      if (!recorder) throw new Error('Open this page with ?capture to record the native frame');
      const pending = recorder.captureFrame({ seed: { maxResourceBytes: 2 * 1024 * 1024 } });
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const artifact = (await pending).unwrap();
      const url = URL.createObjectURL(new Blob([artifact.bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `environment-${source}-${path}-${rotation}.rhitape`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      tape = { digest: artifact.digest, bytes: artifact.byteLength };
    } : undefined);
    const actual = responseSamples(actualRgb);
    const rows = actual.map((sample, i) => ({
      ...sample,
      reference: reference[i].rgb,
      maxError: Math.max(...sample.rgb.map((value, c) => Math.abs(value - reference[i].rgb[c]))),
    }));
    const report = {
      path,
      source,
      rotation,
      threeVersion: THREE.REVISION,
      referenceRenderer: 'WebGPURenderer',
      maxRegionError: Math.max(...rows.map((row) => row.maxError)),
      rows,
      pixelErrors: responsePixelErrors(actualRgb, referenceRgb),
      ...(tape === undefined ? {} : { tape }),
    };
    status.textContent = `${path} · ${source} · rotation ${(rotation * 180 / Math.PI).toFixed(0)}°\nMaximum region mean RGB error: ${report.maxRegionError.toFixed(6)} (linear HDR)\nMaximum material spatial error: ${Math.max(...report.pixelErrors.map(row => row.relativeError)).toFixed(6)}\nMeasured separately at each sphere's core and rim.`;
    return report;
  } finally {
    running = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
document.querySelector('#forward').onclick = () => run('forward');
document.querySelector('#deferred').onclick = () => run('deferred');
document.querySelector('#solid').onclick = () => run(selectedPath, 'solid');
document.querySelector('#panorama').onclick = () => run(selectedPath, 'panorama');
document.querySelector('#studio').onclick = () => run(selectedPath, 'studio');
document.querySelector('#rotate').onclick = () => run(selectedPath, selectedSource, selectedRotation === 0 ? Math.PI / 2 : 0);
globalThis.environmentResponse = { run, renderer: forgeax, capture: (path, source, rotation) => run(path, source, rotation, true) };
globalThis.environmentResponse.initial = await run();
