import * as THREE from '@forgeax/engine/three';
import { uniform } from '@forgeax/engine/three/tsl';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

function bluePixels(pixels: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (
      (pixels[i + 2] ?? 0) > (pixels[i + 1] ?? 0) + 10 &&
      (pixels[i + 2] ?? 0) > (pixels[i] ?? 0) + 20
    )
      count++;
  return count;
}

export const opticalModes = ['iridescence', 'transmission', 'transmission-loaded'] as const;
export async function verifyOpticalNodeInputs(
  renderer: THREE.WebGPURenderer,
  mode: (typeof opticalModes)[number],
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  let scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const iridescence = mode === 'iridescence';
  const geometry = iridescence
    ? new THREE.SphereGeometry(1.15, 40, 24)
    : new THREE.BoxGeometry(1.8, 2.2, 0.5);
  let material = new THREE.MeshPhysicalNodeMaterial({
    color: 0x80b0ff,
    roughness: iridescence ? 0.2 : 0,
    ior: iridescence ? 1.5 : 1,
    side: THREE.DoubleSide,
  });
  const ignored = new THREE.Texture();
  if (iridescence) {
    material.iridescence = 0;
    material.iridescenceNode = uniform(1);
    material.iridescenceIORNode = uniform(1.3);
    material.iridescenceThicknessNode = uniform(200);
    material.iridescenceMap = material.iridescenceThicknessMap = ignored;
  } else {
    material.transmission = 0;
    // r187 NodeMaterial JSON omits the ordinary IOR; keep the authored optical value explicit.
    material.iorNode = uniform(1);
    material.transmissionNode = uniform(0);
    material.thicknessNode = uniform(0.4);
    material.attenuationDistanceNode = uniform(2);
    material.attenuationColorNode = uniform(new THREE.Color(0.5, 0.8, 1));
    if (mode !== 'transmission-loaded') material.transmissionMap = material.thicknessMap = ignored;
  }
  const mesh = new THREE.Mesh(geometry, material);
  const backgroundGeometry = new THREE.PlaneGeometry(5, 5);
  const backgroundMaterial = new THREE.MeshBasicMaterial({ color: 0x60b050 });
  const background = new THREE.Mesh(backgroundGeometry, backgroundMaterial);
  background.position.z = -1;
  const stripGeometry = new THREE.PlaneGeometry(0.6, 3);
  const stripMaterial = new THREE.MeshBasicMaterial({
    color: 0xe04830,
    transparent: true,
    opacity: 0.8,
  });
  const strip = new THREE.Mesh(stripGeometry, stripMaterial);
  strip.position.z = -0.7;
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(1, 2, 4);
  scene.add(background, strip, mesh, light, new THREE.AmbientLight(0xffffff, Math.PI));
  if (mode === 'transmission-loaded') {
    mesh.name = 'glass';
    scene.updateMatrixWorld(true);
    scene = (await new THREE.NodeObjectLoader()
      .setNodes({ UniformNode: THREE.UniformNode, UniformGroupNode: THREE.UniformGroupNode })
      .setNodeMaterials({ MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial })
      .parseAsync(JSON.parse(JSON.stringify(scene.toJSON())))) as THREE.Scene;
    const parsed = scene.getObjectByName('glass');
    if (!(parsed instanceof THREE.Mesh)) throw Error('missing loaded glass');
    material = parsed.material as THREE.MeshPhysicalNodeMaterial;
    expect((material.iorNode as THREE.UniformNode<'float', number>).value).toBe(1);
  }
  try {
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    expect(bluePixels(displayPixels(first))).toBeGreaterThan(1000);
    await evidence(`${mode}-initial`, first, scene, camera);
    if (iridescence) {
      (material.iridescenceNode as THREE.UniformNode<'float', number>).value = 0.7;
      (material.iridescenceIORNode as THREE.UniformNode<'float', number>).value = 1.8;
      (material.iridescenceThicknessNode as THREE.UniformNode<'float', number>).value = 430;
    } else {
      (material.transmissionNode as THREE.UniformNode<'float', number>).value = 0.75;
      (material.thicknessNode as THREE.UniformNode<'float', number>).value = 0.7;
      (material.attenuationDistanceNode as THREE.UniformNode<'float', number>).value = 1.5;
      (material.attenuationColorNode as THREE.UniformNode<'color', THREE.Color>).value.setRGB(
        1,
        0.5,
        0.3,
      );
    }
    await readyFrames(renderer, scene, camera, 1);
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    expect(bluePixels(displayPixels(edited))).toBeGreaterThan(1000);
    await evidence(`${mode}-edited`, edited, scene, camera);
    await verifyReplay(edited, `r187-optical-node-${mode}`);
  } finally {
    if (mode === 'transmission-loaded')
      for (const child of scene.children)
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
    geometry.dispose();
    material.dispose();
    backgroundGeometry.dispose();
    backgroundMaterial.dispose();
    stripGeometry.dispose();
    stripMaterial.dispose();
    ignored.dispose();
  }
}
