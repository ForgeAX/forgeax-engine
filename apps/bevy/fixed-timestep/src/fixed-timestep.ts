import { defineSystem } from "@forgeax/engine-ecs";
import { FixedTime, FixedUpdate, Time, Update, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { Camera } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

export interface FixedTimestepState {
  updateFrames: number;
  fixedUpdateFrames: number;
  lastFrameDelta: number;
  fixedDelta: number;
  overstep: number;
}

export function buildFixedTimestepWorld(world: World): { getState: () => FixedTimestepState } {
  const state: FixedTimestepState = {
    updateFrames: 0,
    fixedUpdateFrames: 0,
    lastFrameDelta: 0,
    fixedDelta: world.getResource(FixedTime).delta,
    overstep: 0,
  };

  const systemToken1 = defineSystem({
    name: 'frame-update',
    queries: [],
    fn: (_world) => {
      state.updateFrames += 1;
      state.lastFrameDelta = _world.getResource(Time).delta;
    },
  });
world.addSystem(Update, systemToken1);

  const systemToken2 = defineSystem({
    name: 'fixed-update',
    queries: [],
    fn: (world) => {
      state.fixedUpdateFrames += 1;
      state.overstep = world.getResource(FixedTime).overstep;
    },
  });
world.addSystem(FixedUpdate, systemToken2);

  const eye = [-2, 2.5, 5];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  return {
    getState: () => ({
      ...state,
      overstep: world.getResource(FixedTime).overstep,
    }),
  };
}
