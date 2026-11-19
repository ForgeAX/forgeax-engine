import type * as Engine from '@forgeax/engine/three';
import type * as EngineNodes from '@forgeax/engine/three/tsl';
import * as NativeNodes from 'three/src/Three.TSL.js';
import * as Native from 'three/src/Three.WebGPU.js';
import { surfaceExpressionExample } from './surface-expression.recipe.fixture';
import { renderReference } from './webgpu-reference.fixture';

/** A separately constructed native r187 graph never enters Engine admission or binding. */
export async function surfaceExpressionReference(
  kind: 'standard' | 'unlit' | 'roughness',
  phase: string,
): Promise<Uint8Array> {
  const example = surfaceExpressionExample(
    kind,
    Native as unknown as typeof Engine,
    NativeNodes as unknown as typeof EngineNodes,
    phase.endsWith('rebound'),
  );
  const scene = new Native.Scene(),
    camera = new Native.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new Native.PlaneGeometry(2.5, 2.5);
  scene.add(new Native.Mesh(geometry, example.material), new Native.AmbientLight(0xffffff, 0.6));
  const sun = new Native.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 4);
  scene.add(sun);
  const groundGeometry = new Native.PlaneGeometry(5, 5);
  const groundMaterial = new Native.MeshStandardMaterial({ color: 0x777777, roughness: 1 });
  if (kind === 'standard') {
    sun.castShadow = true;
    sun.shadow.mapSize.set(128, 128);
    const caster = scene.children.find((child) => child instanceof Native.Mesh);
    if (caster !== undefined) caster.castShadow = true;
    const ground = new Native.Mesh(groundGeometry, groundMaterial);
    ground.position.z = -0.5;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  let replacement: Native.DataTexture | undefined;
  let backdrop: ReturnType<typeof surfaceExpressionExample> | undefined;
  if (!phase.endsWith('initial')) {
    example.amount.value = 0.8;
    example.offset.value.set(0.2, -0.1);
    example.store.tint = new Native.Color(0.15, 0.65, 0.35);
    example.store.alpha = 0.55;
    example.store.threshold = 0.45;
  }
  if (phase.endsWith('texture')) {
    replacement = example.image.clone();
    replacement.image = { data: new Uint8Array([224, 32, 64, 255]), width: 1, height: 1 };
    replacement.needsUpdate = true;
    example.sampled.value = replacement;
  }
  if (phase.includes('lighting-off')) sun.intensity = 0;
  if (phase.includes('shadow-off')) sun.castShadow = false;
  if (phase.endsWith('zero-threshold')) {
    example.store.alpha = example.store.threshold = 0;
    backdrop = surfaceExpressionExample(
      kind,
      Native as unknown as typeof Engine,
      NativeNodes as unknown as typeof EngineNodes,
      true,
    );
    backdrop.store.alpha = 1;
    backdrop.store.threshold = 0.1;
    const behind = new Native.Mesh(geometry, backdrop.material);
    behind.position.z = -0.3;
    behind.renderOrder = 1;
    scene.add(behind);
  }
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  try {
    return await renderReference(
      scene,
      camera,
      kind === 'standard' ? { shadowMap: { enabled: true, type: Native.PCFShadowMap } } : {},
    );
  } finally {
    groundGeometry.dispose();
    groundMaterial.dispose();
    geometry.dispose();
    example.material.dispose();
    example.image.dispose();
    replacement?.dispose();
    backdrop?.material.dispose();
    backdrop?.image.dispose();
  }
}
