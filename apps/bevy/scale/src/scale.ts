// apps/bevy/scale — shared World builder + bounded per-axis scale step (SSOT for
// the browser app and Dawn smoke).
//
// Reproduces Bevy's `transforms/scale` example: a white cube starts rotated 45°
// about Y, grows along one scale axis, reverses at its maximum, and cycles to the
// next axis after reaching its minimum. ForgeaX mapping:
//   - Scaling { scale_direction, scale_speed, max_element_size, min_element_size }
//     -> game-owned Scaling component
//   - transform.scale += direction * speed * Time.delta_secs()
//     -> world.set(entity, Transform, { scale }) in stepScale
//   - Bevy's max/min branch behavior -> explicit per-element bounds, reversal,
//     and direction.zxy() axis cycle

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

// A compact range makes one full reverse + axis cycle observable within CI's
// 100-frame smoke budget while retaining Bevy's bounded per-axis semantics.
export const SCALE_SPEED = 2;
export const MIN_ELEMENT_SIZE = 1;
export const MAX_ELEMENT_SIZE = 2;

/** Bevy's game-specific bounded scale state. */
export const Scaling = defineComponent('Scaling', {
  scaleDirection: { type: 'array<f32, 3>', default: new Float32Array([1, 0, 0]) },
  scaleSpeed: { type: 'f32', default: SCALE_SPEED },
  maxElementSize: { type: 'f32', default: MAX_ELEMENT_SIZE },
  minElementSize: { type: 'f32', default: MIN_ELEMENT_SIZE },
});

/** Build Bevy's scale scene: rotated cube, directional light, and camera. */
export function buildScaleWorld(world: World): void {
  const cubeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1] }),
  );
  const cubeQuat = quat.eulerY(Math.PI / 4);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [cubeQuat[0] ?? 0, cubeQuat[1] ?? 0, cubeQuat[2] ?? 0, cubeQuat[3] ?? 1],
        scale: [1, 1, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMaterial] } },
    {
      component: Scaling,
      data: {
        scaleDirection: [1, 0, 0],
        scaleSpeed: SCALE_SPEED,
        maxElementSize: MAX_ELEMENT_SIZE,
        minElementSize: MIN_ELEMENT_SIZE,
      },
    },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  const eye: [number, number, number] = [0, 10, 20];
  world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

/** Advance the bounded scale state exactly once for every Scaling entity. */
export function stepScale(world: World, dt: number): void {
  const query = world.query({ with: [Transform, Scaling] }).unwrap();
  const targets: EntityHandle[] = [];
  for (const row of query) targets.push(row.entity);

  for (const handle of targets) {
    const transform = world.get(handle, Transform);
    const scaling = world.get(handle, Scaling);
    if (!transform.ok || !scaling.ok) continue;

    const current = transform.value.scale;
    const sourceDirection = scaling.value.scaleDirection;
    let direction: [number, number, number] = [
      sourceDirection[0] ?? 0,
      sourceDirection[1] ?? 0,
      sourceDirection[2] ?? 0,
    ];
    const max = scaling.value.maxElementSize;
    const min = scaling.value.minElementSize;
    const step = scaling.value.scaleSpeed * dt;
    let next: [number, number, number] = [
      (current[0] ?? min) + direction[0] * step,
      (current[1] ?? min) + direction[1] * step,
      (current[2] ?? min) + direction[2] * step,
    ];

    if (Math.max(...next) >= max) {
      next = next.map((value) => Math.min(max, value)) as [number, number, number];
      direction = [-direction[0], -direction[1], -direction[2]];
    }
    if (Math.min(...next) < min) {
      next = next.map((value) => Math.max(min, value)) as [number, number, number];
      direction = [-direction[0], -direction[1], -direction[2]];
      direction = [direction[2], direction[0], direction[1]];
    }

    world.set(handle, Transform, { scale: next });
    world.set(handle, Scaling, { scaleDirection: direction });
  }
}
