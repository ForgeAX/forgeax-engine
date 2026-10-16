import type { Component, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { ChildOf } from './components/child-of';
import { Children } from './components/children';
import { Mobility } from './components/mobility';
import { MorphWeights } from './components/morph-weights';
import { Name } from './components/name';
import { GlobalTransform, Transform } from './components/transform';
import { TransformInterpolation } from './presentation';
import { registerMobilityStaticMoved } from './systems/mobility-static-moved';
import { registerPropagateTransforms } from './systems/propagate-transforms';

const SCENE_COMPONENTS: readonly Component[] = [
  ChildOf,
  Children,
  Mobility,
  MorphWeights,
  Name,
  Transform,
  GlobalTransform,
  TransformInterpolation,
];

function registerSceneComponents(world: World): () => void {
  const leases = SCENE_COMPONENTS.map((component) => world.components.register(component).unwrap());
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

export function scenePlugin(): Plugin {
  return {
    name: 'scene',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerSceneComponents(ctx.world), 'scene/components');
      ctx.effect(() => registerPropagateTransforms(ctx.world), 'scene/propagate-transforms');
      ctx.effect(() => registerMobilityStaticMoved(ctx.world), 'scene/mobility-static-moved');
    },
  };
}
