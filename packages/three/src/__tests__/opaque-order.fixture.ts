import * as THREE from '@forgeax/engine/three';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { expect } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

export function opaqueScene() {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const red = new THREE.MeshBasicMaterial({ color: 0xff0000, depthWrite: false, depthTest: false });
  const blue = new THREE.MeshBasicMaterial({
    color: 0x0000ff,
    depthWrite: false,
    depthTest: false,
  });
  const first = new THREE.Mesh(geometry, red),
    second = new THREE.Mesh(geometry, blue);
  first.position.z = -0.1;
  first.renderOrder = 2;
  scene.add(first, second);
  return {
    scene,
    camera,
    first,
    second,
    dispose: () => {
      geometry.dispose();
      red.dispose();
      blue.dispose();
    },
  };
}

export async function exerciseOpaqueOrder(
  renderer: THREE.WebGPURenderer,
  check: (
    capture: THREE.ThreeFrameCapture,
    stage: string,
    source: ReturnType<typeof opaqueScene>,
  ) => Promise<void>,
) {
  const source = opaqueScene(),
    { scene, camera, first, second } = source;
  const assertCenter = (capture: THREE.ThreeFrameCapture, expected: number[]) => {
    const offset = (64 * SIZE + 64) * 4;
    expect(Array.from(displayPixels(capture).subarray(offset, offset + 4))).toEqual(expected);
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    const authored = await renderer.captureFrame(scene, camera);
    assertCenter(authored, [255, 0, 0, 255]);
    const model = buildFrameModel(decodeTape(compactTape(authored.tape).bytes).unwrap());
    const colorDraws = model.works.filter((work) => {
      if (work.pipeline?.status !== 'available') return false;
      const descriptor = work.pipeline.descriptor as {
        desc?: { fragment?: { entryPoint?: string } };
      } | null;
      return descriptor?.desc?.fragment?.entryPoint === 'fs_main';
    });
    expect(colorDraws).toHaveLength(2);
    expect(new Set(colorDraws.map((work) => work.pipeline?.pipelineHandleId)).size).toBe(1);

    await check(authored, 'authored', source);
    const group = new THREE.Group();
    group.renderOrder = 3;
    group.add(second);
    scene.add(group);
    await readyFrames(renderer, scene, camera, 1);
    const grouped = await renderer.captureFrame(scene, camera);
    assertCenter(grouped, [0, 0, 255, 255]);
    await check(grouped, 'group', source);
    let calls = 0;
    renderer.setOpaqueSort((a, b) => {
      calls++;
      expect(a.geometry).toBe(first.geometry);
      expect(a.object === first || a.object === second).toBe(true);
      expect(a.material === first.material || a.material === second.material).toBe(true);
      return (b.id ?? 0) - (a.id ?? 0);
    });
    await readyFrames(renderer, scene, camera, 1);
    expect(calls).toBeGreaterThan(0);
    const custom = await renderer.captureFrame(scene, camera);
    assertCenter(custom, [255, 0, 0, 255]);
    await check(custom, 'custom', source);
    renderer.sortObjects = false;
    calls = 0;
    await readyFrames(renderer, scene, camera, 1);
    expect(calls).toBe(0);
    const traversal = await renderer.captureFrame(scene, camera);
    assertCenter(traversal, [0, 0, 255, 255]);
    await check(traversal, 'traversal', source);
    renderer.sortObjects = true;
    renderer.setOpaqueSort(null);
    await readyFrames(renderer, scene, camera, 1);
    const reset = await renderer.captureFrame(scene, camera);
    assertCenter(reset, [0, 0, 255, 255]);
    await check(reset, 'reset', source);
    await verifyReplay(reset, 'r187-opaque-order');
  } finally {
    renderer.sortObjects = true;
    renderer.setOpaqueSort(null);
    source.dispose();
  }
}
