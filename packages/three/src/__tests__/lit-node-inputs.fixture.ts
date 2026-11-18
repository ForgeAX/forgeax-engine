import * as THREE from '@forgeax/engine/three';
import { uniform } from '@forgeax/engine/three/tsl';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export async function verifyLitNodeInputs(
  renderer: THREE.WebGPURenderer,
  loaded: boolean,
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
  const geometry = new THREE.SphereGeometry(0.65, 32, 20);
  const materials = [
    new THREE.MeshLambertNodeMaterial(),
    new THREE.MeshStandardNodeMaterial(),
    new THREE.MeshPhysicalNodeMaterial(),
  ];
  for (const [index, material] of materials.entries()) {
    material.color.setRGB(0.3, 0.5, 0.7);
    material.emissiveIntensity = 4;
    material.emissiveNode = uniform(new THREE.Color(0.04, 0.01, 0.02));
    if (material instanceof THREE.MeshStandardNodeMaterial) {
      material.roughness = 0.95;
      material.metalness = 0.95;
      material.roughnessNode = uniform(0.25);
      material.metalnessNode = uniform(0.3);
    }
    if (material instanceof THREE.MeshPhysicalNodeMaterial) {
      material.clearcoat = material.sheen = 0;
      material.clearcoatNode = uniform(0.9);
      material.clearcoatRoughnessNode = uniform(0.15);
      material.sheenNode = uniform(new THREE.Color(0.7, 0.1, 0.3));
      material.sheenRoughnessNode = uniform(0.4);
      material.specularIntensityNode = uniform(0.7);
      material.specularColorNode = uniform(new THREE.Color(0.8, 0.7, 0.6));
      material.iorNode = uniform(1.8);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = (index - 1) * 1.45;
    scene.add(mesh);
  }
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(1, 2, 4);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.3));
  if (loaded) {
    const loader = new THREE.NodeObjectLoader();
    loader.setNodes({
      UniformNode: THREE.UniformNode,
      UniformGroupNode: THREE.UniformGroupNode,
    });
    loader.setNodeMaterials({
      MeshLambertNodeMaterial: THREE.MeshLambertNodeMaterial,
      MeshStandardNodeMaterial: THREE.MeshStandardNodeMaterial,
      MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial,
    });
    scene.updateMatrixWorld(true);
    scene = (await loader.parseAsync(JSON.parse(JSON.stringify(scene.toJSON())))) as THREE.Scene;
  }
  const meshes = scene.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  expect(meshes).toHaveLength(3);
  for (const [index, mesh] of meshes.entries())
    expect(mesh.position.x).toBeCloseTo((index - 1) * 1.45);
  try {
    await renderer.renderAsync(scene, camera);
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    expect(displayPixels(first).filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      1000,
    );
    await evidence('initial', first, scene, camera);
    for (const child of scene.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const material = child.material as THREE.MeshPhysicalNodeMaterial;
      (material.emissiveNode as THREE.UniformNode<'color', THREE.Color>).value.setRGB(
        0.08,
        0.15,
        0.02,
      );
      if (material instanceof THREE.MeshStandardNodeMaterial) {
        (material.roughnessNode as THREE.UniformNode<'float', number>).value = 0.7;
        (material.metalnessNode as THREE.UniformNode<'float', number>).value = 0.05;
      }
      if (material instanceof THREE.MeshPhysicalNodeMaterial) {
        (material.clearcoatNode as THREE.UniformNode<'float', number>).value = 0.2;
        (material.clearcoatRoughnessNode as THREE.UniformNode<'float', number>).value = 0.6;
        (material.sheenNode as THREE.UniformNode<'color', THREE.Color>).value.setRGB(0.1, 0.6, 0.2);
        (material.sheenRoughnessNode as THREE.UniformNode<'float', number>).value = 0.8;
        (material.specularIntensityNode as THREE.UniformNode<'float', number>).value = 0.3;
        (material.specularColorNode as THREE.UniformNode<'color', THREE.Color>).value.setRGB(
          0.2,
          0.4,
          0.8,
        );
        (material.iorNode as THREE.UniformNode<'float', number>).value = 1.3;
      }
    }
    await readyFrames(renderer, scene, camera, 1);
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    await evidence('edited', edited, scene, camera);
    await verifyReplay(edited, `r187-lit-node-${loaded ? 'loaded' : 'authored'}`);
  } finally {
    if (loaded)
      for (const child of scene.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      }
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
