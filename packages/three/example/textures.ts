import * as THREE from '@forgeax/engine/three';
import { buildFrameModel, decodeTape } from '@forgeax/engine/rhi-debug';

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing ${selector}`);
  return value;
}
const canvas = element<HTMLCanvasElement>('#scene');
const renderer = new THREE.WebGPURenderer({ canvas });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#182630');
const camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.1, -1.1, 0, 10);
camera.position.z = 2;
const geometry = new THREE.PlaneGeometry(1.7, 1.7);
const authoredNormals = geometry.getAttribute('normal');
geometry.setAttribute('gameWeight', new THREE.Float32BufferAttribute([7], 1));
const uv = geometry.getAttribute('uv');
for (const channel of [1, 2, 3]) {
  const values = uv.clone();
  for (let i = 0; i < values.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    values.setXY(i, channel === 1 ? v : 1 - u, channel === 1 ? u : channel === 3 ? 1 - v : v);
  }
  geometry.setAttribute(`uv${channel}`, values);
}
const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshStandardMaterial({ roughness: 1 }),
  new THREE.MeshPhysicalMaterial({ roughness: 1 })];
const mesh = new THREE.Mesh(geometry, materials[0]);
mesh.name = 'texture-input-plane';
scene.add(mesh, new THREE.AmbientLight(0xffffff, Math.PI));
const material = element<HTMLSelectElement>('#material');
const normals = element<HTMLSelectElement>('#normals');
const channel = element<HTMLSelectElement>('#channel');
const storage = element<HTMLSelectElement>('#storage');
const sampling = element<HTMLSelectElement>('#sampling');
const transform = element<HTMLSelectElement>('#transform');
let texture: THREE.DataTexture | undefined;

function updateGeometry() {
  if (normals.value === 'missing') geometry.deleteAttribute('normal');
  else geometry.setAttribute('normal', authoredNormals);
  element('#geometry-code').textContent = `camera.near = 0; // valid for an orthographic camera
camera.updateProjectionMatrix();
${normals.value === 'missing' ? "geometry.deleteAttribute('normal'); // lit materials infer flat shading" : "geometry.setAttribute('normal', authoredNormals);"}
geometry.setAttribute('gameWeight', new THREE.Float32BufferAttribute([7], 1)); // unused by this material`;
}

function updateCoordinates() {
  if (texture === undefined) return;
  texture.matrixAutoUpdate = transform.value !== 'manual';
  texture.offset.set(0, 0);
  texture.repeat.set(1, 1);
  texture.center.set(0, 0);
  texture.rotation = 0;
  if (transform.value === 'tiled') {
    texture.offset.set(0.17, -0.21);
    texture.repeat.set(2, 3);
    texture.center.set(0.3, 0.7);
  } else if (transform.value === 'rotated') {
    texture.repeat.set(2, 2);
    texture.center.set(0.3, 0.7);
    texture.rotation = 0.37;
  } else if (transform.value === 'manual') {
    texture.matrix.set(-1, 0, 0.2, 0, 2, -0.3, 0, 0, 1);
  }
  element('#uv-code').textContent = texture.matrixAutoUpdate
    ? `texture.offset.set(${texture.offset.x}, ${texture.offset.y});
texture.repeat.set(${texture.repeat.x}, ${texture.repeat.y});
texture.center.set(${texture.center.x}, ${texture.center.y});
texture.rotation = ${texture.rotation}; // radians; no needsUpdate for UV edits`
    : 'texture.matrixAutoUpdate = false;\ntexture.matrix.set(-1, 0, 0.2, 0, 2, -0.3, 0, 0, 1);';
}

