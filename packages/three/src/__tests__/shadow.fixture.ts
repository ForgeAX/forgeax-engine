import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

export interface AuthoredShadowJourney {
  verifyBaseline(): Promise<void>;
  verifyAuthoredFilters(): Promise<void>;
  verifyLayersAndVariance(): Promise<void>;
  dispose(): Promise<void>;
}

export function createAuthoredShadowJourney(
  kind: 'directional' | 'point' | 'spot',
): AuthoredShadowJourney {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x405060);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(5, 5, 7);
  camera.lookAt(0, 0.5, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), material);
  cube.position.y = 1;
  cube.castShadow = cube.receiveShadow = true;
  const sun =
    kind === 'directional'
      ? new THREE.DirectionalLight(0xffffff, 3)
      : kind === 'point'
        ? new THREE.PointLight(0xffffff, 200)
        : new THREE.SpotLight(0xffffff, 200);
  sun.position.set(-3, 6, 4);
  sun.castShadow = true;
  // Keep the later 256-square and rectangular resize transitions distinct.
  sun.shadow.mapSize.set(testQuality.squareSize, testQuality.squareSize);

  scene.add(ground, cube, sun, new THREE.AmbientLight(0xffffff, 0.4));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas });
  renderer.shadowMap.enabled = true;
  const replaySlots: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  const replayFailures: unknown[] = [];
  let replayCount = 0;
  const verifyCapturedReplay = async (capture: THREE.ThreeFrameCapture, label: string) => {
    if (replayCount === 0) {
      replayCount++;
      await verifyReplay(capture, label);
      return;
    }
    const slot = replayCount++ % replaySlots.length;
    replaySlots[slot] = (replaySlots[slot] as Promise<void>)
      .then(async () => {
        await verifyReplay(capture, label);
      })
      .catch((cause: unknown) => {
        replayFailures.push(cause);
      });
  };
  const verifyPendingReplays = async () => {
    await Promise.all(replaySlots);
    if (replayFailures.length > 0)
      throw new AggregateError(replayFailures, 'Three authored shadow replay failed');
  };
  const measure = async (name: string, frames = 1) => {
    const started = performance.now();
    const milestonesMs: Record<string, number> = {};
    try {
      try {
        await readyFrames(renderer, scene, camera, frames);
      } catch (error) {
        throw new Error(`${kind}/${name}: ${JSON.stringify(error)}`, { cause: error });
      }
      milestonesMs.ready = performance.now() - started;
      const capture = await renderer.captureFrame(scene, camera);
      milestonesMs.captured = performance.now() - started;
      const reference = await renderReference(scene, camera, { shadowMap: renderer.shadowMap });
      milestonesMs.reference = performance.now() - started;
      await saveBrowserEvidence(`shadow-${kind}-${name}`, capture, reference);
      milestonesMs.saved = performance.now() - started;
      const pixels = displayPixels(capture);
      comparePixels(pixels, reference);
      await verifyCapturedReplay(capture, `${kind}/${name}`);
      milestonesMs.replayScheduled = performance.now() - started;
      return pixels;
    } finally {
      // biome-ignore lint/suspicious/noConsole: Preserve the original case deadline with named phase receipts.
      console.info(
        '[three-shadow-measure]',
        JSON.stringify({ kind, name, milliseconds: performance.now() - started, milestonesMs }),
      );
    }
  };
  let initialized = false;
  let disposed = false;
  const initialize = async () => {
    if (initialized) return;
    await renderer.init();
    initialized = true;
  };
  const verifyBaseline = async () => {
    await initialize();
    const on = await measure('default', 60);
    cube.castShadow = false;
    const off = await measure('cast-off');
    expect(on).not.toEqual(off);
    cube.castShadow = true;
    ground.receiveShadow = false;
    await measure('receive-off');
    ground.receiveShadow = true;
    camera.position.x = -4;
    camera.lookAt(0, 0.5, 0);
    await measure('camera-moved');
    await verifyPendingReplays();
  };
  const verifyAuthoredFilters = async () => {
    if (!initialized) throw new Error('verify the baseline before authored shadow filters');
    if (sun instanceof THREE.DirectionalLight) {
      sun.shadow.camera.left = -3;
      sun.shadow.camera.right = 3;
      sun.shadow.camera.updateProjectionMatrix();
    }
    if (sun instanceof THREE.SpotLight) sun.shadow.focus = 0.8;
    sun.shadow.bias = -0.001;
    sun.shadow.mapSize.set(256, 256);
    sun.shadow.radius = 2.5;
    sun.shadow.normalBias = 0.02;
    sun.shadow.intensity = 0.6;
    await measure('authored');
    if (!(sun instanceof THREE.PointLight)) {
      sun.target.position.set(1, 0, -1);
      scene.add(sun.target);
      await measure('target');
    }
    renderer.shadowMap.type = THREE.BasicShadowMap;
    await measure('basic');
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    await measure('pcf-soft');
    if (!(sun instanceof THREE.PointLight)) {
      sun.shadow.mapSize.set(256, 128);
      await measure('rectangular-soft');
      renderer.shadowMap.type = THREE.PCFShadowMap;
      await measure('rectangular-vogel');
    }
    await verifyPendingReplays();
  };
  const verifyLayersAndVariance = async () => {
    if (!initialized) throw new Error('verify the baseline before shadow layers and variance');
    cube.layers.set(1);
    sun.shadow.camera.layers.set(1);
    const shadowOnly = await measure('shadow-layer-only');
    sun.shadow.camera.layers.set(0);
    const excluded = await measure('shadow-layer-inherit');
    expect(shadowOnly).not.toEqual(excluded);
    cube.layers.set(31);
    sun.shadow.camera.layers.set(31);
    expect(await measure('shadow-layer-bit31')).toEqual(shadowOnly);
    cube.layers.set(0);
    sun.shadow.camera.layers.set(0);
    renderer.shadowMap.type = THREE.VSMShadowMap;
    const variance = await measure('variance');
    cube.castShadow = false;
    expect(await measure('variance-receiver-casts')).toEqual(variance);
    cube.receiveShadow = false;
    expect(await measure('variance-caster-off')).not.toEqual(variance);
    cube.castShadow = cube.receiveShadow = true;
    if (!(sun instanceof THREE.PointLight)) {
      sun.shadow.blurSamples = 1;
      await measure('variance-one-sample');
      sun.shadow.blurSamples = 16;
      sun.shadow.radius = 4;
      await measure('variance-wide');
    }
    await verifyPendingReplays();
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await verifyPendingReplays();
    } finally {
      await renderer.dispose();
      ground.geometry.dispose();
      cube.geometry.dispose();
      material.dispose();
      canvas.remove();
    }
  };
  return { verifyBaseline, verifyAuthoredFilters, verifyLayersAndVariance, dispose };
}

export async function verifyAuthoredShadow(kind: 'directional' | 'point' | 'spot') {
  const journey = createAuthoredShadowJourney(kind);
  try {
    await journey.verifyBaseline();
    await journey.verifyAuthoredFilters();
    await journey.verifyLayersAndVariance();
  } finally {
    await journey.dispose();
  }
}
