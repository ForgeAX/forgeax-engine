import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const KEYBOARD_INPUT_STATE = 'bevyKeyboardInputState';

export interface KeyboardInputState {
  heldCodeA: boolean;
  justPressedCodeA: number;
  releasedCodeA: number;
  heldQuestion: boolean;
  justPressedQuestion: number;
  releasedQuestion: number;
}

function marker(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number]): void {
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [150, 90, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildKeyboardInputWorld(world: World): KeyboardInputState {
  marker(world, [-260, 0, 0], [0.12, 0.45, 1, 1]);
  marker(world, [0, 0, 0], [1, 0.55, 0.12, 1]);
  marker(world, [260, 0, 0], [0.35, 0.9, 0.45, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );
  const state: KeyboardInputState = {
    heldCodeA: false,
    justPressedCodeA: 0,
    releasedCodeA: 0,
    heldQuestion: false,
    justPressedQuestion: 0,
    releasedQuestion: 0,
  };
  world.insertResource(KEYBOARD_INPUT_STATE, state);
  return state;
}

export function stepKeyboardInput(world: World, snapshot: InputSnapshot): void {
  const state = world.getResource<KeyboardInputState>(KEYBOARD_INPUT_STATE);
  state.heldCodeA = snapshot.keyboard.downCode('KeyA');
  state.heldQuestion = snapshot.keyboard.down('?');
  if (snapshot.keyboard.justPressedCode('KeyA')) state.justPressedCodeA += 1;
  if (snapshot.keyboard.upCode('KeyA')) state.releasedCodeA += 1;
  if (snapshot.keyboard.justPressed('?')) state.justPressedQuestion += 1;
  if (snapshot.keyboard.up('?')) state.releasedQuestion += 1;
}

export function readKeyboardInputState(world: World): KeyboardInputState {
  const state = world.getResource<KeyboardInputState>(KEYBOARD_INPUT_STATE);
  return { ...state };
}
