// apps/bevy/clear-color — shared World builder + clear-color toggle step
// (SSOT for the app AND the dawn smoke, imported by both via Node TS type-stripping).
//
// Reproduces Bevy's `window/clear_color` example (references/repos/bevy/
// examples/window/clear_color.rs): a blue-ish background, Space to toggle to purple.
// forgeax mapping:
//   - ClearColor resource          -> Camera.clearColor (array<f32,4>)
//   - Space just_pressed           -> closure-tracked rising edge of keyboard.down(' ')
//   - Camera2d                     -> Camera + orthographic()
//
// The clearColor field is read each frame by the record stage from the first
// camera entity's SoA column.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';
import { Camera } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';

/** Bevy CSS srgb(0.5, 0.5, 0.9) = blue-ish. */
const INITIAL_COLOR: [number, number, number, number] = [0.5, 0.5, 0.9, 1.0];
/** Bevy CSS PURPLE = srgb(0.5, 0, 0.5). */
const PURPLE_COLOR: [number, number, number, number] = [0.5, 0.0, 0.5, 1.0];

/**
 * Build the clear-color World: one orthographic camera with a blue-ish clearColor.
 * The scene is empty — the clear color IS the visual output.
 */
export function buildClearColorWorld(world: World): void {
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { ...orthographic({ left: -1, right: 1, bottom: -1, top: 1 }), clearColor: INITIAL_COLOR } },
  );
}

/**
 * On Space rising edge (just_pressed), toggle the camera's clearColor
 * between blue-ish and purple.
 */
let wasSpaceDown = false;

export function stepClearColor(world: World, snapshot: InputSnapshot | null): void {
  if (!snapshot) return;

  const spaceDown = snapshot.keyboard.down(' ');

  const query = world.query({ with: [Camera, Transform] }).unwrap();
  let camHandle: EntityHandle | null = null;
  for (const row of query) {
    camHandle = row.entity;
    break;
  }

  if (camHandle !== null && spaceDown && !wasSpaceDown) {
    const cur = world.get(camHandle, Camera);
    if (cur.ok) {
      const isPurple = (cur.value.clearColor[0] ?? 0) > 0.4 && (cur.value.clearColor[1] ?? 0) < 0.01;
      world.set(camHandle, Camera, {
        clearColor: isPurple ? INITIAL_COLOR : PURPLE_COLOR,
      });
    }
  }

  wasSpaceDown = spaceDown;
}
