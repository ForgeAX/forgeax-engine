import * as THREE from '@forgeax/engine/three';
import {
  buildFrameModel,
  decodeImage,
  decodeTape,
  openReplay,
  readbackImage,
  replayDeviceRequest,
  toRgba8,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';

export const SIZE = 128;
export function testScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const material = new THREE.MeshBasicMaterial({ color: 0x50bb80 });
  const mesh: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), material);
  mesh.name = 'compatibility-cube';
  scene.add(mesh);
  return { scene, camera, material, mesh };
}

export async function readyFrames(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  frames = 1,
) {
  const deadline = Date.now() + 20000;
  let completed = 0;
  while (completed < frames) {
    renderer.render(scene, camera);
    const receipt = renderer.inspect().receipt;
    if (receipt === undefined) throw new Error('render did not submit');
    const result = await receipt.completed;
    if (!result.ok) throw result.error;
    if (receipt.presentation === 'ready') completed++;
    if (Date.now() > deadline)
      throw new Error(`scene readiness timed out: ${receipt.presentationPendingReason}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function displayPixels(capture: THREE.ThreeFrameCapture): Uint8Array {
  const display = capture.observation.observations?.find(
    (entry) => entry.domain === 'final-display',
  );
  if (display === undefined) throw new Error('missing captured final-display bytes');
  return toRgba8(decodeImage(display.bytes, display.metadata).unwrap());
}

export function comparePixels(actual: Uint8Array, expected: Uint8Array, epsilon = 0.05): number {
  expect(actual.length).toBe(expected.length);
  let error = 0,
    changed = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)) / 255;
    error += delta;
    if (delta > epsilon) changed++;
  }
  // Raster edge rules can differ by one pixel; large/interior differences cannot pass.
  expect(error / actual.length).toBeLessThanOrEqual(epsilon);
  expect(changed / actual.length).toBeLessThanOrEqual(0.03);
  return error / actual.length;
}

export async function verifyReplay(capture: THREE.ThreeFrameCapture) {
  const decoded = decodeTape(capture.tape.bytes).unwrap();
  const model = buildFrameModel(decoded);
  const draws = model.works.filter((work) => work.attachments?.colorViewHandleIds.length);
  expect(draws.length).toBeGreaterThan(0);
  const last = draws.at(-1);
  const target =
    last?.attachments?.colorResolveViewHandleIds[0] ?? last?.attachments?.colorViewHandleIds[0];
  if (last === undefined || target === undefined) throw new Error('missing final output draw');
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(decoded, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const read = (await replay.readResourceAtWork(target, last.workIndex)).unwrap();
    const image = readbackImage(read).unwrap();
    expect(image.width).toBe(SIZE);
    expect(image.height).toBe(SIZE);
    comparePixels(toRgba8(image), displayPixels(capture), 1 / 255);
  } finally {
    (await replay.dispose()).unwrap();
    webgpu.disposeDevice(device);
  }
  return { workCount: model.works.length, resourceCount: model.resources.length };
}

export async function verifyRender(
  renderer: THREE.WebGLRenderer,
  oracle?: (scene: THREE.Object3D, camera: THREE.Camera) => Uint8Array,
  evidence?: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    expected: Uint8Array | undefined,
  ) => Promise<void>,
) {
  const f = testScene();
  await renderer.init();
  await readyFrames(renderer, f.scene, f.camera, 60);
  const capture = await renderer.captureFrame(f.scene, f.camera);
  const baseline = displayPixels(capture);
  const center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
  expect(baseline[center + 1]).toBeGreaterThan(150);
  expect(baseline[0]).toBe(0);
  const source = capture.sources.find((source) => source.uuid === f.mesh.uuid);
  expect(source?.name).toBe('compatibility-cube');
  if (oracle !== undefined) comparePixels(baseline, oracle(f.scene, f.camera));
  const replay = await verifyReplay(capture);
  const coreFrame = async (name: string, root: THREE.Object3D = f.scene) => {
    await readyFrames(renderer, root, f.camera);
    const frame = await renderer.captureFrame(root, f.camera);
    const expected = oracle?.(root, f.camera);
    await evidence?.(`core-${name}`, frame, expected);
    const actual = displayPixels(frame);
    if (expected !== undefined) comparePixels(actual, expected);
    expect(actual.some((value, index) => index % 4 !== 3 && value > 50)).toBe(true);
    return frame;
  };
  f.mesh.matrixAutoUpdate = false;
  f.mesh.matrix.set(1, 0.35, 0.2, 0.1, 0, 0.8, -0.2, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const affine = await coreFrame('manual-affine');
  expect(displayPixels(affine)).not.toEqual(baseline);
  const normals = new THREE.MeshNormalMaterial();
  f.mesh.material = normals;
  const affineNormals = await coreFrame('affine-normals');
  f.mesh.matrix.elements[0] = -1;
  const mirrored = await coreFrame('mirrored-affine');
  // The box is symmetric about local X: reflection changes winding, not its visible surface.
  comparePixels(displayPixels(mirrored), displayPixels(affineNormals), 1 / 255);
  await verifyReplay(mirrored);
  f.mesh.matrix.elements[0] = 1;
  comparePixels(
    displayPixels(await coreFrame('restored-winding')),
    displayPixels(affineNormals),
    1 / 255,
  );
  f.mesh.material = f.material;
  normals.dispose();
  f.mesh.matrixWorldAutoUpdate = false;
  f.mesh.matrix.makeTranslation(100, 0, 0);
  comparePixels(displayPixels(await coreFrame('frozen-world')), displayPixels(affine), 1 / 255);
  f.mesh.matrixWorld.makeTranslation(-0.4, 0.3, 0);
  expect(displayPixels(await coreFrame('world-edit'))).not.toEqual(displayPixels(affine));
  await verifyReplay(affine);
  f.mesh.matrixAutoUpdate = true;
  f.mesh.matrixWorldAutoUpdate = true;
  f.camera.setViewOffset(SIZE * 2, SIZE * 2, SIZE / 2 + 12, SIZE / 2 - 8, SIZE, SIZE);
  const offset = await coreFrame('view-offset');
  expect(displayPixels(offset)).not.toEqual(baseline);
  f.camera.filmOffset = 2;
  f.camera.updateProjectionMatrix();
  const film = await coreFrame('film-offset');
  expect(displayPixels(film)).not.toEqual(displayPixels(offset));
  f.camera.filmOffset = -2;
  comparePixels(displayPixels(await coreFrame('cached-projection')), displayPixels(film), 1 / 255);
  await verifyReplay(film);
  f.camera.filmOffset = 0;
  f.camera.clearViewOffset();
  const root = new THREE.Group();
  root.add(f.mesh);
  comparePixels(displayPixels(await coreFrame('object-root', root)), baseline, 1 / 255);
  f.scene.add(f.mesh);
  const cameraParent = new THREE.Group();
  cameraParent.position.x = 0.4;
  cameraParent.add(f.camera);
  cameraParent.updateMatrixWorld(true);
  const parented = await coreFrame('external-camera-parent');
  expect(displayPixels(parented)).not.toEqual(baseline);
  cameraParent.position.x = 100;
  comparePixels(
    displayPixels(await coreFrame('cached-camera-parent')),
    displayPixels(parented),
    1 / 255,
  );
  cameraParent.position.x = 0.4;
  cameraParent.scale.set(-2, 3, 1);
  cameraParent.updateMatrixWorld(true);
  comparePixels(
    displayPixels(await coreFrame('scaled-camera-parent')),
    displayPixels(parented),
    1 / 255,
  );
  cameraParent.remove(f.camera);
  f.camera.matrixWorldAutoUpdate = false;
  f.camera.matrixWorldInverse.makeTranslation(-0.3, 0, -5);
  const manualView = await coreFrame('manual-view-cache');
  expect(displayPixels(manualView)).not.toEqual(baseline);
  f.camera.matrixWorld.makeTranslation(100, 0, 0);
  comparePixels(
    displayPixels(await coreFrame('frozen-view-cache')),
    displayPixels(manualView),
    1 / 255,
  );
  await verifyReplay(manualView);
  f.camera.matrixWorldAutoUpdate = true;
  f.camera.position.set(3.999999999999998, 2.499999999999999, 5.999999999999997);
  f.camera.lookAt(0, 0.3, 0);
  const orbit = await coreFrame('orbit-camera');
  expect(displayPixels(orbit)).not.toEqual(baseline);
  await verifyReplay(orbit);
  f.camera.position.set(0, 0, 5);
  f.camera.quaternion.identity();
  f.material.color.set(0xee3355);
  await readyFrames(renderer, f.scene, f.camera);
  const changed = await renderer.captureFrame(f.scene, f.camera);
  const changedPixels = displayPixels(changed);
  expect(changedPixels[center]).toBeGreaterThan(200);
  expect(changedPixels[center + 1]).toBeLessThan(100);
  expect(changedPixels).not.toEqual(baseline);
  if (oracle !== undefined) comparePixels(changedPixels, oracle(f.scene, f.camera));
  // An old tape must remain unchanged after the live source material was edited.
  await verifyReplay(capture);
  f.scene.remove(f.mesh);
  await readyFrames(renderer, f.scene, f.camera);
  f.scene.add(f.mesh);
  await readyFrames(renderer, f.scene, f.camera);
  const restored = displayPixels(await renderer.captureFrame(f.scene, f.camera));
  comparePixels(restored, changedPixels, 1 / 255);
  const texture = new THREE.DataTexture(
    new Uint8Array([180, 32, 64, 255, 32, 180, 96, 255, 64, 96, 200, 255, 200, 180, 32, 255]),
    2,
    2,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.needsUpdate = true;
  f.material.color.set(0xffffff);
  f.material.map = texture;
  f.material.needsUpdate = true;
  await readyFrames(renderer, f.scene, f.camera);
  const textureCapture = await renderer.captureFrame(f.scene, f.camera);
  const textured = displayPixels(textureCapture);
  const textureOracle = oracle?.(f.scene, f.camera);
  await evidence?.('texture', textureCapture, textureOracle);
  if (textureOracle !== undefined) comparePixels(textured, textureOracle);
  expect(textured).not.toEqual(restored);
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(0, 0, 5);
  f.scene.add(light);
  f.mesh.material = new THREE.MeshStandardMaterial({ color: 0x50bb80, roughness: 1, metalness: 0 });
  await readyFrames(renderer, f.scene, f.camera);
  const standardCapture = await renderer.captureFrame(f.scene, f.camera);
  const standard = displayPixels(standardCapture);
  const standardOracle = oracle?.(f.scene, f.camera);
  await evidence?.('standard', standardCapture, standardOracle);
  expect(standard[center + 1]).toBeGreaterThan(100);
  if (standardOracle !== undefined) comparePixels(standard, standardOracle);

  // A real migrated Rubik application uses AmbientLight with textured Lambert.
  // Keep ambient separate from image-based specular lighting and direct lights.
  f.scene.remove(light);
  const ambient = new THREE.AmbientLight(0x80c0ff, 2);
  const ambientParent = new THREE.Group();
  ambientParent.add(ambient);
  f.scene.add(ambientParent);
  let ambientBaseline: THREE.ThreeFrameCapture | undefined;
  for (const state of [
    'lambert',
    'standard',
    'physical',
    'physical-map',
    'sum',
    'layer',
    'hidden',
    'removed',
    'restore',
  ] as const) {
    if (state === 'lambert')
      f.mesh.material = new THREE.MeshLambertMaterial({ color: 0x50bb80, map: texture });
    if (state === 'standard')
      f.mesh.material = new THREE.MeshStandardMaterial({
        color: 0x50bb80,
        roughness: 0.5,
        metalness: 0.25,
      });
    if (state === 'physical')
      f.mesh.material = new THREE.MeshPhysicalMaterial({
        color: 0x50bb80,
        roughness: 0.5,
        clearcoat: 0.6,
      });
    if (state === 'physical-map') {
      (f.mesh.material as THREE.MeshPhysicalMaterial).map = texture;
      f.mesh.material.needsUpdate = true;
    }
    if (state === 'sum') {
      ambient.intensity = 1;
      ambientParent.add(ambient.clone());
    }
    if (state === 'layer') ambientParent.children[1]?.layers.set(2);
    if (state === 'hidden') ambientParent.visible = false;
    if (state === 'removed') f.scene.remove(ambientParent);
    if (state === 'restore') {
      ambientParent.visible = true;
      ambientParent.children[1]?.layers.set(0);
      f.scene.add(ambientParent);
    }
    await readyFrames(renderer, f.scene, f.camera);
    const frame = await renderer.captureFrame(f.scene, f.camera);
    const actual = displayPixels(frame);
    const expected = oracle?.(f.scene, f.camera);
    await evidence?.(`ambient-${state}`, frame, expected);
    if (expected !== undefined) comparePixels(actual, expected);
    if (state === 'hidden' || state === 'removed') expect(actual[center + 1]).toBeLessThan(3);
    else expect(actual[center + 1]).toBeGreaterThan(30);
    if (state === 'physical-map') ambientBaseline = frame;
    if (state === 'sum' || state === 'restore') {
      if (ambientBaseline === undefined) throw new Error('missing ambient baseline');
      comparePixels(actual, displayPixels(ambientBaseline), 1 / 255);
    }
  }
  if (ambientBaseline === undefined) throw new Error('missing ambient replay');
  await verifyReplay(ambientBaseline);
  f.scene.remove(ambientParent);
  f.mesh.material = new THREE.MeshStandardMaterial({ color: 0x50bb80, roughness: 1, metalness: 0 });

  // Public SpotLight mutations must change native illumination before any
  // adapter-specific debug API is used. The original renderer is independent.
  f.scene.remove(light);
  const spot = new THREE.SpotLight(0xffffff, 18, 0, 0.3, 0.4, 2);
  spot.position.set(0, 0, 3);
  f.scene.add(spot, spot.target);
  let spotBaseline: THREE.ThreeFrameCapture | undefined;
  let spotPixels: Uint8Array | undefined;
  for (const state of ['baseline', 'power', 'range', 'target', 'hard-edge', 'restore'] as const) {
    if (state === 'power') spot.power = 9 * Math.PI;
    if (state === 'range') spot.distance = 1;
    if (state === 'target') {
      spot.distance = 0;
      spot.target.position.x = 5;
    }
    if (state === 'hard-edge') {
      spot.power = 18 * Math.PI;
      spot.target.position.x = 0;
      spot.penumbra = 0;
    }
    if (state === 'restore') spot.penumbra = 0.4;
    await readyFrames(renderer, f.scene, f.camera);
    const frame = await renderer.captureFrame(f.scene, f.camera);
    const actual = displayPixels(frame);
    const reference = oracle?.(f.scene, f.camera);
    await evidence?.(`spot-${state}`, frame, reference);
    if (reference !== undefined) comparePixels(actual, reference);
    if (state === 'baseline') {
      expect(actual[center + 1]).toBeGreaterThan(100);
      spotBaseline = frame;
      spotPixels = actual;
    } else if (state === 'range' || state === 'target') {
      expect(actual[center + 1]).toBeLessThan(3);
    } else if (state === 'power') {
      expect(actual[center + 1]).toBeLessThan((spotPixels?.[center + 1] ?? 0) - 20);
    } else if (state === 'hard-edge') {
      expect(actual).not.toEqual(spotPixels);
    } else {
      if (spotPixels === undefined || spotBaseline === undefined)
        throw new Error('missing spot frame');
      comparePixels(actual, spotPixels, 1 / 255);
      await verifyReplay(spotBaseline);
    }
  }
  f.scene.remove(spot, spot.target);
  spot.dispose();
  f.scene.add(light);
  const materialFailures: unknown[] = [];
  for (const material of [
    new THREE.MeshLambertMaterial({ color: 0x50bb80 }),
    new THREE.MeshNormalMaterial(),
    new THREE.MeshMatcapMaterial({ matcap: texture }),
    new THREE.MeshPhysicalMaterial({
      color: 0x50bb80,
      roughness: 1,
      clearcoat: 0.6,
      clearcoatRoughness: 0.4,
    }),
  ]) {
    f.mesh.material = material;
    const sharedMap = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshBasicMaterial({ map: texture }),
    );
    sharedMap.position.x = 1.5;
    if (material instanceof THREE.MeshMatcapMaterial) f.scene.add(sharedMap);
    await readyFrames(renderer, f.scene, f.camera);
    const frame = await renderer.captureFrame(f.scene, f.camera);
    const expected = oracle?.(f.scene, f.camera);
    await evidence?.(material.type, frame, expected);
    // A ready receipt can contain only the output transform. Require visible
    // source geometry on both backends, including Dawn without a WebGL oracle.
    expect(displayPixels(frame)[center + 2]).toBeGreaterThan(30);
    if (expected !== undefined) {
      try {
        comparePixels(displayPixels(frame), expected);
      } catch (cause) {
        materialFailures.push(new Error(`${material.type} differs from Three r184`, { cause }));
      }
    }
    if (material instanceof THREE.MeshPhysicalMaterial) {
      const source = frame.sources.find((entry) => entry.uuid === f.mesh.uuid);
      const draw = frame.observation.draws?.draws.find(
        (entry) => entry.entityKey === source?.entityKey,
      );
      expect(draw?.publication.materialGuid).toBe('forgeax-three-physical');
      expect(draw?.program.specializationKey).toBeDefined();
      let disabled: Uint8Array | undefined;
      for (const clearcoat of [0, 0.9, 0.6]) {
        material.clearcoat = clearcoat;
        await readyFrames(renderer, f.scene, f.camera);
        const edited = await renderer.captureFrame(f.scene, f.camera);
        const pixels = displayPixels(edited);
        const reference = oracle?.(f.scene, f.camera);
        await evidence?.(`physical-clearcoat-${clearcoat}`, edited, reference);
        expect(
          edited.observation.draws?.draws.find((entry) => entry.entityKey === source?.entityKey)
            ?.program.specializationKey,
        ).toBe(draw?.program.specializationKey);
        if (clearcoat === 0) disabled = pixels;
        else if (clearcoat === 0.9) {
          expect(disabled).toBeDefined();
          expect(pixels[center] as number).toBeGreaterThan((disabled?.[center] ?? 255) + 25);
        } else comparePixels(pixels, displayPixels(frame), 1 / 255);
        if (reference !== undefined) {
          try {
            comparePixels(pixels, reference);
          } catch (cause) {
            materialFailures.push(
              new Error(`Physical clearcoat ${clearcoat} differs from Three r184`, { cause }),
            );
          }
        }
      }
      // Captured program/resources survive value replacement and source disposal.
      material.dispose();
      f.scene.remove(f.mesh);
      await readyFrames(renderer, f.scene, f.camera);
      f.scene.add(f.mesh);
      await readyFrames(renderer, f.scene, f.camera);
      comparePixels(
        displayPixels(await renderer.captureFrame(f.scene, f.camera)),
        displayPixels(frame),
        1 / 255,
      );
      await verifyReplay(frame);
    }
    f.scene.remove(sharedMap);
  }
  const abort = new AbortController();
  const pending = renderer.captureFrame(f.scene, f.camera, { signal: abort.signal });
  expect(() => renderer.render(f.scene, f.camera)).toThrow('renderer-capture-busy');
  expect(() => renderer.setSize(SIZE / 2, SIZE / 2)).toThrow('renderer-capture-busy');
  expect(() => renderer.setPixelRatio(2)).toThrow('renderer-capture-busy');
  expect(renderer.getPixelRatio()).toBe(1);
  abort.abort();
  await expect(pending).rejects.toBeDefined();
  await readyFrames(renderer, f.scene, f.camera);
  if (materialFailures.length > 0)
    throw new AggregateError(materialFailures, 'Three material conformance failed');
  return { capture, replay };
}
