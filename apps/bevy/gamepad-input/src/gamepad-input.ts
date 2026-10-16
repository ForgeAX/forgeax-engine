import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const GAMEPAD_INPUT_STATE = 'bevyGamepadInputState';

export interface GamepadInputState {
  connectedFrames: number;
  standardMapping: boolean;
  heldSouth: boolean;
  justPressedSouth: number;
  justReleasedSouth: number;
  maxRightTrigger2: number;
  minLeftStickX: number;
  maxLeftStickX: number;
  leftStickFrames: number;
}

function marker(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number], scale: readonly [number, number, number]): void {
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildGamepadInputWorld(world: World): GamepadInputState {
  marker(world, [-360, 0, 0], [0.12, 0.45, 1, 1], [130, 90, 1]);
  marker(world, [0, 0, 0], [1, 0.55, 0.12, 1], [130, 90, 1]);
  marker(world, [360, 0, 0], [0.35, 0.9, 0.45, 1], [130, 90, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );
  const state: GamepadInputState = {
    connectedFrames: 0,
    standardMapping: false,
    heldSouth: false,
    justPressedSouth: 0,
    justReleasedSouth: 0,
    maxRightTrigger2: 0,
    minLeftStickX: 0,
    maxLeftStickX: 0,
    leftStickFrames: 0,
  };
  world.insertResource(GAMEPAD_INPUT_STATE, state);
  return state;
}

export function stepGamepadInput(world: World, snapshot: InputSnapshot): void {
  const state = world.getResource<GamepadInputState>(GAMEPAD_INPUT_STATE);
  const pad = snapshot.gamepad(0);
  state.standardMapping = pad.standardMapping;
  if (!pad.connected) {
    state.heldSouth = false;
    return;
  }
  state.connectedFrames += 1;
  state.heldSouth = pad.button(0);
  if (pad.justPressed(0)) state.justPressedSouth += 1;
  if (pad.justReleased(0)) state.justReleasedSouth += 1;
  state.maxRightTrigger2 = Math.max(state.maxRightTrigger2, pad.buttonValue(7));
  const leftStickX = pad.axis(0);
  if (Math.abs(leftStickX) > 0.01) {
    state.leftStickFrames += 1;
    state.minLeftStickX = Math.min(state.minLeftStickX, leftStickX);
    state.maxLeftStickX = Math.max(state.maxLeftStickX, leftStickX);
  }
}

export function readGamepadInputState(world: World): GamepadInputState {
  return { ...world.getResource<GamepadInputState>(GAMEPAD_INPUT_STATE) };
}
