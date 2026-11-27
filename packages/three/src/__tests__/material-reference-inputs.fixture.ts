import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const referenceModes = [
  'basic',
  'standard',
  'physical',
  'sprite',
  'dashed',
  'explicit',
] as const;
export async function verifyMaterialReferences(
  renderer: THREE.WebGPURenderer,
  mode: (typeof referenceModes)[number],
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
  { replay = true } = {},
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const base = referenceMaterial(mode);
  base.transparent = true;
  const target = new THREE.MeshBasicNodeMaterial();
  Reflect.set(target, 'tint', new THREE.Color(0.2, 0.8, 0.3));
  const color = THREE.TSL.materialReference('tint', 'color', mode === 'explicit' ? target : null);
  const alpha = new THREE.MaterialReferenceNode('alpha', 'float');
  const originalReference = color.reference;
  base.colorNode = color;
  base.opacityNode = alpha;
  const materials =
    mode === 'physical'
      ? [base, base.clone()]
      : [new THREE.NodeMaterialInstance(base), new THREE.NodeMaterialInstance(base)];
  const geometry =
    mode === 'dashed'
      ? new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.55, -0.5, 0),
          new THREE.Vector3(0, 0.5, 0),
          new THREE.Vector3(0.55, -0.5, 0),
        ])
      : new THREE.BoxGeometry(1.1, 1.1, 0.7);
  for (const [i, material] of materials.entries()) {
    Reflect.set(material, 'tint', new THREE.Color(i === 0 ? 0x22cc44 : 0x3366dd));
    Reflect.set(material, 'alpha', i === 0 ? 0.8 : 0.6);
    Reflect.set(material, 'surfaceRoughness', i === 0 ? 0.4 : 0.8);
    const object =
      mode === 'sprite'
        ? new THREE.Sprite(material as never)
        : mode === 'dashed'
          ? new THREE.Line(geometry, material)
          : new THREE.Mesh(geometry, material);
    if (object instanceof THREE.Line) object.computeLineDistances();
    object.position.x = i === 0 ? -0.85 : 0.85;
    scene.add(object);
  }
  if (base instanceof THREE.MeshStandardNodeMaterial) {
    base.roughnessNode = THREE.TSL.materialReference('surfaceRoughness', 'float');
    // Physical uses ordinary materials: instance prototype accessors remain a separate boundary.
    if (mode === 'physical')
      Reflect.set(materials[1] as object, 'roughnessNode', base.roughnessNode);
  }
  if (base instanceof THREE.LineDashedNodeMaterial) {
    base.offsetNode = THREE.TSL.materialReference('dashOffset', 'float');
    for (const [i, material] of materials.entries())
      Reflect.set(material, 'dashOffset', i === 0 ? 0.03 : 0.1);
  }
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
    expect(color.reference).toBe(originalReference);
    expect(color.node).toBeNull();
    expect(alpha.reference).toBeNull();
    expect(alpha.node).toBeNull();
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    await capture('initial');
    Reflect.set(materials[0] as object, 'tint', new THREE.Color(0xdd3344));
    Reflect.set(materials[0] as object, 'alpha', 0.4);
    await capture('left-edit');
    Reflect.set(materials[1] as object, 'tint', new THREE.Color(0xddaa33));
    Reflect.set(materials[1] as object, 'alpha', 0.9);
    Reflect.set(target, 'tint', new THREE.Color(0xaa33dd));
    if (base instanceof THREE.LineDashedNodeMaterial)
      Reflect.set(materials[1] as object, 'dashOffset', 0.14);
    const edited = await capture('right-target-edit');
    if (replay) await verifyReplay(edited, `r187-material-reference-${mode}`);
  } finally {
    geometry.dispose();
    for (const material of new Set([...materials, base, target])) material.dispose();
  }
}

export async function verifyReferenceBoundaries(
  renderer: THREE.WebGPURenderer,
  evidence: Parameters<typeof verifyMaterialReferences>[2],
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.BoxGeometry(1.4, 1.4, 0.7),
    material = new THREE.MeshBasicNodeMaterial();
  const reference = THREE.TSL.materialReference('tint', 'color');
  material.colorNode = reference;
  Reflect.set(material, 'tint', new THREE.Color(0x20dd40));
  scene.add(new THREE.Mesh(geometry, material));
  try {
    reference.properties = ['other'];
    expect(() => renderer.render(scene, camera)).toThrow('three-unsupported');
    expect(renderer.inspect().sources).toHaveLength(0);
    reference.properties = ['tint'];
    Reflect.set(material, 'tint', undefined);
    expect(() => renderer.render(scene, camera)).toThrow('three-unsupported');
    expect(renderer.inspect().sources).toHaveLength(0);
    Reflect.set(material, 'tint', new THREE.Color(0x20dd40));
    await readyFrames(renderer, scene, camera, 60);
    const frame = await renderer.captureFrame(scene, camera);
    expect(displayPixels(frame).filter((v, i) => i % 4 === 1 && v > 80).length).toBeGreaterThan(
      100,
    );
    await evidence('boundaries-recovered', frame, scene, camera);
    await verifyReplay(frame, 'r187-material-reference-boundaries');
  } finally {
    geometry.dispose();
    material.dispose();
  }
}

function referenceMaterial(mode: (typeof referenceModes)[number]) {
  return mode === 'sprite'
    ? new THREE.SpriteNodeMaterial()
    : mode === 'dashed'
      ? new THREE.LineDashedNodeMaterial({ dashSize: 0.15, gapSize: 0.1 })
      : mode === 'physical'
        ? new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6 })
        : mode === 'standard'
          ? new THREE.MeshStandardNodeMaterial({ roughness: 0.6 })
          : new THREE.MeshBasicNodeMaterial();
}
