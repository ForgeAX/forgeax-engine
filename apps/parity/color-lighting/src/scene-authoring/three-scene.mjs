import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

// Complete scene authoring: no shared scene/material/light setup helpers.
/** @param {HTMLCanvasElement} canvas */
export async function createThreeScene(canvas) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) throw new Error('This comparison requires WebGPU');
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(0.025, 0.035, 0.055);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 40);
  camera.position.set(7, 5, 9);
  camera.lookAt(0, 0.8, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(4, 8, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.00001;
  sun.shadow.normalBias = 0.05;
  const csm = new CSMShadowNode(sun, { cascades: 3, maxFar: 40, mode: 'practical' });
  sun.shadow.shadowNode = csm;
  scene.add(sun, sun.target);
  // Optional diagnostic: AmbientLight is diffuse-only, unlike a flat environment.
  const ambient = new THREE.AmbientLight(0xffffff, 0);
  scene.add(ambient);

  const objects = [
    {
      geometry: new THREE.BoxGeometry(10, 0.2, 10),
      position: [0, -0.1, 0],
      color: 0x858b94,
      metalness: 0,
      roughness: 0.8,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: new THREE.BoxGeometry(1.6, 1.6, 1.6),
      position: [-1.6, 0.8, 0],
      color: 0x367fd4,
      metalness: 0,
      roughness: 0.35,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: new THREE.SphereGeometry(0.9, 48, 32),
      position: [1.2, 0.9, 0],
      color: 0xc98242,
      metalness: 0.65,
      roughness: 0.25,
      emissive: 0,
      emissiveIntensity: 0,
    },
    {
      geometry: new THREE.SphereGeometry(0.25, 32, 24),
      position: [0, 1.9, -1.4],
      color: 0xffffff,
      metalness: 0,
      roughness: 0.5,
      emissive: 0xffc070,
      emissiveIntensity: 6,
    },
  ];
  const meshes = objects.map(({ geometry, position, ...parameters }) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(parameters));
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  });

  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const glow = bloom(color, 1, 0, 1);
  glow.smoothWidth.value = 0.01;
  const plainPost = fxaa(renderOutput(color, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace));
  const bloomPost = fxaa(
    renderOutput(color.add(glow), THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace),
  );
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let mode = 'direct';

  function resize() {
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    if (csm.camera) csm.updateFrustums();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  await renderer.setAnimationLoop(() => {
    if (mode === 'direct') renderer.render(scene, camera);
    else pipeline.render();
  });

  return {
    /** @param {'direct' | 'post' | 'bloom'} next */
    setMode(next) {
      mode = next;
      pipeline.outputNode = next === 'bloom' ? bloomPost : plainPost;
      pipeline.needsUpdate = true;
    },
    /** @param {boolean} enabled */
    setShadows(enabled) {
      for (const mesh of meshes) mesh.receiveShadow = enabled;
    },
    /** @param {boolean} enabled */
    setAmbient(enabled) {
      ambient.intensity = enabled ? 0.3 : 0;
    },
    /** @param {boolean} side */
    setView(side) {
      camera.position.set(side ? -7 : 7, 5, 9);
      camera.lookAt(0, 0.8, 0);
    },
    async dispose() {
      await renderer.setAnimationLoop(null);
      observer.disconnect();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      csm.dispose();
      scenePass.dispose();
      glow.dispose();
      pipeline.dispose();
      renderer.dispose();
    },
  };
}
