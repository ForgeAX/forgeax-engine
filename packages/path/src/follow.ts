import { type EntityHandle, FixedTime, FixedUpdate, type World } from '@forgeax/engine-ecs';
import { type Mat4, mat4, quat, vec3 } from '@forgeax/engine-math';
import { Collider, RigidBody } from '@forgeax/engine-physics';
import type { Plugin } from '@forgeax/engine-plugin';
import {
  ChildOf,
  PROPAGATE_TRANSFORMS_FIXED_SYSTEM,
  scenePlugin,
  Transform,
} from '@forgeax/engine-scene';
import { DesiredPathPose, Path, PathFollower, PathMotion } from './components';
import { invalidPath, type PathError } from './errors';
import { createPathSample } from './frame';
import { advancePathDistance, type PreparedPath, preparePath } from './prepared';

export const PATH_FOLLOW_SYSTEM = 'path/follow';
type MatrixEntry = { matrix: Mat4; tick: number; visiting: boolean };
type PathEntry = { prepared: PreparedPath; linear: Mat4; tick: number };

function linearEqual(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 12; i++) if (a[i] !== b[i]) return false;
  return true;
}
function similarity(matrix: Mat4): boolean {
  const x = Math.hypot(matrix[0] as number, matrix[1] as number, matrix[2] as number);
  const y = Math.hypot(matrix[4] as number, matrix[5] as number, matrix[6] as number);
  const z = Math.hypot(matrix[8] as number, matrix[9] as number, matrix[10] as number);
  if (!(x > 0) || Math.abs(x - y) > x * 1e-5 || Math.abs(x - z) > x * 1e-5) return false;
  const dot = (a: number, b: number) =>
    (matrix[a] as number) * (matrix[b] as number) +
    (matrix[a + 1] as number) * (matrix[b + 1] as number) +
    (matrix[a + 2] as number) * (matrix[b + 2] as number);
  const determinant =
    (matrix[0] as number) *
      ((matrix[5] as number) * (matrix[10] as number) -
        (matrix[6] as number) * (matrix[9] as number)) -
    (matrix[4] as number) *
      ((matrix[1] as number) * (matrix[10] as number) -
        (matrix[2] as number) * (matrix[9] as number)) +
    (matrix[8] as number) *
      ((matrix[1] as number) * (matrix[6] as number) -
        (matrix[2] as number) * (matrix[5] as number));
  return (
    determinant > 0 &&
    Math.abs(dot(0, 4)) < x * x * 1e-5 &&
    Math.abs(dot(0, 8)) < x * x * 1e-5 &&
    Math.abs(dot(4, 8)) < x * x * 1e-5
  );
}

/** One native lifetime per World. Derived caches do not own authored state. */
export function pathPlugin(): Plugin {
  return {
    name: 'path',
    inject: ['world'],
    async apply(ctx) {
      await ctx.plugin(scenePlugin());
      ctx.effect(() => {
        const leases = [Path, PathFollower, DesiredPathPose].map((component) =>
          ctx.world.components.register(component).unwrap(),
        );
        return () => {
          for (const lease of leases.reverse()) lease.dispose();
        };
      }, 'path/components');
      ctx.effect(() => installFollower(ctx.world), 'path/follow');
    },
  };
}

