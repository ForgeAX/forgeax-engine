import {
  defineComponent,
  type EntityHandle,
  FixedUpdate,
  Update,
  type World,
} from '@forgeax/engine-ecs';
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
                const config = row.get(SplineIK),
                  entity = row.entity;
                live.add(entity);
                if (!config.enabled) {
                  const previous = bindings.get(entity);
                  if (previous) retire(entity, previous);
                  bindings.delete(entity);
                  continue;
                }
                if (config.root === null || config.tip === null) {
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
                  (binding.root !== config.root ||
                    binding.tip !== config.tip ||
                    binding.forward !== config.forwardAxis ||
                    binding.up !== config.upAxis)
                ) {
                  retire(entity, binding);
                  bindings.delete(entity);
                  binding = undefined;
                }
                if (!binding) {
                  try {
                    const joints = chain(world, config.root, config.tip);
                    const solver = createSplineIKSolver(world, {
                      joints,
                      forwardAxis: config.forwardAxis,
                      upAxis: config.upAxis,
                    }).unwrap();
                    binding = {
                      solver,
                      root: config.root,
                      tip: config.tip,
                      forward: config.forwardAxis,
                      up: config.upAxis,
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
              dirty.clear();
              for (const row of dirtyPaths) dirty.add(row.entity);
              const used = new Set<EntityHandle>();
              for (const row of rows) {
                const config = row.get(SplineIK),
                  entity = row.entity;
                const binding = bindings.get(entity);
                if (!binding || !config.enabled) continue;
                try {
                  if (config.path === null || !world.hasComponent(config.path, Path))
                    throw new SplineIKError('spline-ik-stale', {
                      reason: 'path removed',
                      ...(config.path === null ? {} : { entity: config.path }),
                    });
                  if (
                    config.lengthMode !== SplineIKLength.preserve &&
                    config.lengthMode !== SplineIKLength.fit
                  )
                    throw new SplineIKError('spline-ik-invalid', {
                      reason: 'undeclared length mode',
                    });
                  // Check every binding, including bindings sharing an already cached Path.
                  {
                    const joints = new Set(binding.solver.joints);
                    let parent: EntityHandle | null = config.path;
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
                  let curve = curves.get(config.path);
                  if (!curve) {
                    const pose = new SkeletonPose(world, [config.path]);
                    const matrix = pose.matrices[
                      pose.indices.get(config.path) as number
                    ] as (typeof pose.matrices)[number];
                    curve = {
                      pose,
                      linear: mat4.clone(matrix),
                      prepared: prepare(config.path, matrix),
                    };
                    curves.set(config.path, curve);
                    dirty.delete(config.path);
                  } else {
                    curve.pose.read();
                    const matrix = curve.pose.matrices[
                      curve.pose.indices.get(config.path) as number
                    ] as (typeof curve.pose.matrices)[number];
                    let changed = dirty.has(config.path);
                    for (let i = 0; i < 12; i++) if (matrix[i] !== curve.linear[i]) changed = true;
                    if (changed) {
                      curve.prepared = prepare(config.path, matrix);
                      curve.linear.set(matrix);
                      dirty.delete(config.path);
                    }
                  }
                  used.add(config.path);
                  const matrix = curve.pose.matrices[
                    curve.pose.indices.get(config.path) as number
                  ] as (typeof curve.pose.matrices)[number];
                  binding.solver
                    .solve(curve.prepared, {
                      origin: matrix.subarray(12, 15),
                      weight: config.weight,
                      offset: config.offset,
                      direction: config.reverse ? -1 : 1,
                      lengthMode:
                        config.lengthMode === SplineIKLength.preserve ? 'preserve' : 'fit',
                      twistStart: config.twistStart,
                      twistEnd: config.twistEnd,
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
