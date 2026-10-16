import type { EntityHandle, World } from '@forgeax/engine/ecs';
import type { FeatureCheck } from '../../../lab/feature';
import {
  type CameraOptions,
  MESH,
  spawnCamera,
  spawnMesh,
  standard,
  unlit,
} from '../../../lab/stage';

function zRotation(angle: number): readonly [number, number, number, number] {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

/**
 * Thin white bars on black at shallow angles: every antialiasing mode visibly changes
 * the stair-stepped edges, and the bar count keeps the edge pixel share high.
 */
export function spawnAliasingEdges(world: World, camera: CameraOptions['data'] = {}): EntityHandle {
  const white = unlit(world, [1, 1, 1, 1]);
  const red = unlit(world, [1, 0.1, 0.05, 1]);
  for (let i = 0; i < 22; i++) {
    spawnMesh(world, MESH.cube, i % 2 === 0 ? white : red, {
      pos: [0, -2.3 + i * 0.22, 0],
      scale: [9, 0.035, 0.035],
      rotation: zRotation(0.08 + i * 0.012),
    });
  }
  for (let i = 0; i < 10; i++) {
    spawnMesh(world, MESH.cube, white, {
      pos: [-3.5 + i * 0.8, 0, 0.2],
      scale: [0.03, 6, 0.03],
      rotation: zRotation(0.25 + i * 0.02),
    });
  }
  return spawnCamera(world, {
    eye: [0, 0, 6],
    target: [0, 0, 0],
    data: { clearColor: [0, 0, 0, 1], ...camera },
  });
}

/** Pass-name presence checks against the latest committed frame. */
export function passChecks(names: readonly string[], expected: readonly string[]): FeatureCheck[] {
  return expected.map((name) => ({
    name: `pass '${name}' scheduled`,
    ok: names.includes(name),
    detail: `perFramePassNames=${names.join(',')}`,
  }));
}

/** Five orange emissive spheres whose linear radiance doubles left to right (0.5x .. 8x). */
export function spawnHdrRamp(world: World): void {
  for (let i = 0; i < 5; i++) {
    const glow = standard(world, {
      baseColor: [0.05, 0.05, 0.05, 1],
      emissive: [1, 0.45, 0.1],
      emissiveIntensity: 0.5 * 2 ** i,
    });
    spawnMesh(world, MESH.sphere, glow, { pos: [-2.4 + i * 1.2, 0.7, 0], scale: [0.5, 0.5, 0.5] });
  }
}

/** A saturated checkerboard wall filling the view: straight lines make any remap obvious. */
export function spawnCheckerWall(world: World, cells = 12): void {
  const a = unlit(world, [1, 0.8, 0.1, 1]);
  const b = unlit(world, [0.1, 0.25, 0.9, 1]);
  const size = 8 / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells * 2; x++) {
      spawnMesh(world, MESH.quad, (x + y) % 2 === 0 ? a : b, {
        pos: [-8 + size / 2 + x * size, -4 + size / 2 + y * size, 0],
        scale: [size, size, 1],
      });
    }
  }
}
