import {
  defineComponent,
  ENTITY_NULL_RAW,
  type EntityHandle,
  FixedUpdate,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import { Path, PathAxis, type PreparedPath, preparePath } from '@forgeax/engine-path';
import type { Plugin } from '@forgeax/engine-plugin';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { CAPTURE_SKELETAL_MOTION_BASE } from './skeletal-motion';
import { SkeletonPose } from './skeleton-pose';
import { SplineIKError } from './spline-ik-errors';
import { createSplineIKSolver, type SplineIKSolver } from './spline-ik-solver';

export const SplineIKLength = { preserve: 0, fit: 1 } as const;

/** Ordinary SceneAsset entity references, resolved per instance by the Scene owner. */
export const SplineIK = defineComponent('SplineIK', {
  path: 'entity',
  root: 'entity',
  tip: 'entity',
  forwardAxis: { type: 'enum', default: PathAxis.positiveZ, labels: PathAxis },
  upAxis: { type: 'enum', default: PathAxis.positiveY, labels: PathAxis },
  lengthMode: { type: 'enum', default: SplineIKLength.preserve, labels: SplineIKLength },
  offset: { type: 'f64', default: 0 },
  reverse: { type: 'bool', default: false },
  weight: { type: 'f64', default: 1 },
  twistStart: { type: 'f64', default: 0 },
  twistEnd: { type: 'f64', default: 0 },
  enabled: { type: 'bool', default: true },
});

type Binding = {
  solver: SplineIKSolver;
  root: EntityHandle;
  tip: EntityHandle;
  forward: number;
  up: number;
};
type Curve = { pose: SkeletonPose; linear: Mat4; prepared: PreparedPath };

function chain(world: World, root: EntityHandle, tip: EntityHandle): EntityHandle[] {
  const joints: EntityHandle[] = [];
  let current: EntityHandle | null = tip;
  while (current !== null) {
    if (joints.includes(current) || joints.length >= 256)
      throw new SplineIKError('spline-ik-invalid', { reason: 'cyclic or >256 joint chain' });
    joints.push(current);
    if (current === root) return joints.reverse();
    if (!world.hasComponent(current, ChildOf)) break;
    current = world.get(current, ChildOf).unwrap().parent;
  }
  throw new SplineIKError('spline-ik-invalid', {
    reason: 'tip is not a descendant of explicit root',
  });
}

/** Install beside Scene and the ordinary Animation plugin in the same World.
 * Restore -> animated base -> spline commit -> Scene. One shared table per Path.
 */
export function splineIKPlugin(
  options: { readonly onError?: (controller: EntityHandle, failure: SplineIKError) => void } = {},
): Plugin {
  return {
    name: 'spline-ik',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        const world = ctx.world;
        // Animation owns cadence. Consume the installed schedule instead of another clock/option.
        const playback = world
          .scheduleData()
          .filter((scope) =>
            scope.systems.some((system) => system.name === 'advanceAnimationPlayer'),
          );
        if (playback.length !== 1 || !['Update', 'FixedUpdate'].includes(playback[0]?.name ?? ''))
          throw new SplineIKError('spline-ik-invalid', {
            reason: 'install exactly one animation playback cadence before Spline IK',
          });
        const schedule = playback[0]?.name === 'FixedUpdate' ? FixedUpdate : Update;

        const leases = [Path, SplineIK].map((c) => world.components.register(c).unwrap());
        const bindings = new Map<EntityHandle, Binding>();
        const curves = new Map<EntityHandle, Curve>();
        const rows = world.query({ read: [SplineIK] }).unwrap();
        const dirtyPaths = world.query({ read: [Path], changed: [Path] }).unwrap();
        const dirty = new Set<EntityHandle>();
        function refreshDirtyPaths(): void {
          dirty.clear();
          for (const querySpan of dirtyPaths.spans().unwrap()) {
            const queryEntities = querySpan.entities;
            for (let queryIndex = 0; queryIndex < querySpan.length; queryIndex++) {
              const queriedEntity = queryEntities[queryIndex] as EntityHandle;
              dirty.add(queriedEntity);
            }
          }
        }

        const report = (entity: EntityHandle, cause: unknown) => {
          const failure =
            cause instanceof SplineIKError
              ? cause
              : new SplineIKError('spline-ik-stale', {
                  entity,
                  reason: cause instanceof Error ? cause.message : String(cause),
                });
          if (options.onError) options.onError(entity, failure);
          else throw failure;
        };
        const restore = (entity: EntityHandle, binding: Binding) => {
          const result = binding.solver.restoreBase();
          if (!result.ok) report(entity, result.error);
        };
        const retire = (entity: EntityHandle, binding: Binding) => {
          // Native Scene cleanup may precede this child contribution's detach.
          // A surviving complete chain still receives its base; never write stale handles.
          if (binding.solver.joints.every((joint) => world.hasComponent(joint, Transform)))
            restore(entity, binding);
        };
        const prepare = (entity: EntityHandle, matrix: Mat4) => {
          const result = preparePath(world.get(entity, Path).unwrap(), matrix);
          if (!result.ok)
            throw new SplineIKError('spline-ik-invalid', {
              entity,
              reason: `${result.error.code} ${JSON.stringify(result.error.detail)}: ${result.error.expected}`,
            });
          return result.value;
        };
        const restoreName = 'animation/restore-spline-base';
        const solveName = 'animation/solve-spline-ik';
        world
          .addSystem(schedule, {
            name: restoreName,
            before: ['evaluateAnimationGraph', 'advanceAnimationPlayer'],
            queries: [],
            fn() {
              const live = new Set<EntityHandle>();
              const writers = new Set<EntityHandle>();
              for (const row of rows) {
                const entity = row.entity;
                const read = world[worldRead];
                const configEnabled = read.getFieldValue(entity, SplineIK, 'enabled') === 1;
                const configRoot = read.getFieldValue(entity, SplineIK, 'root') as EntityHandle;
                const configTip = read.getFieldValue(entity, SplineIK, 'tip') as EntityHandle;
                const configForwardAxis = read.getFieldValue(
                  entity,
                  SplineIK,
                  'forwardAxis',
                ) as number;
                const configUpAxis = read.getFieldValue(entity, SplineIK, 'upAxis') as number;
                live.add(entity);
                if (!configEnabled) {
                  const previous = bindings.get(entity);
                  if (previous) retire(entity, previous);
                  bindings.delete(entity);
                  continue;
                }
                if (configRoot === ENTITY_NULL_RAW || configTip === ENTITY_NULL_RAW) {
                  const previous = bindings.get(entity);
                  if (previous) retire(entity, previous);
                  bindings.delete(entity);
                  report(
                    entity,
                    new SplineIKError('spline-ik-invalid', {
                      reason: 'explicit root and tip required',
                    }),
                  );
                  continue;
                }
                let binding = bindings.get(entity);
                if (
                  binding &&
                  (binding.root !== configRoot ||
                    binding.tip !== configTip ||
                    binding.forward !== configForwardAxis ||
                    binding.up !== configUpAxis)
                ) {
                  retire(entity, binding);
                  bindings.delete(entity);
                  binding = undefined;
                }
                if (!binding) {
                  try {
                    const joints = chain(world, configRoot, configTip);
                    const solver = createSplineIKSolver(world, {
                      joints,
                      forwardAxis: configForwardAxis,
                      upAxis: configUpAxis,
                    }).unwrap();
                    binding = {
                      solver,
                      root: configRoot,
                      tip: configTip,
                      forward: configForwardAxis,
                      up: configUpAxis,
                    };
                    bindings.set(entity, binding);
                  } catch (cause) {
                    report(entity, cause);
                    continue;
                  }
                }
                for (const joint of binding.solver.joints) {
                  if (writers.has(joint))
                    throw new SplineIKError('spline-ik-conflict', {
                      reason: 'overlapping spline chains',
                      joint,
                    });
                  writers.add(joint);
                }
              }
              for (const [entity, binding] of bindings) {
                if (live.has(entity)) restore(entity, binding);
                else {
                  retire(entity, binding);
                  bindings.delete(entity);
                }
              }
            },
          })
          .unwrap();
        world
          .addSystem(schedule, {
            name: solveName,
            after: ['advanceAnimationPlayer'],
            before:
              schedule === FixedUpdate
                ? [CAPTURE_SKELETAL_MOTION_BASE, 'propagateTransformsFixed']
                : ['propagateTransforms'],
            queries: [],
            fn() {
              refreshDirtyPaths();
              const used = new Set<EntityHandle>();
              for (const row of rows) {
                const entity = row.entity;
                const read = world[worldRead];
                const configEnabled = read.getFieldValue(entity, SplineIK, 'enabled') === 1;
                const configPath = read.getFieldValue(entity, SplineIK, 'path') as EntityHandle;
                const configLengthMode = read.getFieldValue(
                  entity,
                  SplineIK,
                  'lengthMode',
                ) as number;
                const configWeight = read.getFieldValue(entity, SplineIK, 'weight') as number;
                const configOffset = read.getFieldValue(entity, SplineIK, 'offset') as number;
                const configReverse = read.getFieldValue(entity, SplineIK, 'reverse') === 1;
                const configTwistStart = read.getFieldValue(
                  entity,
                  SplineIK,
                  'twistStart',
                ) as number;
                const configTwistEnd = read.getFieldValue(entity, SplineIK, 'twistEnd') as number;
                const binding = bindings.get(entity);
                if (!binding || !configEnabled) continue;
                try {
                  if (configPath === ENTITY_NULL_RAW || !world.hasComponent(configPath, Path))
                    throw new SplineIKError('spline-ik-stale', {
                      reason: 'path removed',
                      ...(configPath === ENTITY_NULL_RAW ? {} : { entity: configPath }),
                    });
                  if (
                    configLengthMode !== SplineIKLength.preserve &&
                    configLengthMode !== SplineIKLength.fit
                  )
                    throw new SplineIKError('spline-ik-invalid', {
                      reason: 'undeclared length mode',
                    });
                  // Check every binding, including bindings sharing an already cached Path.
                  {
                    const joints = new Set(binding.solver.joints);
                    let parent: EntityHandle | null = configPath;
                    const seen = new Set<EntityHandle>();
                    while (parent !== null) {
                      if (joints.has(parent) || seen.has(parent) || seen.size > 128)
                        throw new SplineIKError('spline-ik-conflict', {
                          reason: 'curve hierarchy depends on controlled chain or is invalid',
                        });
                      seen.add(parent);
                      if (!world.hasComponent(parent, ChildOf)) break;
                      parent = world.get(parent, ChildOf).unwrap().parent;
                    }
                  }
                  let curve = curves.get(configPath);
                  if (!curve) {
                    const pose = new SkeletonPose(world, [configPath]);
                    const matrix = pose.matrices[
                      pose.indices.get(configPath) as number
                    ] as (typeof pose.matrices)[number];
                    curve = {
                      pose,
                      linear: mat4.clone(matrix),
                      prepared: prepare(configPath, matrix),
                    };
                    curves.set(configPath, curve);
                    dirty.delete(configPath);
                  } else {
                    curve.pose.read();
                    const matrix = curve.pose.matrices[
                      curve.pose.indices.get(configPath) as number
                    ] as (typeof curve.pose.matrices)[number];
                    let changed = dirty.has(configPath);
                    for (let i = 0; i < 12; i++) if (matrix[i] !== curve.linear[i]) changed = true;
                    if (changed) {
                      curve.prepared = prepare(configPath, matrix);
                      curve.linear.set(matrix);
                      dirty.delete(configPath);
                    }
                  }
                  used.add(configPath);
                  const matrix = curve.pose.matrices[
                    curve.pose.indices.get(configPath) as number
                  ] as (typeof curve.pose.matrices)[number];
                  binding.solver
                    .solve(curve.prepared, {
                      origin: matrix.subarray(12, 15),
                      weight: configWeight,
                      offset: configOffset,
                      direction: configReverse ? -1 : 1,
                      lengthMode: configLengthMode === SplineIKLength.preserve ? 'preserve' : 'fit',
                      twistStart: configTwistStart,
                      twistEnd: configTwistEnd,
                    })
                    .unwrap();
                } catch (cause) {
                  report(entity, cause);
                }
              }
              for (const path of curves.keys()) if (!used.has(path)) curves.delete(path);
            },
          })
          .unwrap();
        return () => {
          world.removeSystem(schedule, solveName).unwrap();
          world.removeSystem(schedule, restoreName).unwrap();
          try {
            for (const [entity, binding] of bindings) retire(entity, binding);
          } finally {
            bindings.clear();
            curves.clear();
            for (const lease of leases.reverse()) lease.dispose();
          }
        };
      }, 'spline-ik/world');
    },
  };
}
