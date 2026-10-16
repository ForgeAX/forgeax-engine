import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const TOUCH_INPUT_STATE = 'bevyTouchInputState';

export interface TouchInputState {
  justPressedTouches: number;
  justReleasedTouches: number;
  canceledTouches: number;
  justPressedActiveTouches: number;
  activeContactFrames: number;
  activeTouchIds: number;
  lastActiveX: number;
  lastActiveY: number;
  lastEventX: number;
  lastEventY: number;
  lastEventId: number;
  activeContactIds: Set<number>;
}

function marker(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number]): void {
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [150, 90, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildTouchInputWorld(world: World): TouchInputState {
  marker(world, [-260, 0, 0], [0.12, 0.45, 1, 1]);
  marker(world, [0, 0, 0], [1, 0.55, 0.12, 1]);
  marker(world, [260, 0, 0], [0.35, 0.9, 0.45, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );
  const state: TouchInputState = {
    justPressedTouches: 0,
    justReleasedTouches: 0,
    canceledTouches: 0,
    justPressedActiveTouches: 0,
    activeContactFrames: 0,
    activeTouchIds: 0,
    lastActiveX: 0,
    lastActiveY: 0,
    lastEventX: 0,
    lastEventY: 0,
    lastEventId: -1,
    activeContactIds: new Set(),
  };
  world.insertResource(TOUCH_INPUT_STATE, state);
  return state;
}

export function stepTouchInput(world: World, snapshot: InputSnapshot): void {
  const state = world.getResource<TouchInputState>(TOUCH_INPUT_STATE);
  for (const event of snapshot.pointerEvents) {
    if (event.pointerType !== 'touch') continue;
    state.lastEventId = event.pointerId;
    state.lastEventX = event.x;
    state.lastEventY = event.y;
    if (event.phase === 'down') {
      state.activeContactIds.add(event.pointerId);
      state.justPressedTouches += 1;
      const contact = snapshot.pointer(event.pointerId);
      if (contact.active) state.justPressedActiveTouches += 1;
    } else if (event.phase === 'up') {
      state.justReleasedTouches += 1;
    } else if (event.phase === 'cancel') {
      state.canceledTouches += 1;
      state.activeContactIds.delete(event.pointerId);
    } else {
      state.activeContactIds.add(event.pointerId);
    }
    if (event.phase === 'up') state.activeContactIds.delete(event.pointerId);
  }

  for (const id of state.activeContactIds) {
    const contact = snapshot.pointer(id);
    if (!contact.active || contact.pointerType !== 'touch') continue;
    state.activeContactFrames += 1;
    state.activeTouchIds = state.activeContactIds.size;
    state.lastActiveX = contact.x;
    state.lastActiveY = contact.y;
  }
  state.activeTouchIds = state.activeContactIds.size;
}

export function readTouchInputState(world: World): TouchInputState {
  return { ...world.getResource<TouchInputState>(TOUCH_INPUT_STATE) };
}
