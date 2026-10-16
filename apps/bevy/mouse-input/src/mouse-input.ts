import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const MOUSE_INPUT_STATE = 'bevyMouseInputState';

export interface MouseInputState {
  heldPrimary: boolean;
  justPressedPrimary: number;
  justReleasedPrimary: number;
  movementX: number;
  movementY: number;
  movementFrames: number;
  wheelPositive: number;
  wheelNegative: number;
}

function marker(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number]): void {
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [150, 90, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildMouseInputWorld(world: World): MouseInputState {
  marker(world, [-260, 0, 0], [0.12, 0.45, 1, 1]);
  marker(world, [0, 0, 0], [1, 0.55, 0.12, 1]);
  marker(world, [260, 0, 0], [0.35, 0.9, 0.45, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );
  const state: MouseInputState = {
    heldPrimary: false,
    justPressedPrimary: 0,
    justReleasedPrimary: 0,
    movementX: 0,
    movementY: 0,
    movementFrames: 0,
    wheelPositive: 0,
    wheelNegative: 0,
  };
  world.insertResource(MOUSE_INPUT_STATE, state);
  return state;
}

export function stepMouseInput(world: World, snapshot: InputSnapshot): void {
  const state = world.getResource<MouseInputState>(MOUSE_INPUT_STATE);
  state.heldPrimary = snapshot.mouse.button(0);
  if (snapshot.mouse.justPressed(0)) state.justPressedPrimary += 1;
  if (snapshot.mouse.justReleased(0)) state.justReleasedPrimary += 1;
  state.movementX += snapshot.mouse.movementDelta.x;
  state.movementY += snapshot.mouse.movementDelta.y;
  if (snapshot.mouse.movementDelta.x !== 0 || snapshot.mouse.movementDelta.y !== 0) state.movementFrames += 1;
  if (snapshot.mouse.wheelDelta > 0) state.wheelPositive += snapshot.mouse.wheelDelta;
  if (snapshot.mouse.wheelDelta < 0) state.wheelNegative += snapshot.mouse.wheelDelta;
}

export function readMouseInputState(world: World): MouseInputState {
  return { ...world.getResource<MouseInputState>(MOUSE_INPUT_STATE) };
}
