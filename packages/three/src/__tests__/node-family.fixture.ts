import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const nodeFamilies = [
  'lambert',
  'normal',
  'matcap',
  'line',
  'dashed',
  'points',
  'sprite',
] as const;
export type NodeFamily = (typeof nodeFamilies)[number];

export function familyScene(kind: NodeFamily) {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const texture = new THREE.DataTexture(
    new Uint8Array([255, 64, 32, 255, 32, 255, 64, 255, 64, 32, 255, 255, 255, 255, 64, 255]),
    2,
    2,
  );
  texture.needsUpdate = true;
  let object: THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite;
  if (kind === 'sprite') {
    const sprite = new THREE.Sprite(
      new THREE.SpriteNodeMaterial({ map: texture, color: 0xbbddff }),
    );
    sprite.scale.set(1.6, 1.2, 1);
    object = sprite;
  } else if (kind === 'points' || kind === 'line' || kind === 'dashed') {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.2, -0.7, 0),
      new THREE.Vector3(-0.6, 0.7, 0),
      new THREE.Vector3(0, -0.7, 0),
      new THREE.Vector3(0.6, 0.7, 0),
      new THREE.Vector3(1.2, -0.7, 0),
    ]);
    if (kind === 'points')
      object = new THREE.Points(
        geometry,
        new THREE.PointsNodeMaterial({ color: 0x44ccff, size: 5 }),
      );
    else {
      const line = new THREE.Line(
        geometry,
        kind === 'line'
          ? new THREE.LineBasicNodeMaterial({ color: 0xee8844 })
          : new THREE.LineDashedNodeMaterial({
              color: 0xee8844,
              dashSize: 0.2,
              gapSize: 0.15,
              dashOffset: 0.07,
            }),
      );
      line.computeLineDistances();
      object = line;
    }
  } else {
    const material =
      kind === 'normal'
        ? new THREE.MeshNormalNodeMaterial()
        : kind === 'matcap'
          ? new THREE.MeshMatcapNodeMaterial({ matcap: texture })
          : new THREE.MeshLambertNodeMaterial({ color: 0x4488dd, map: texture });
    object = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 0.8), material);
    object.rotation.set(0.2, 0.4, 0);
  }
  scene.add(object);
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 4);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.35));
  return { scene, camera, object, texture };
}

export async function verifyNodeFamily(
  renderer: THREE.WebGPURenderer,
  kind: NodeFamily,
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  const { scene, camera, object, texture } = familyScene(kind);
  const source = object.material as THREE.NodeMaterial;
  try {
    expect(source).toBeInstanceOf(THREE.NodeMaterial);
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    expect(displayPixels(first).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    await evidence(`${kind}-initial`, first, scene, camera);
    object.rotation.z += 0.4;
    if ('color' in source && source.color instanceof THREE.Color) source.color.setHex(0xee4488);
    if (source instanceof THREE.LineDashedNodeMaterial) source.dashOffset = 0.24;
    if (object instanceof THREE.Sprite) {
      object.center.set(0.1, 0.7);
      object.material.rotation = -0.4;
      object.material.sizeAttenuation = false;
      object.scale.multiplyScalar(0.2);
    }
    await readyFrames(renderer, scene, camera, 1);
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(first), displayPixels(edited))).toBe(false);
    await evidence(`${kind}-edited`, edited, scene, camera);
    if (source instanceof THREE.LineDashedNodeMaterial) {
      source.scale = 0;
      source.dashOffset = 0.24;
      await readyFrames(renderer, scene, camera, 1);
      const hidden = await renderer.captureFrame(scene, camera);
      expect(displayPixels(hidden).every((value, index) => index % 4 !== 3 || value === 0)).toBe(
        true,
      );
      await evidence(`${kind}-constant-gap`, hidden, scene, camera);
    }
    const receipt = renderer.inspect().receipt;
    source.colorNode = new THREE.ConstNode<'float', number>(1, 'float');
    expect(() => renderer.render(scene, camera)).toThrow('NodeMaterial.colorNode');
    expect(renderer.inspect().receipt).toBe(receipt);
    source.colorNode = null;
    await verifyReplay(edited, `r187-node-family-${kind}`);
  } finally {
    object.geometry.dispose();
    source.dispose();
    texture.dispose();
  }
}

/** Sparse primitives need foreground checks as well as whole-frame error bounds. */
export function comparePrimitivePixels(actual: Uint8Array, reference: Uint8Array, size: number) {
  for (const [source, target] of [
    [actual, reference],
    [reference, actual],
  ]) {
    if (source === undefined || target === undefined) throw new Error('missing primitive pixels');
    let foreground = 0,
      matched = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        if ((source[index + 3] ?? 0) === 0) continue;
        foreground++;
        let found = false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const tx = x + dx,
              ty = y + dy;
            if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;
            const other = (ty * size + tx) * 4;
            if ((target[other + 3] ?? 0) === 0) continue;
            const delta = [0, 1, 2, 3].reduce(
              (sum, channel) =>
                sum + Math.abs((source[index + channel] ?? 0) - (target[other + channel] ?? 0)),
              0,
            );
            if (delta / (4 * 255) <= 0.05) found = true;
          }
        if (found) matched++;
      }
    if (foreground > 0) expect(matched / foreground).toBeGreaterThanOrEqual(0.9);
    else expect(target.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);
  }
}
