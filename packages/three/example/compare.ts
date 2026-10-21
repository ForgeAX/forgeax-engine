import * as THREE from '@forgeax/engine/three';
import { AmbientLight, DirectionalLight, RectAreaLight } from 'three/src/Three.Core.js';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import RectAreaLightNode from 'three/src/nodes/lighting/RectAreaLightNode.js';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing ${id}`);
  return value as T;
}
const status = element('status'), error = element('error');
const renderer = new THREE.WebGPURenderer({ canvas: element<HTMLCanvasElement>('native'), antialias: true });
const original = new OriginalRenderer({ canvas: element<HTMLCanvasElement>('reference'), antialias: true });
RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 5;

function populate(feature: string, reference: boolean) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x19232f);
  let edit = () => {};
  const basic = new THREE.MeshBasicMaterial({ color: 0x70c4ae });
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  renderer.shadowMap.enabled = original.shadowMap.enabled = feature.startsWith('shadow');
  renderer.shadowMap.type = original.shadowMap.type = feature === 'shadow-vsm' ? THREE.VSMShadowMap : THREE.PCFShadowMap;
  if (feature.startsWith('shadow')) {
    camera.position.set(5, 5, 7); camera.lookAt(0, 0.5, 0);
    const material = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), material);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), material);
    cube.position.y = 1; cube.castShadow = cube.receiveShadow = true;
    const Light = reference ? DirectionalLight : THREE.DirectionalLight;
    const light = new Light(0xffffff, 3); light.position.set(-3, 6, 4); light.castShadow = true;
    light.shadow.mapSize.set(256, 256); light.shadow.bias = -0.001;
    scene.add(ground, cube, light);
    edit = () => { cube.position.x = cube.position.x === 0 ? 1.5 : 0; light.shadow.radius = light.shadow.radius === 1 ? 4 : 1; };
  } else if (feature === 'loading') {
    const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material));
    const image = document.createElement('canvas'); image.width = image.height = 32;
    const context = image.getContext('2d');
    if (context === null) throw new Error('Missing texture encoder');
    context.fillStyle = '#40b898'; context.fillRect(0, 0, 32, 32);
    context.fillStyle = '#e0a050'; context.fillRect(0, 0, 16, 16); context.fillRect(16, 16, 16, 16);
    const url = image.toDataURL();
    edit = () => {
      material.map?.dispose();
      material.map = new THREE.TextureLoader().load(url);
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.needsUpdate = true;
    };
  } else if (feature === 'environment') {
    // Three's PMREM starts at a 16px cube LOD; use the same valid input extent
    // as the environment pixel fixtures instead of an undersized 8x4 map.
    const pixels = new Float32Array(128 * 64 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([0.2, 0.4, 0.8, 1], offset);
    const environment = new THREE.DataTexture(pixels, 128, 64, THREE.RGBAFormat, THREE.FloatType);
    environment.mapping = THREE.EquirectangularReflectionMapping; environment.needsUpdate = true;
    scene.environment = environment;
    const materials = [0, 0.5, 1].map((metalness, i) => {
      const material = new THREE.MeshPhysicalMaterial({ color: 0xb8c4df, roughness: 0.6, metalness });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.65, 40, 24), material);
      mesh.position.x = (i - 1) * 1.5; scene.add(mesh); return material;
    });
    edit = () => { for (const material of materials) material.specularIntensity = material.specularIntensity === 1 ? 0.2 : 1; };
  } else if (feature === 'alpha') {
    scene.background = null;
    const material = new THREE.MeshBasicMaterial({ color: 0x70c4ae, alphaHash: true, opacity: 0.5 });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), material));
    edit = () => { material.opacity = material.opacity === 0.5 ? 0.75 : 0.5; };
  } else if (feature === 'transmission') {
    const background = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ color: 0x60b050 }));
    background.position.z = -1; scene.add(background);
    const materials = [0x80b0ff, 0xff9080].map((color, i) => {
      const material = new THREE.MeshPhysicalMaterial({ color, transmission: 0.7, roughness: 0, ior: 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 0.5), material);
      mesh.position.set(i === 0 ? -0.4 : 0.4, 0, -0.6 * i); scene.add(mesh); return material;
    });
    const Ambient = reference ? AmbientLight : THREE.AmbientLight;
    scene.add(new Ambient(0xffffff, Math.PI));
    edit = () => { for (const material of materials) { material.forceSinglePass = !material.forceSinglePass; material.needsUpdate = true; } };
  } else if (feature === 'instances') {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), new THREE.MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i++) {
      mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i - 1, 0, 0));
      mesh.setColorAt(i, new THREE.Color([0x64c8b5, 0xe6aa60, 0x819fe7][i]));
    }
    mesh.instanceMatrix.needsUpdate = true; scene.add(mesh);
    edit = () => { mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0.7, 0)); mesh.instanceMatrix.needsUpdate = true; };
  } else if (feature === 'morph') {
    const geometry = new THREE.BoxGeometry(1.6, 1.6, 0.8), target = geometry.getAttribute('position').clone();
    for (let i = 0; i < target.count; i++) target.setX(i, target.getX(i) + target.getY(i) * 0.6);
    geometry.morphAttributes.position = [target];
    const mesh = new THREE.Mesh(geometry, basic); scene.add(mesh);
    edit = () => { if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = 1; };
  } else if (feature === 'skin') {
    const geometry = new THREE.BoxGeometry(1.2, 1.8, 0.7), position = geometry.getAttribute('position');
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: position.count * 4 }, (_, i) => i % 4 === 0 && position.getY(Math.floor(i / 4)) > 0 ? 1 : 0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: position.count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
    const mesh = new THREE.SkinnedMesh(geometry, basic), root = new THREE.Bone(), tip = new THREE.Bone();
    root.add(tip); mesh.add(root); mesh.bind(new THREE.Skeleton([root, tip])); scene.add(mesh);
    edit = () => { tip.rotation.z = 0.6; };
  } else if (feature === 'sprite') {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xe6aa60, rotation: 0.3 }));
    sprite.scale.set(1.6, 1.2, 1); scene.add(sprite);
    edit = () => { sprite.center.set(0.1, 0.7); sprite.material.rotation = -0.4; };
  } else if (feature === 'clipping') {
    const group = new THREE.ClippingGroup(), plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.2);
    group.clippingPlanes.push(plane); group.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), basic)); scene.add(group);
    edit = () => { plane.normal.set(0, 1, 0); plane.constant = -0.2; };
  } else if (feature === 'matcap') {
    const material = new THREE.MeshMatcapMaterial(); scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material));
    edit = () => { material.color.set(0xc98b72); };
  } else if (feature === 'rect') {
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshStandardMaterial({ roughness: 0.55 })));
    const light = reference ? new RectAreaLight(0xffeebb, 5, 1.5, 1) : new THREE.RectAreaLight(0xffeebb, 5, 1.5, 1);
    light.position.z = 2; scene.add(light);
    edit = () => { light.position.x = 0.7; light.lookAt(0, 0, 0); };
  } else {
    const map = new THREE.DataTexture(new Uint8Array([40,150,80,255,210,70,40,255,40,80,170,255,180,150,40,255]), 2, 2);
    const normal = new THREE.DataTexture(new Uint8Array([128,128,255,255]), 1, 1);
    const scalar = new THREE.DataTexture(new Uint8Array([180,170,100,255]), 1, 1);
    map.needsUpdate = normal.needsUpdate = scalar.needsUpdate = true;
    const material = new THREE.MeshPhysicalMaterial({ map, normalMap: normal, roughnessMap: scalar, metalnessMap: scalar, clearcoatMap: scalar, roughness: 0.7, metalness: 0.2, clearcoat: 0.7, clearcoatRoughness: 0.4 });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material));
    const light = reference ? new DirectionalLight(0xffffff, 3) : new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 3, 5); scene.add(light);
    edit = () => { material.clearcoat = 0.2; material.color.set(0xf0bd80); };
  }
  return { scene, edit };
}
let native = populate('shadow', false), reference = populate('shadow', true), frames = 0;
element<HTMLSelectElement>('feature').onchange = () => {
  const feature = element<HTMLSelectElement>('feature').value;
  native = populate(feature, false); reference = populate(feature, true); frames = 0;
};
element('edit').onclick = () => { native.edit(); reference.edit(); };
try {
  await renderer.init(); await original.init();
  if (!(original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('Reference requires WebGPU');
  await renderer.setAnimationLoop(() => {
    try {
      original.render(reference.scene, camera);
      renderer.render(native.scene, camera);
      if (renderer.inspect().receipt?.presentation === 'ready') frames++;
      document.documentElement.dataset.readyFrames = String(frames);
      status.textContent = `${element<HTMLSelectElement>('feature').selectedOptions[0]?.textContent} · ${frames} native ready frames · original WebGPU backend`;
    } catch (cause) { error.textContent = String(cause); void renderer.setAnimationLoop(null); }
  });
} catch (cause) { error.textContent = String(cause); }
