import * as THREE from '@forgeax/engine/three';
import { texture, uniform } from '@forgeax/engine/three/tsl';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { familyScene } from './node-family.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export async function verifyNodeInputs(
  renderer: THREE.WebGPURenderer,
  mode: 'uniform' | 'vec4' | 'texture',
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
  const geometry = new THREE.BoxGeometry(1.2, 1.1, 0.5);
  const makeTexture = (bytes: number[]) => {
    const texture = new THREE.DataTexture(new Uint8Array(bytes), 2, 2);
    texture.needsUpdate = true;
    return texture;
  };
  const ignored = makeTexture(Array(4).fill([0, 255, 0, 0]).flat());
  const image = makeTexture([
    255, 64, 32, 255, 32, 255, 64, 128, 64, 32, 255, 192, 255, 255, 64, 255,
  ]);
  image.colorSpace = THREE.SRGBColorSpace;
  const mask = makeTexture([128, 255, 0, 255, 192, 0, 255, 255, 64, 255, 0, 255, 255, 0, 255, 255]);
  const replacement = makeTexture([
    32, 180, 240, 255, 180, 32, 240, 128, 240, 180, 32, 192, 32, 240, 180, 255,
  ]);
  replacement.colorSpace = THREE.SRGBColorSpace;
  const color = uniform(new THREE.Color(0.7, 0.15, 0.3));
  const alpha = uniform(0.8);
  const vector = uniform(new THREE.Vector4(0.7, 0.15, 0.3, 0.6));
  const colorTexture = texture(image),
    opacityTexture = texture(mask);
  const materials = [
    new THREE.MeshBasicNodeMaterial(),
    new THREE.MeshLambertNodeMaterial(),
    new THREE.MeshStandardNodeMaterial(),
    new THREE.MeshPhysicalNodeMaterial(),
  ];
  for (const [index, material] of materials.entries()) {
    material.color.setHex(0x001100);
    material.opacity = 0.05;
    material.map = ignored;
    material.alphaMap = ignored;
    material.transparent = true;
    material.depthWrite = false;
    material.colorNode = mode === 'texture' ? colorTexture : mode === 'vec4' ? vector : color;
    material.opacityNode = mode === 'texture' ? opacityTexture : alpha;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(index % 2 === 0 ? -0.8 : 0.8, index < 2 ? 0.75 : -0.75, 0);
    mesh.rotation.y = 0.25;
    scene.add(mesh);
  }
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 4);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.35));
  try {
    await renderer.renderAsync(scene, camera);
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    expect(
      displayPixels(first).filter((value, index) => index % 4 === 3 && value > 0).length,
    ).toBeGreaterThan(1000);
    await evidence(`${mode}-initial`, first, scene, camera);
    if (mode === 'vec4') {
      vector.value.set(0.1, 0.7, 0.3, 0.3);
      alpha.value = 0.45;
    } else if (mode === 'uniform') {
      color.value.setRGB(0.1, 0.7, 0.3);
      alpha.value = 0.45;
    } else {
      colorTexture.value = replacement;
      mask.colorSpace = THREE.SRGBColorSpace;
      mask.needsUpdate = true;
    }
    await readyFrames(renderer, scene, camera, 1);
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    await evidence(`${mode}-edited`, edited, scene, camera);
    const receipt = renderer.inspect().receipt;
    const firstMaterial = materials[0];
    if (firstMaterial === undefined) throw Error('missing material');
    firstMaterial.colorNode = uniform(new THREE.Color('red')).mul(uniform(0.5));
    expect(() => renderer.render(scene, camera)).toThrow('NodeMaterial.colorNode');
    expect(renderer.inspect().receipt).toBe(receipt);
    firstMaterial.colorNode = mode === 'texture' ? colorTexture : mode === 'vec4' ? vector : color;
    await verifyReplay(edited, `r187-node-input-${mode}`);
  } finally {
    geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of [ignored, image, mask, replacement]) texture.dispose();
  }
}

export async function verifyNodeOverride(
  renderer: THREE.WebGPURenderer,
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
  const mask = new THREE.DataTexture(new Uint8Array([0, 255, 0, 255]), 1, 1);
  mask.needsUpdate = true;
  const original = new THREE.MeshBasicMaterial({
    color: 'green',
    alphaMap: mask,
    transparent: true,
  });
  const override = new THREE.MeshBasicNodeMaterial({
    color: 'green',
    opacity: 0.05,
    transparent: true,
  });
  override.colorNode = uniform(new THREE.Color(0.2, 0.4, 0.8));
  override.opacityNode = uniform(0.6);
  const geometry = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geometry, original));
  scene.overrideMaterial = override;
  try {
    await renderer.renderAsync(scene, camera);
    await readyFrames(renderer, scene, camera, 60);
    const capture = await renderer.captureFrame(scene, camera);
    expect(
      displayPixels(capture).filter((value, index) => index % 4 === 3 && value > 0).length,
    ).toBeGreaterThan(1000);
    await evidence('override', capture, scene, camera);
    await verifyReplay(capture, 'r187-node-input-override');
  } finally {
    geometry.dispose();
    original.dispose();
    override.dispose();
    mask.dispose();
  }
}

export const nodeInputPrimitives = ['line', 'dashed', 'points', 'sprite'] as const;
export async function verifyNodeInputPrimitive(
  renderer: THREE.WebGPURenderer,
  kind: (typeof nodeInputPrimitives)[number],
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  const { scene, camera, object, texture: image } = familyScene(kind);
  const material = object.material;
  if (Array.isArray(material) || !(material instanceof THREE.NodeMaterial))
    throw Error('missing node material');
  const tint = uniform(new THREE.Color(0.8, 0.1, 0.3)),
    opacity = uniform(0.65);
  material.colorNode = tint;
  material.opacityNode = opacity;
  material.transparent = true;
  material.depthWrite = false;
  try {
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    expect(displayPixels(first).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    await evidence(`primitive-${kind}-initial`, first, scene, camera);
    tint.value.setRGB(0.1, 0.7, 0.3);
    opacity.value = 0.4;
    await readyFrames(renderer, scene, camera, 1);
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    await evidence(`primitive-${kind}-edited`, edited, scene, camera);
    material.colorNode = texture(image);
    if (kind === 'sprite') {
      await readyFrames(renderer, scene, camera, 1);
      const sampled = await renderer.captureFrame(scene, camera);
      expect(equalBytes(displayPixels(edited), displayPixels(sampled))).toBe(false);
      await evidence(`primitive-${kind}-texture`, sampled, scene, camera);
    } else {
      const receipt = renderer.inspect().receipt;
      expect(() => renderer.render(scene, camera)).toThrow('do not transport source UV');
      expect(renderer.inspect().receipt).toBe(receipt);
    }
    await verifyReplay(edited, `r187-node-input-${kind}`);
  } finally {
    object.geometry.dispose();
    material.dispose();
    image.dispose();
  }
}