function installFollower(world: World): () => void {
  const matrices = new Map<EntityHandle, MatrixEntry>();
  const paths = new Map<EntityHandle, PathEntry>();
  const dirtyQuery = world.query({ read: [Path], changed: [Path] }).unwrap();
  const dirty = new Set<EntityHandle>();
  const sample = createPathSample();
  const local = mat4.create(),
    parentRotation = quat.create(),
    scale = vec3.create();
  let tick = 0;
  // Read current authored TRS, rather than yesterday's GlobalTransform. The
  // depth bound and cycle error also bound malformed hierarchy work.
  function matrixFor(entity: EntityHandle, depth = 0): Mat4 {
    let entry = matrices.get(entity);
    if (!entry) {
      entry = { matrix: mat4.create(), tick: -1, visiting: false };
      matrices.set(entity, entry);
    }
    if (entry.tick === tick) return entry.matrix;
    if (entry.visiting || depth > 128 || world.hasComponent(entity, PathFollower))
      throw invalidPath(
        'path hierarchy',
        'Acyclic depth <=128 with no follower-controlled ancestors',
      );
    entry.visiting = true;
    try {
      const transform = world.get(entity, Transform).unwrap();
      const parent = world.hasComponent(entity, ChildOf)
        ? world.get(entity, ChildOf).unwrap().parent
        : undefined;
      const parentMatrix = parent == null ? undefined : matrixFor(parent, depth + 1);
      mat4.compose(local, transform.pos, transform.quat, transform.scale);
      if (parentMatrix) mat4.multiply(entry.matrix, parentMatrix, local);
      else entry.matrix.set(local);
      entry.tick = tick;
      return entry.matrix;
    } finally {
      entry.visiting = false;
    }
  }
  world
    .addSystem(FixedUpdate, {
      name: PATH_FOLLOW_SYSTEM,
      before: [PROPAGATE_TRANSFORMS_FIXED_SYSTEM],
      queries: [{ read: [Path, Transform] }, { write: [PathFollower, Transform] }],
      fn(world, [pathRows, followers]) {
        tick++;
        dirty.clear();
        for (const row of dirtyQuery) dirty.add(row.entity);
        // Prepare all changed paths before any follower writes. No old-table/new-
        // controls mixture; distance is retained in world units then wrapped/clamped.
        for (const row of pathRows) {
          const matrix = matrixFor(row.entity);
          let entry = paths.get(row.entity);
          if (!entry || dirty.has(row.entity) || !linearEqual(entry.linear, matrix)) {
            const prepared = preparePath(row.get(Path), matrix).unwrap();
            entry = { prepared, linear: mat4.clone(matrix), tick };
            paths.set(row.entity, entry);
          }
          entry.tick = tick;
        }
        const delta = world.getResource(FixedTime).delta;
        for (const span of followers.spans().unwrap()) {
          const columns = span.get(PathFollower);
          let transformWrites: ReturnType<typeof span.mut<typeof Transform>> | undefined;
          let distanceWrites: Float64Array | undefined;
          for (let index = 0; index < span.length; index++) {
            const entity = span.entities[index] as EntityHandle;
            const path = columns.path[index] as EntityHandle;
            const entry = paths.get(path);
            if (!entry || entry.tick !== tick) {
              if (world.hasComponent(entity, DesiredPathPose))
                world.set(entity, DesiredPathPose, { valid: false }).unwrap();
              throw {
                code: 'path-binding-invalid',
                detail: { entity: entity, path: path },
                expected: 'A live Path entity in this World',
                hint: 'Rebind or remove the follower after deleting the path.',
              } satisfies PathError;
            }
            if (
              (columns.motion[index] as number) !== PathMotion.scene &&
              (columns.motion[index] as number) !== PathMotion.desired
            )
              throw invalidPath('motion', 'Declared path motion mode');
            if (
              (columns.motion[index] as number) === PathMotion.scene &&
              (world.hasComponent(entity, RigidBody) || world.hasComponent(entity, Collider))
            )
              throw {
                code: 'path-motion-conflict',
                detail: { entity: entity },
                expected: 'One motion owner',
                hint: 'Use desired motion and let the physics motor consume DesiredPathPose.',
              } satisfies PathError;
            if (
              (columns.motion[index] as number) === PathMotion.desired &&
              !world.hasComponent(entity, DesiredPathPose)
            )
              throw invalidPath(
                'DesiredPathPose',
                'Desired motion entities to carry DesiredPathPose',
              );
            const distance = advancePathDistance(
              columns.distance[index] as number,
              columns.speed[index] as number,
              columns.paused[index] === 1 ? 0 : delta,
              entry.prepared.length,
              columns.loop[index] === 1,
            );
            entry.prepared.sample(
              sample,
              distance,
              (columns.speed[index] as number) < 0 ? -1 : 1,
              columns.forwardAxis[index] as number,
              columns.upAxis[index] as number,
              columns.roll[index] as number,
            );
            const matrix = matrices.get(path)?.matrix;
            if (matrix === undefined) throw invalidPath('path matrix', 'A prepared path instance');
            for (let i = 0; i < 3; i++)
              sample.position[i] = (sample.position[i] as number) + (matrix[12 + i] as number);
            if (
              !Number.isFinite(sample.position[0]) ||
              !Number.isFinite(sample.position[1]) ||
              !Number.isFinite(sample.position[2])
            )
              throw invalidPath('world position', 'Finite Float32 transformed position');
            if ((columns.motion[index] as number) === PathMotion.desired) {
              world
                .set(entity, DesiredPathPose, {
                  position: sample.position,
                  ...(columns.followTangent[index] === 1 ? { rotation: sample.rotation } : {}),
                  valid: true,
                })
                .unwrap();
            } else {
              if (world.hasComponent(entity, ChildOf)) {
                const parentEntity = world.get(entity, ChildOf).unwrap().parent;
                if (parentEntity === null || parentEntity === undefined)
                  throw invalidPath('follower parent', 'Live nonnull parent');
                const parent = matrixFor(parentEntity);
                // Inversion must not silently accept a singular parent.
                const a = parent[0] as number,
                  b = parent[4] as number,
                  c = parent[8] as number;
                const d = parent[1] as number,
                  e = parent[5] as number,
                  f = parent[9] as number;
                const g = parent[2] as number,
                  h = parent[6] as number,
                  i = parent[10] as number;
                const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
                if (!Number.isFinite(determinant) || determinant === 0)
                  throw invalidPath('follower parent', 'Invertible finite parent transform');
                // The general inverse deliberately falls back to identity for
                // small determinants. Affine point conversion must preserve
                // valid small-scale parents and reject Float32 overflow.
                const x = (sample.position[0] as number) - (parent[12] as number);
                const y = (sample.position[1] as number) - (parent[13] as number);
                const z = (sample.position[2] as number) - (parent[14] as number);
                sample.position[0] =
                  ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) / determinant;
                sample.position[1] =
                  ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) / determinant;
                sample.position[2] =
                  ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) / determinant;
                if (
                  !Number.isFinite(sample.position[0]) ||
                  !Number.isFinite(sample.position[1]) ||
                  !Number.isFinite(sample.position[2])
                )
                  throw invalidPath('follower parent', 'Finite Float32 parent-local position');
                if (columns.followTangent[index] === 1) {
                  if (!similarity(parent))
                    throw {
                      code: 'path-parent-frame-unsupported',
                      detail: { entity: entity },
                      expected: 'Positive uniform-scale rigid parent for tangent orientation',
                      hint: 'Use an unscaled orientation parent or disable followTangent; position supports nonuniform parents.',
                    } satisfies PathError;
                  mat4.decompose(sample.local, parentRotation, scale, parent);
                  quat.invert(parentRotation, parentRotation);
                  quat.multiply(sample.rotation, parentRotation, sample.rotation);
                }
              }
              transformWrites ??= span.mut(Transform);
              for (let axis = 0; axis < 3; axis++)
                transformWrites.pos[index * 3 + axis] = sample.position[axis] as number;
              if (columns.followTangent[index] === 1)
                for (let axis = 0; axis < 4; axis++)
                  transformWrites.quat[index * 4 + axis] = sample.rotation[axis] as number;
            }
            if (distance !== (columns.distance[index] as number)) {
              distanceWrites ??= span.mut(PathFollower).distance;
              distanceWrites[index] = distance;
            }
          }
        }
        for (const [entity, entry] of paths) if (entry.tick !== tick) paths.delete(entity);
        for (const [entity, entry] of matrices) if (entry.tick !== tick) matrices.delete(entity);
      },
    })
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, PATH_FOLLOW_SYSTEM).unwrap();
    paths.clear();
    matrices.clear();
    dirty.clear();
  };
}
