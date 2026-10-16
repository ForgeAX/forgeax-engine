import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Update, World, type EntityHandle } from '@forgeax/engine-ecs';
import {
  snapshotFromSample,
  type InputBackendSample,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { registerStatesPlugin } from '@forgeax/engine-state';
import { describe, expect, it } from 'vitest';
import { GameplayInput, PlayerMotion } from '../assets/plugins/components/gameplay';
import { installGameplayInput } from '../assets/plugins/gameplay-input';

const WIDTH = 1600;
const HEIGHT = 900;

function pointerSnapshot(x: number, y: number): InputSnapshot {
  const sample: InputBackendSample = {
    downKeys: new Set(),
    upKeys: new Set(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
  return snapshotFromSample({
    ...sample,
    capabilities: { gamepad: false, pointer: true },
    mouseX: x,
    mouseY: y,
    pointerEvents: [{ pointerId: 1, phase: 'down', x, y, pressure: 1, pointerType: 'mouse' }],
  });
}

function makeWorld(): {
  world: World;
  player: EntityHandle;
  camera: EntityHandle;
} {
  const world = new World();
  registerStatesPlugin(world);
  const pitch = -Math.atan2(13, 9);
  const cameraRotation = quat.fromAxisAngle(quat.create(), [1, 0, 0], pitch);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 13, 9], quat: cameraRotation } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT }) },
    )
    .unwrap();
  const player = world
    .spawn(
      { component: Transform, data: { pos: [2, 0.75, 1] } },
      { component: GameplayInput, data: {} },
      { component: PlayerMotion, data: {} },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.1, 0], scale: [24, 0.2, 24] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.addSystem(Update, { name: 'input-frame-start-scan', queries: [], fn: () => {} }).unwrap();
  return { world, player, camera };
}

describe('game-default gameplay input integration', () => {
  it('keeps distinct ground clicks distinct after picking the shared ground mesh', () => {
    const { world, player, camera } = makeWorld();
    let snapshot = pointerSnapshot(1100, 225);
    installGameplayInput({
      world,
      player,
      camera,
      canvas: { width: WIDTH, height: HEIGHT } as HTMLCanvasElement,
      hud: { setLockStatus: () => {} } as never,
      readInput: () => snapshot,
      getMode: () => 'topdown',
      getPlayerPosition: () => ({ x: 2, z: 1 }),
    });

    propagateTransforms(world);
    world.update(0).unwrap();
    const first = world.get(player, GameplayInput).unwrap();

    snapshot = pointerSnapshot(700, 650);
    propagateTransforms(world);
    world.update(0).unwrap();
    const second = world.get(player, GameplayInput).unwrap();

    expect(first.shotDirValid).toBe(1);
    expect(second.shotDirValid).toBe(1);
    expect(
      Math.hypot(first.shotDirX - second.shotDirX, first.shotDirZ - second.shotDirZ),
    ).toBeGreaterThan(0.1);
  });
});
