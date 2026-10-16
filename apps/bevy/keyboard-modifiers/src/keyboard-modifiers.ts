import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const KEYBOARD_MODIFIERS_STATE = 'bevyKeyboardModifiersState';

export interface KeyboardModifiersState {
  heldShift: boolean;
  heldCtrl: boolean;
  heldA: boolean;
  modifierFrames: number;
  chordPresses: number;
  rejectedPresses: number;
}

function marker(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number]): void {
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [150, 90, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildKeyboardModifiersWorld(world: World): KeyboardModifiersState {
  marker(world, [-260, 0, 0], [0.12, 0.45, 1, 1]);
  marker(world, [0, 0, 0], [1, 0.55, 0.12, 1]);
  marker(world, [260, 0, 0], [0.35, 0.9, 0.45, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );
  const state: KeyboardModifiersState = { heldShift: false, heldCtrl: false, heldA: false, modifierFrames: 0, chordPresses: 0, rejectedPresses: 0 };
  world.insertResource(KEYBOARD_MODIFIERS_STATE, state);
  return state;
}

export function stepKeyboardModifiers(world: World, snapshot: InputSnapshot): void {
  const state = world.getResource<KeyboardModifiersState>(KEYBOARD_MODIFIERS_STATE);
  state.heldShift = snapshot.keyboard.downCode('ShiftLeft') || snapshot.keyboard.downCode('ShiftRight');
  state.heldCtrl = snapshot.keyboard.downCode('ControlLeft') || snapshot.keyboard.downCode('ControlRight');
  state.heldA = snapshot.keyboard.downCode('KeyA');
  if (state.heldShift && state.heldCtrl) state.modifierFrames += 1;
  if (!snapshot.keyboard.justPressedCode('KeyA')) return;
  if (state.heldShift && state.heldCtrl) state.chordPresses += 1;
  else state.rejectedPresses += 1;
}

export function readKeyboardModifiersState(world: World): KeyboardModifiersState {
  return { ...world.getResource<KeyboardModifiersState>(KEYBOARD_MODIFIERS_STATE) };
}
