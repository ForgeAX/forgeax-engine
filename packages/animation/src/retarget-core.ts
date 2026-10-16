import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, vec3 } from '@forgeax/engine-math';
import { ChildOf } from '@forgeax/engine-scene';
import { SkeletonPose } from './skeleton-pose';
import { AnimationBindingError } from './solver-errors';

export interface SkeletonRetargetOptions {
  readonly pairs: readonly { readonly source: EntityHandle; readonly target: EntityHandle }[];
  readonly rootTranslationScale?: number;
}

/** The same model-space transfer kernel serves live World poses and offline samples. */
export function compileRetarget(world: World, options: SkeletonRetargetOptions) {
  const pairs = [...options.pairs];
  if (
    pairs.length === 0 ||
    pairs.length > 256 ||
    new Set(pairs.map((pair) => pair.target)).size !== pairs.length ||
    pairs.some((pair) => pairs.some((other) => pair.target === other.source))
  )
    throw new AnimationBindingError('animation-skeleton-invalid', {
      reason: 'requires 1..256 unique target joints disjoint from source',
    });
  const rootScale = options.rootTranslationScale;
  if (rootScale !== undefined && (!Number.isFinite(rootScale) || rootScale < 0))
    throw new AnimationBindingError('animation-solver-options-invalid', { rootScale });
  const parentOf = (entity: EntityHandle) => {
    const parent = world.get(entity, ChildOf);
    return parent.ok ? parent.value.parent : null;
  };
  const source = new SkeletonPose(
    world,
    pairs.map((pair) => pair.source),
    parentOf(pairs[0]?.source as EntityHandle),
  );
  const target = new SkeletonPose(
    world,
    pairs.map((pair) => pair.target),
    parentOf(pairs[0]?.target as EntityHandle),
  );
  if (
    source.parents.filter((parent) => parent === -1).length !== 1 ||
    target.parents.filter((parent) => parent === -1).length !== 1 ||
    source.entities[0] !== pairs[0]?.source ||
    target.entities[0] !== pairs[0]?.target
  )
    throw new AnimationBindingError('animation-skeleton-invalid', {
      reason: 'first pair must name both skeleton roots',
    });
  if (target.entities.some((entity) => source.indices.has(entity)))
    throw new AnimationBindingError('animation-skeleton-invalid', {
      reason: 'source and target poses overlap through their hierarchy',
    });
  const mapped = pairs.map((pair) => ({
    source: source.indices.get(pair.source) as number,
    target: target.indices.get(pair.target) as number,
  }));
  const targetIndices = mapped.map((pair) => pair.target).sort((a, b) => a - b);
  const sourceByTarget = new Map(mapped.map((pair) => [pair.target, pair.source]));
  const sourceRestInverse = source.globalRotations.map((rotation) =>
    quat.invert(quat.create(), rotation),
  );
  const targetRest = target.globalRotations.map((rotation) => quat.clone(rotation));
  const targetRestPosition = target.positions.map((position) => vec3.clone(position));
  const sourceRootRest = vec3.clone(
    source.positions[mapped[0]?.source as number] as (typeof source.positions)[number],
  );
  const delta = quat.create();
  const desired = quat.create();
  const inverse = quat.create();
  return {
    source,
    target,
    targetIndices,
    transfer(weight: number) {
      for (let i = 0; i < target.entities.length; i++) {
        const sourceIndex = sourceByTarget.get(i);
        if (sourceIndex !== undefined) {
          quat.multiply(
            delta,
            source.globalRotations[sourceIndex] as (typeof source.globalRotations)[number],
            sourceRestInverse[sourceIndex] as (typeof sourceRestInverse)[number],
          );
          quat.multiply(desired, delta, targetRest[i] as (typeof targetRest)[number]);
          const parent = target.parents[i] as number;
          if (parent >= 0) {
            quat.invert(
              inverse,
              target.globalRotations[parent] as (typeof target.globalRotations)[number],
            );
            quat.multiply(desired, inverse, desired);
          }
          const rotation = target.rotations[i] as (typeof target.rotations)[number];
          if (weight === 1) quat.normalize(rotation, desired);
          else quat.slerp(rotation, rotation, desired, weight);
        }
        target.update(i, i + 1);
      }
      const root = mapped[0];
      if (root !== undefined && rootScale !== undefined) {
        const position = target.positions[root.target] as (typeof target.positions)[number];
        const current = source.positions[root.source] as (typeof source.positions)[number];
        const rest = targetRestPosition[root.target] as (typeof targetRestPosition)[number];
        for (let i = 0; i < 3; i++)
          position[i] =
            (position[i] as number) +
            weight *
              ((rest[i] as number) +
                rootScale * ((current[i] as number) - (sourceRootRest[i] as number)) -
                (position[i] as number));
      }
    },
  };
}
