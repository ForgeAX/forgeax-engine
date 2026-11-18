import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const boundModes = [
  'reference-basic',
  'reference-standard',
  'reference-vec4',
  'base-basic',
  'userdata-sprite',
  'userdata-dashed',
  'userdata-physical',
] as const;
type Mode = (typeof boundModes)[number];
type Evidence = (
  name: string,
  frame: THREE.ThreeFrameCapture,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
) => Promise<void>;
function input<T extends string>(
  mode: Mode,
  property: string,
  type: T,
  data: Record<string, unknown>,
) {
  return mode.startsWith('userdata')
    ? THREE.TSL.userData(property, type, data)
    : mode.startsWith('base')
      ? new THREE.ReferenceBaseNode(property, type, data)
      : THREE.TSL.reference(property, type, data);
}
function model(mode: Mode) {
  return mode === 'userdata-sprite'
    ? new THREE.SpriteNodeMaterial()
    : mode === 'userdata-dashed'
      ? new THREE.LineDashedNodeMaterial({ dashSize: 0.15, gapSize: 0.1 })
      : mode === 'userdata-physical'
        ? new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6 })
        : mode === 'reference-standard'
          ? new THREE.MeshStandardNodeMaterial({ roughness: 0.6 })
          : new THREE.MeshBasicNodeMaterial();
}
function bindings(mode: Mode, material: ReturnType<typeof model>, data: Record<string, unknown>) {
  const color =
    mode === 'reference-vec4'
      ? input(mode, 'tint', 'vec4', data)
      : input(mode, 'tint', 'color', data);
  const alpha = input(mode, 'alpha', 'float', data);
  material.colorNode = color;
  material.opacityNode = alpha;
  if (material instanceof THREE.MeshStandardNodeMaterial)
    material.roughnessNode = input(mode, 'roughness', 'float', data);
  if (material instanceof THREE.MeshPhysicalNodeMaterial)
    material.clearcoatNode = input(mode, 'coat', 'float', data);
  if (material instanceof THREE.LineDashedNodeMaterial)
    material.offsetNode = input(mode, 'offset', 'float', data);
  return [color, alpha];
}
export async function verifyBoundReferences(
  renderer: THREE.WebGPURenderer,
  mode: Mode,
  evidence: Evidence,
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry =
    mode === 'userdata-dashed'
      ? new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.55, -0.5, 0),
          new THREE.Vector3(0, 0.5, 0),
          new THREE.Vector3(0.55, -0.5, 0),
        ])
      : new THREE.BoxGeometry(1.1, 1.1, 0.7);
  const materials = [model(mode), model(mode)];
  const stores = materials.map((material, i) => {
    material.transparent = true;
    const data = {
      tint:
        mode === 'reference-vec4'
          ? new THREE.Vector4(0.2 + i * 0.3, 0.7 - i * 0.4, 0.3, 0.7)
          : new THREE.Color(i === 0 ? 0x22cc44 : 0x3366dd),
      alpha: 0.8,
      roughness: 0.4 + i * 0.3,
      coat: 0.2,
      offset: i * 0.07,
    };
    const nodes = bindings(mode, material, data);
    const object =
      mode === 'userdata-sprite'
        ? new THREE.Sprite(material as never)
        : mode === 'userdata-dashed'
          ? new THREE.Line(geometry, material)
          : new THREE.Mesh(geometry, material);
    if (object instanceof THREE.Line) object.computeLineDistances();
    object.position.x = i === 0 ? -0.85 : 0.85;
    scene.add(object);
    return { data, nodes };
  });
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  let previous: Uint8Array | undefined;
  const capture = async (stage: string) => {
    const frame = await renderer.captureFrame(scene, camera),
      pixels = displayPixels(frame);
    expect(pixels.filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      mode === 'userdata-dashed' ? 40 : 200,
    );
    if (previous !== undefined) expect(equalBytes(previous, pixels)).toBe(false);
    previous = pixels;
    await evidence(`${mode}-${stage}`, frame, scene, camera);
    for (const { data, nodes } of stores)
      for (const node of nodes) {
        expect(node.node).toBeNull();
        expect(node.reference).toBe(data);
      }
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    await capture('initial');
    const left = stores[0],
      right = stores[1];
    if (left === undefined || right === undefined) throw Error('missing store');
    left.data.tint =
      mode === 'reference-vec4' ? new THREE.Vector4(0.8, 0.1, 0.2, 0.5) : new THREE.Color(0xdd3344);
    left.data.alpha = 0.5;
    await capture('left-edit');
    right.data.tint =
      mode === 'reference-vec4' ? new THREE.Vector4(0.7, 0.5, 0.1, 0.9) : new THREE.Color(0xddaa33);
    right.data.alpha = 0.9;
    right.data.offset = 0.14;
    const frame = await capture('right-edit');
    await verifyReplay(frame, `r187-bound-reference-${mode}`);
  } finally {
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
export async function verifyBoundaries(renderer: THREE.WebGPURenderer, evidence: Evidence) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.BoxGeometry(1.4, 1.4, 0.7),
    material = new THREE.MeshBasicNodeMaterial();
  scene.add(new THREE.Mesh(geometry, material));
  const rtt = new THREE.RTTNode(THREE.TSL.uniform(new THREE.Color(0x20dd40)), 16, 16),
    reflector = new THREE.ReflectorNode();
  const outline = new THREE.ToonOutlinePassNode(
    scene,
    camera,
    THREE.TSL.uniform(new THREE.Color('black')),
    THREE.TSL.uniform(0.01),
    THREE.TSL.uniform(1),
  );
  try {
    for (const rejected of [
      THREE.TSL.reference('tint', 'color'),
      THREE.TSL.userData('tint', 'color'),
      rtt,
      reflector,
      outline,
    ]) {
      material.colorNode = rejected;
      expect(() => renderer.render(scene, camera)).toThrow('three-unsupported');
      expect(renderer.inspect().sources).toHaveLength(0);
    }
    material.colorNode = THREE.TSL.reference('tint', 'color', { tint: new THREE.Color(0x20dd40) });
    await readyFrames(renderer, scene, camera, 60);
    const frame = await renderer.captureFrame(scene, camera);
    expect(displayPixels(frame).filter((v, i) => i % 4 === 1 && v > 80).length).toBeGreaterThan(
      100,
    );
    await evidence('boundaries-recovered', frame, scene, camera);
    await verifyReplay(frame, 'r187-bound-reference-boundaries');
  } finally {
    rtt.dispose();
    reflector.dispose();
    outline.dispose();
    material.dispose();
    geometry.dispose();
  }
}