function update() {
  const previous = texture;
  const channels = storage.value.startsWith('rgba') ? 4 : storage.value.startsWith('rg') ? 2 : 1;
  const half = storage.value.endsWith('16');
  const format = channels === 4 ? THREE.RGBAFormat : channels === 2 ? THREE.RGFormat : THREE.RedFormat;
  const pixels = (values: number[]) => half
    ? Uint16Array.from(values, (value) => THREE.DataUtils.toHalfFloat(value / 255))
    : Uint8Array.from(values);
  const mipMode = sampling.value !== 'nearest';
  texture = new THREE.DataTexture(pixels([
    [240, 30, 50, 255], [30, 220, 60, 255], [40, 70, 240, 255], [220, 190, 40, 255],
  ].flatMap((color) => color.slice(0, channels))), 2, 2, format,
  half ? THREE.HalfFloatType : THREE.UnsignedByteType);
  if (mipMode) {
    texture.mipmaps = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1].map((size, level) => ({
      width: size, height: size,
      data: pixels(Array.from({ length: size * size * channels }, (_, i) =>
        level === 0 ? 255 : [20, 210, 70, 255][i % channels] ?? 0)),
    }));
    const base = texture.mipmaps[0];
    if (base === undefined) throw new Error('Missing mip level zero');
    texture.image = base;
    texture.minFilter = sampling.value === 'base' ? THREE.NearestFilter : THREE.NearestMipmapNearestFilter;
  }
  if (sampling.value === 'anisotropic') {
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
  }
  texture.channel = Number(channel.value);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  updateCoordinates();
  for (const value of materials) { value.map = texture; value.needsUpdate = true; }
  mesh.material = materials[material.selectedIndex] ?? materials[0]!;
  updateGeometry();
  previous?.dispose();
  element('#code').textContent = `import * as THREE from '@forgeax/engine/three';

const texture = new THREE.DataTexture(data, width, height,
  THREE.${channels === 4 ? 'RGBAFormat' : channels === 2 ? 'RGFormat' : 'RedFormat'}, THREE.${half ? 'HalfFloatType' : 'UnsignedByteType'});
${mipMode ? 'texture.mipmaps = levels; // level zero first\n' : ''}texture.channel = ${texture.channel};
texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
texture.magFilter = THREE.${sampling.value === 'anisotropic' ? 'LinearFilter' : 'NearestFilter'};
texture.minFilter = THREE.${sampling.value === 'anisotropic' ? 'LinearMipmapLinearFilter' : sampling.value === 'mips' ? 'NearestMipmapNearestFilter' : 'NearestFilter'};
texture.anisotropy = ${texture.anisotropy};
texture.needsUpdate = true;
const material = new THREE.Mesh${material.value}Material({ map: texture });`;
}
for (const input of [material, channel, storage, sampling]) input.onchange = update;
normals.onchange = updateGeometry;
transform.onchange = updateCoordinates;
update();
function resize() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.left = -1.1 * width / height;
  camera.right = -camera.left;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(canvas.parentElement!);
const capture = element<HTMLButtonElement>('#capture');
const urls: string[] = [];
capture.onclick = async () => {
  capture.disabled = true;
  for (const input of [material, channel, storage, sampling, transform, normals]) input.disabled = true;
  try {
    const frame = await renderer.captureFrame(scene, camera);
    const model = buildFrameModel(decodeTape(frame.tape.bytes).unwrap());
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    element('#downloads').replaceChildren();
    for (const [name, data] of [
      ['textures.rhitape', new Uint8Array(frame.tape.bytes)],
      ['textures.sources.json', JSON.stringify({ sources: frame.sources, frameId: frame.receipt.frameId }, null, 2)],
    ] as const) {
      const url = URL.createObjectURL(new Blob([data]));
      urls.push(url);
      const link = document.createElement('a');
      link.href = url; link.download = name; link.textContent = name;
      element('#downloads').append(link);
    }
    element('#capture-status').textContent = `Frame ${frame.receipt.frameId}: ${model.works.length} GPU work items · ${model.resources.length} resources`;
  } catch (cause) { element('#error').textContent = String(cause); }
  finally {
    for (const input of [material, channel, storage, sampling, transform, normals]) input.disabled = false;
    updateGeometry();
    capture.disabled = false;
  }
};
try {
  await renderer.init();
  let frames = 0, lastFrame = -1;
  renderer.subscribe((event) => {
    if (event.kind === 'error') {
      element('#error').textContent = JSON.stringify(event, null, 2);
      renderer.setAnimationLoop(null);
    }
  });
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    const info = renderer.inspect();
    if (info.receipt?.presentation === 'ready' && info.receipt.frameId !== lastFrame) {
      lastFrame = info.receipt.frameId;
      document.documentElement.dataset.readyFrames = String(++frames);
    }
    element('#status').textContent = `Forgeax WebGPU · ${frames} ready frames`;
    capture.disabled = info.receipt?.presentation !== 'ready';
  });
} catch (cause) { element('#error').textContent = String(cause); }
