import * as THREE from '@forgeax/engine/three';
import { uniform } from '@forgeax/engine/three/tsl';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { familyScene } from './node-family.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const primitiveInputModes = [
  'sprite',
  'sprite-loaded',
  'sprite-override',
  'dashed',
  'dashed-loaded',
] as const;
export async function verifyPrimitiveNodeInputs(
  renderer: THREE.WebGPURenderer,
  mode: (typeof primitiveInputModes)[number],
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  const spriteMode = mode.startsWith('sprite');
  const f = familyScene(spriteMode ? 'sprite' : 'dashed');
  let scene = f.scene,
    object = f.object;
  if (object instanceof THREE.Sprite) {
    const material = (scene.overrideMaterial ?? object.material) as THREE.SpriteNodeMaterial;
    object.center.set(0.2, 0.7);
    material.rotation = -0.5;
    if (mode === 'sprite-loaded') {
      material.sizeAttenuation = false;
      object.scale.set(0.35, 0.25, 1);
    }
    material.positionNode = uniform(new THREE.Vector3(0.3, -0.15, 0.1));
    material.rotationNode = uniform(0.3);
    material.scaleNode = uniform(new THREE.Vector2(0.8, 1.2));
  } else if (object instanceof THREE.Line) {
    const material = object.material as THREE.LineDashedNodeMaterial;
    material.dashSize = 0.8;
    material.gapSize = 0.7;
    material.scale = 3;
    material.offsetNode = uniform(0.07);
    material.dashScaleNode = uniform(1.2);
    material.dashSizeNode = uniform(0.3);
    material.gapSizeNode = uniform(0.15);
  }
  if (mode === 'sprite-override') {
    const material = new THREE.SpriteNodeMaterial({ map: f.texture });
    material.positionNode = uniform(new THREE.Vector3(-0.2, 0.1, 0));
    material.rotationNode = uniform(-0.3);
    material.scaleNode = uniform(new THREE.Vector2(1.1, 0.8));
    scene.overrideMaterial = material;
  }
  if (mode.endsWith('loaded')) {
    object.name = 'subject';
    scene.updateMatrixWorld(true);
    scene = (await new THREE.NodeObjectLoader()
      .setNodes({ UniformNode: THREE.UniformNode, UniformGroupNode: THREE.UniformGroupNode })
      .setNodeMaterials({
        SpriteNodeMaterial: THREE.SpriteNodeMaterial,
        LineDashedNodeMaterial: THREE.LineDashedNodeMaterial,
      })
      .parseAsync(JSON.parse(JSON.stringify(scene.toJSON())))) as THREE.Scene;
    const parsed = scene.getObjectByName('subject');
    if (!(parsed instanceof THREE.Sprite || parsed instanceof THREE.Line))
      throw Error('missing loaded primitive');
    object = parsed;
  }
  try {
    await readyFrames(renderer, scene, f.camera, 60);
    const first = await renderer.captureFrame(scene, f.camera);
    const foreground = displayPixels(first).filter((v, i) => i % 4 === 3 && v > 0).length;
    expect(foreground).toBeGreaterThan(spriteMode ? 300 : 40);
    await evidence(`${mode}-initial`, first, scene, f.camera);
    if (object instanceof THREE.Sprite) {
      const material = (scene.overrideMaterial ?? object.material) as THREE.SpriteNodeMaterial;
      (material.positionNode as THREE.UniformNode<'vec3', THREE.Vector3>).value.set(
        -0.25,
        0.15,
        -0.1,
      );
      (material.rotationNode as THREE.UniformNode<'float', number>).value = 0.9;
      (material.scaleNode as THREE.UniformNode<'vec2', THREE.Vector2>).value.set(1.2, 0.7);
    } else if (object instanceof THREE.Line) {
      const material = object.material as THREE.LineDashedNodeMaterial;
      (material.offsetNode as THREE.UniformNode<'float', number>).value = 0.2;
      (material.dashScaleNode as THREE.UniformNode<'float', number>).value = 1.8;
      (material.dashSizeNode as THREE.UniformNode<'float', number>).value = 0.2;
      (material.gapSizeNode as THREE.UniformNode<'float', number>).value = 0.1;
    }
    await readyFrames(renderer, scene, f.camera, 1);
    const edited = await renderer.captureFrame(scene, f.camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    await evidence(`${mode}-edited`, edited, scene, f.camera);
    if (object instanceof THREE.Line) {
      const material = object.material as THREE.LineDashedNodeMaterial;
      (material.offsetNode as THREE.UniformNode<'float', number>).value = 0.3;
      (material.dashSizeNode as THREE.UniformNode<'float', number>).value = 0.3;
      (material.gapSizeNode as THREE.UniformNode<'float', number>).value = 0.15;
      (material.dashScaleNode as THREE.UniformNode<'float', number>).value = 0;
      await readyFrames(renderer, scene, f.camera, 1);
      await evidence(`${mode}-zero`, await renderer.captureFrame(scene, f.camera), scene, f.camera);
    }
    await verifyReplay(edited, `r187-primitive-node-${mode}`);
  } finally {
    scene.overrideMaterial?.dispose();
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
    f.texture.dispose();
    if (mode.endsWith('loaded')) {
      f.object.geometry.dispose();
      (f.object.material as THREE.Material).dispose();
    }
  }
}
