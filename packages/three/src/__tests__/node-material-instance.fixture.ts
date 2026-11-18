import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const instanceModes = ['basic', 'standard', 'sprite', 'sprite-screen', 'dashed'] as const;
export async function verifyMaterialInstances(
  renderer: THREE.WebGPURenderer,
  mode: (typeof instanceModes)[number],
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const base = mode.startsWith('sprite')
    ? new THREE.SpriteNodeMaterial()
    : mode === 'dashed'
      ? new THREE.LineDashedNodeMaterial({ dashSize: 0.15, gapSize: 0.1 })
      : mode === 'standard'
        ? new THREE.MeshStandardNodeMaterial({ roughness: 0.6 })
        : new THREE.MeshBasicNodeMaterial();
  base.transparent = true;
  if (base instanceof THREE.SpriteNodeMaterial) base.sizeAttenuation = mode !== 'sprite-screen';
  if (base instanceof THREE.SpriteNodeMaterial) {
    base.positionNode = THREE.TSL.uniform(new THREE.Vector3(0.1, 0, 0));
    base.rotationNode = THREE.TSL.uniform(0.3);
    base.scaleNode = THREE.TSL.uniform(new THREE.Vector2(0.9, 1.1));
  }
  if (base instanceof THREE.LineDashedNodeMaterial) {
    base.offsetNode = THREE.TSL.uniform(0.03);
    base.dashScaleNode = THREE.TSL.uniform(1.2);
  }
  const leftMaterial = new THREE.NodeMaterialInstance(base),
    rightMaterial = new THREE.NodeMaterialInstance(base);
  leftMaterial.color = new THREE.Color(0x22cc44);
  rightMaterial.color = new THREE.Color(0x3366dd);
  const geometry =
    mode === 'dashed'
      ? new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.55, -0.5, 0),
          new THREE.Vector3(0, 0.5, 0),
          new THREE.Vector3(0.55, -0.5, 0),
        ])
      : new THREE.BoxGeometry(1.1, 1.1, 0.7);
  const objects = [leftMaterial, rightMaterial].map((material, i) => {
    const object = mode.startsWith('sprite')
      ? new THREE.Sprite(material as never)
      : mode === 'dashed'
        ? new THREE.Line(geometry, material)
        : new THREE.Mesh(geometry, material);
    if (object instanceof THREE.Line) object.computeLineDistances();
    if (mode === 'sprite-screen') object.scale.setScalar(0.2);
    object.position.x = i === 0 ? -0.85 : 0.85;
    scene.add(object);
    return object;
  });
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  let previous: Uint8Array | undefined;
  const capture = async (stage: string) => {
    const frame = await renderer.captureFrame(scene, camera),
      pixels = displayPixels(frame);
    expect(pixels.filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      mode === 'dashed' ? 40 : 200,
    );
    if (previous !== undefined) expect(equalBytes(previous, pixels)).toBe(false);
    previous = pixels;
    await evidence(`${mode}-${stage}`, frame, scene, camera);
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    await capture('initial');
    leftMaterial.color = new THREE.Color(0xdd3344);
    leftMaterial.opacity = 0.65;
    await capture('instance-edit');
    const tint = THREE.TSL.uniform(new THREE.Color(0xddaa33));
    base.colorNode = tint;
    base.needsUpdate = true;
    expect(leftMaterial.colorNode).toBe(rightMaterial.colorNode);
    await capture('shared-input');
    tint.value.setHex(0xaa33dd);
    if (base instanceof THREE.SpriteNodeMaterial)
      (base.rotationNode as THREE.UniformNode<'float', number>).value = -0.4;
    if (base instanceof THREE.LineDashedNodeMaterial)
      (base.offsetNode as THREE.UniformNode<'float', number>).value = 0.12;
    const edited = await capture('shared-edit');
    expect(leftMaterial.nodeMaterial).toBe(base);
    expect(objects).toHaveLength(2);
    await verifyReplay(edited, `r187-material-instance-${mode}`);
  } finally {
    geometry.dispose();
    for (const material of [leftMaterial, rightMaterial, base]) material.dispose();
  }
}

export async function verifyInstanceBoundaries(
  renderer: THREE.WebGPURenderer,
  evidence: Parameters<typeof verifyMaterialInstances>[2],
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.BoxGeometry(1.4, 1.4, 0.7),
    material = new THREE.MeshBasicNodeMaterial({ color: 0x20dd40 });
  const definition = new THREE.SpriteNodeMaterial({ color: 0xffff00 }),
    instance = new THREE.NodeMaterialInstance(definition);
  const mesh = new THREE.Mesh(geometry, material),
    sprite = new THREE.Sprite(instance);
  sprite.position.set(1.2, 1.1, 0);
  scene.add(mesh);
  try {
    scene.overrideMaterial = instance;
    expect(() => renderer.render(scene, camera)).toThrow('NodeMaterialInstance scene override');
    expect(renderer.inspect().sources).toHaveLength(0);
    scene.overrideMaterial = null;
    scene.add(sprite);
    for (const invalid of [null, instance]) {
      Reflect.set(instance, 'nodeMaterial', invalid);
      expect(() => renderer.render(scene, camera)).toThrow('three-unsupported');
      expect(renderer.inspect().sources).toHaveLength(0);
    }
    instance.nodeMaterial = definition;
    await readyFrames(renderer, scene, camera, 60);
    const frame = await renderer.captureFrame(scene, camera),
      pixels = displayPixels(frame);
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (
        (pixels[i + 1] ?? 0) > (pixels[i] ?? 0) + 30 &&
        (pixels[i + 1] ?? 0) > (pixels[i + 2] ?? 0) + 30
      )
        green++;
    expect(green).toBeGreaterThan(100);
    await evidence('boundaries-recovered', frame, scene, camera);
    await verifyReplay(frame, 'r187-instance-boundaries-recovered');
  } finally {
    instance.nodeMaterial = definition;
    geometry.dispose();
    material.dispose();
    instance.dispose();
    definition.dispose();
  }
}
