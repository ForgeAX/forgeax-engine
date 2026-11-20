import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { surfaceExpressionExample } from './surface-expression.recipe.fixture';

export async function verifySurfaceExpression(
  renderer: THREE.WebGPURenderer,
  publication: {
    recipe: THREE.ThreeSurfaceRecipe;
    reboundRecipe: THREE.ThreeSurfaceRecipe;
    groundRecipe: THREE.ThreeSurfaceRecipe | undefined;
  },
  kind: 'standard' | 'unlit' | 'roughness',
  evidence: (name: string, capture: THREE.ThreeFrameCapture) => Promise<void>,
  replay: (
    capture: THREE.ThreeFrameCapture,
    label: string,
  ) => void | Promise<unknown> = verifyReplay,
) {
  const example = surfaceExpressionExample(kind);
  THREE.bindThreeSurface(example.material, publication.recipe).unwrap();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.PlaneGeometry(2.5, 2.5);
  const mesh = new THREE.Mesh(geometry, example.material);
  mesh.castShadow = true;
  scene.add(mesh, new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 4);
  scene.add(sun);
  const groundGeometry = new THREE.PlaneGeometry(5, 5);
  const groundMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x777777 });
  if (kind === 'standard') {
    groundMaterial.roughnessNode = THREE.TSL.float(1);
    if (!publication.groundRecipe) throw new Error('missing cooked receiver recipe');
    THREE.bindThreeSurface(groundMaterial, publication.groundRecipe).unwrap();
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(128, 128);
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.position.z = -0.5;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  let replacement: THREE.DataTexture | undefined;
  const rebound = surfaceExpressionExample(kind, undefined, undefined, true);
  try {
    await renderer.init();
    await renderer.renderAsync(scene, camera);
    await readyFrames(renderer, scene, camera, 60);
    const first = await renderer.captureFrame(scene, camera);
    await evidence(`${kind}-initial`, first);
    if (kind === 'standard') {
      sun.castShadow = false;
      await readyFrames(renderer, scene, camera, 1);
      const withoutShadow = await renderer.captureFrame(scene, camera);
      await evidence(`${kind}-shadow-off-initial`, withoutShadow);
      expect(equalBytes(displayPixels(first), displayPixels(withoutShadow))).toBe(false);
      sun.castShadow = true;
      await readyFrames(renderer, scene, camera, 1);
    }
    if (kind !== 'standard') {
      const intensity = sun.intensity;
      sun.intensity = 0;
      await readyFrames(renderer, scene, camera, 1);
      const unlit = await renderer.captureFrame(scene, camera);
      await evidence(`${kind}-lighting-off-initial`, unlit);
      expect(equalBytes(displayPixels(unlit), displayPixels(first))).toBe(true);
      sun.intensity = intensity;
      await readyFrames(renderer, scene, camera, 1);
    }
    const firstPixels = displayPixels(first);
    const drawIdentity = (capture: THREE.ThreeFrameCapture, recipe = publication.recipe) => {
      const observation = capture.observation.draws;
      expect(observation?.status).toBe('complete');
      if (observation?.status !== 'complete')
        throw new Error('missing native material draw receipts');
      const draws = observation.draws.filter(
        (draw) => draw.publication.materialGuid === recipe.programGuid,
      );
      expect(draws.length).toBeGreaterThan(0);
      return draws.map((draw) => [
        draw.materialHandle,
        draw.publication.materialGuid,
        draw.program.artifactHash,
        draw.program.specializationKey,
      ]);
    };
    const programs = drawIdentity(first);
    expect(firstPixels.filter((v, i) => i % 4 !== 3 && v > 30).length).toBeGreaterThan(1000);
    example.amount.value = 0.8;
    example.offset.value.set(0.2, -0.1);
    example.store.tint = new THREE.Color(0.15, 0.65, 0.35);
    example.store.alpha = 0.55;
    example.store.threshold = 0.45;
    await readyFrames(renderer, scene, camera, 1);
    const updated = await renderer.captureFrame(scene, camera);
    await evidence(`${kind}-uniform`, updated);
    expect(equalBytes(firstPixels, displayPixels(updated))).toBe(false);
    expect(drawIdentity(updated)).toEqual(programs);
    let textured = updated;
    if (kind !== 'roughness') {
      replacement = example.image.clone();
      replacement.image = { data: new Uint8Array([224, 32, 64, 255]), width: 1, height: 1 };
      replacement.needsUpdate = true;
      example.sampled.value = replacement;
      await readyFrames(renderer, scene, camera, 1);
      textured = await renderer.captureFrame(scene, camera);
      await evidence(`${kind}-texture`, textured);
      expect(equalBytes(displayPixels(updated), displayPixels(textured))).toBe(false);
      expect(drawIdentity(textured)).toEqual(programs);
    }
    // Replay owns a detached capture and can run while Browser verifies the next revision.
    await replay(textured, `three-surface-${kind}`);
    const receipt = renderer.inspect().receipt;
    const originalRoot = example.material.colorNode;
    example.material.colorNode = THREE.TSL.vec3(1, 0, 0);
    expect(() => renderer.render(scene, camera)).toThrow('surface roots changed');
    expect(renderer.inspect().receipt).toBe(receipt);
    const mismatch = THREE.bindThreeSurface(example.material, publication.recipe);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.detail.reason).toBe('recipe-mismatch');
    example.material.colorNode = THREE.TSL.viewportTexture();
    const screen = THREE.bindThreeSurface(example.material, publication.recipe);
    expect(screen.ok).toBe(false);
    if (!screen.ok) expect(screen.error.detail.reason).toBe('unsupported-node');
    expect(renderer.inspect().receipt).toBe(receipt);
    example.material.colorNode = originalRoot;
    await readyFrames(renderer, scene, camera, 1);
    const restored = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(restored), displayPixels(textured))).toBe(true);
    expect(drawIdentity(restored)).toEqual(programs);
    if (kind === 'unlit') {
      // An authored zero threshold still clips alpha zero in r187. A later
      // transparent draw exposes an incorrectly retained front depth write.
      rebound.store.alpha = 1;
      rebound.store.threshold = 0.1;
      THREE.bindThreeSurface(rebound.material, publication.reboundRecipe).unwrap();
      const behind = new THREE.Mesh(geometry, rebound.material);
      behind.position.z = -0.3;
      behind.renderOrder = 1;
      scene.add(behind);
      example.store.alpha = example.store.threshold = 0;
      await readyFrames(renderer, scene, camera, 1);
      const zero = await renderer.captureFrame(scene, camera);
      await evidence('unlit-zero-threshold', zero);
      expect(displayPixels(zero).filter((v, i) => i % 4 !== 3 && v > 30).length).toBeGreaterThan(
        1000,
      );
      expect(drawIdentity(zero)).toEqual(programs);
      scene.remove(behind);
      example.store.alpha = 0.55;
      example.store.threshold = 0.45;
      await readyFrames(renderer, scene, camera, 1);
    }
    rebound.amount.value = 0.8;
    rebound.store.alpha = 0.55;
    rebound.store.threshold = 0.45;
    example.material.copy(rebound.material);
    THREE.bindThreeSurface(example.material, publication.reboundRecipe).unwrap();
    await readyFrames(renderer, scene, camera, 1);
    const recompiled = await renderer.captureFrame(scene, camera);
    await evidence(`${kind}-rebound`, recompiled);
    expect(equalBytes(displayPixels(recompiled), displayPixels(textured))).toBe(false);
    expect(drawIdentity(recompiled, publication.reboundRecipe)).not.toEqual(programs);
    await replay(recompiled, `three-surface-${kind}-rebound`);
  } finally {
    replacement?.dispose();
    groundGeometry.dispose();
    groundMaterial.dispose();
    geometry.dispose();
    example.material.dispose();
    example.image.dispose();
    rebound.material.dispose();
    rebound.image.dispose();
  }
}
