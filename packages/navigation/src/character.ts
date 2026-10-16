import {
  defineComponent,
  defineSystem,
  type EcsError,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  type World,
} from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  physicsComponentsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import type { Plugin } from '@forgeax/engine-plugin';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { err, type Result } from '@forgeax/engine-types';
import { NavigationAgent, NavigationAgentStatus, navigationPlugin } from './agent';
import { type AvoidanceAgent, type AvoidanceOptions, solveNavigationAvoidance } from './avoidance';
import { invalidInput, type NavigationError } from './errors';
import type { NavigationMesh, NavigationPoint } from './navmesh';

export const NavigationCharacter = defineComponent(
  'NavigationCharacter',
  {
    sourceDigest: { type: 'string', default: '' },
    arrivalDistance: { type: 'f32', default: 0.08 },
    stuckSeconds: { type: 'f32', default: 3 },
    stalledFor: { type: 'f32', default: 0, transient: true },
    bestDistance: { type: 'f32', default: 1e20, transient: true },
    recoveryAttempts: { type: 'u8', default: 0, transient: true },
    verticalSpeed: { type: 'f32', default: 0, transient: true },
    desired: { type: 'array<f32, 3>', default: new Float32Array(3), transient: true },
    actual: { type: 'array<f32, 3>', default: new Float32Array(3), transient: true },
  },
  { requires: [NavigationAgent, RigidBody, Collider, CharacterController] },
);
const SURFACE = 'NavigationMesh';
export const NAVIGATION_CHARACTER_SYSTEM = 'navigation/character';
/** Replace one World's active surface. Existing routes fail closed on the next fixed step. */
export function setNavigationMesh(world: World, mesh: NavigationMesh): void {
  world.insertResource(SURFACE, mesh);
}
/** Synchronous query/assignment: no late callback can revive an old entity or route. */
export function setNavigationTarget(
  world: World,
  entity: EntityHandle,
  target: NavigationPoint,
  options: { readonly maxProjection: number; readonly maxVisited?: number },
): Result<void, NavigationError | EcsError> {
  const character = world.get(entity, NavigationCharacter);
  if (!character.ok) return character;
  if (!world.hasResource(SURFACE))
    return err(
      invalidInput(
        'NavigationMesh',
        undefined,
        'Install navigationCharacterPlugin or setNavigationMesh',
      ),
    );
  const propagated = propagateTransforms(world);
  if (!propagated.ok)
    return err(invalidInput('Transform', propagated.error, 'Valid propagated Scene transforms'));
  const matrix = world.get(entity, GlobalTransform);
  if (!matrix.ok) return matrix;
  const m = matrix.value.world,
    collider = world.get(entity, Collider).unwrap();
  const height =
    2 *
    (collider.radius *
      Math.max(
        Math.hypot(m[0] as number, m[1] as number, m[2] as number),
        Math.hypot(m[8] as number, m[9] as number, m[10] as number),
      ) +
      collider.halfHeight * Math.hypot(m[4] as number, m[5] as number, m[6] as number));
  const mesh = world.getResource<NavigationMesh>(SURFACE);
  const path = mesh.findPath(
    [m[12] as number, (m[13] as number) - height / 2, m[14] as number],
    target,
    options,
  );
  if (!path.ok) return path;
  // Assignment validates the entity before either write; both operations are synchronous.
  world
    .set(entity, NavigationCharacter, {
      sourceDigest: mesh.sourceDigest,
      stalledFor: 0,
      bestDistance: 1e20,
      recoveryAttempts: 0,
      verticalSpeed: 0,
      desired: [0, 0, 0],
      actual: [0, 0, 0],
    })
    .unwrap();
  return world.set(entity, NavigationAgent, {
    path: path.value.points,
    waypoint: 0,
    status: NavigationAgentStatus.following,
  });
}
function canTraverse(
  surface: NavigationMesh,
  start: NavigationPoint,
  end: NavigationPoint,
  clearance: number,
  maxSteps: number,
): boolean {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(end[0] - start[0], end[2] - start[2]) / (surface.settings.cellSize / 2)),
  );
  if (steps > maxSteps) return false;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps,
      candidate: NavigationPoint = [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
        start[2] + (end[2] - start[2]) * t,
      ];
    if (!surface.ground(candidate, clearance, 512).ok) {
      const near = surface.project(candidate, clearance, 512);
      if (
        !near.ok ||
        Math.hypot(near.value.point[0] - candidate[0], near.value.point[2] - candidate[2]) > 0.001
      )
        return false;
    }
  }
  return true;
}
const DEFAULT_AVOIDANCE: AvoidanceOptions = {
  neighborDistance: 4,
  maxNeighbors: 16,
  horizon: 1.5,
  maxCandidates: 128,
};
/** Physics owns position; this companion owns only bounded steering and displacement feedback. */
export function navigationCharacterPlugin(
  mesh: NavigationMesh,
  options: AvoidanceOptions = DEFAULT_AVOIDANCE,
): Plugin {
  return {
    name: 'navigation-character',
    inject: ['world'],
    async apply(ctx) {
      await ctx.plugin(navigationPlugin());
      await ctx.plugin(physicsComponentsPlugin());
      const world = ctx.world;
      ctx.effect(() => {
        const lease = world.components.register(NavigationCharacter).unwrap();
        return () => lease.dispose();
      }, 'navigation/character-components');
      ctx.effect(() => {
        setNavigationMesh(world, mesh);
        return () => world.removeResource(SURFACE);
      }, 'navigation/mesh');
      const system = defineSystem({
        name: NAVIGATION_CHARACTER_SYSTEM,
        after: ['physicsSyncBackend'],
        before: ['physicsStepSimulation'],
        queries: [
          {
            read: [GlobalTransform, Collider, RigidBody, CharacterController],
            write: [NavigationAgent, NavigationCharacter, Transform],
          },
        ],
        fn(world, [query]) {
          if (!world.hasResource('PhysicsWorld') || !world.hasResource(SURFACE)) return;
          const physics = world.getResource<PhysicsWorld>('PhysicsWorld'),
            surface = world.getResource<NavigationMesh>(SURFACE),
            dt = world.getResource(FixedTime).delta,
            gravityY = physics.getGravity()[1] as number;
          const agents: AvoidanceAgent[] = [];
          const rows = new Map<
            number,
            {
              entity: EntityHandle;
              x: number;
              y: number;
              z: number;
              height: number;
              waypoint: number;
              grounded: boolean;
              clearance: number;
            }
          >();
          for (const row of query) {
            const entity = row.entity,
              agent = world.get(entity, NavigationAgent).unwrap(),
              character = world.get(entity, NavigationCharacter).unwrap();
            if (!physics.hasBody(entity)) continue;
            const m = world.get(entity, GlobalTransform).unwrap().world,
              c = world.get(entity, Collider).unwrap(),
              body = world.get(entity, RigidBody).unwrap(),
              cc = world.get(entity, CharacterController).unwrap();
            const sx = Math.hypot(m[0] as number, m[1] as number, m[2] as number),
              sy = Math.hypot(m[4] as number, m[5] as number, m[6] as number),
              sz = Math.hypot(m[8] as number, m[9] as number, m[10] as number);
            const radius = c.radius * Math.max(sx, sz),
              height = 2 * (radius + c.halfHeight * sy);
            // Ground agents accept yaw and nonuniform scale; tilted/sheared/singular poses are explicit failures.
            if (
              c.shape !== ColliderShapeValue.capsule ||
              body.type !== RigidBodyTypeValue.kinematic ||
              c.isSensor ||
              ![
                radius,
                height,
                agent.speed,
                character.arrivalDistance,
                character.stuckSeconds,
              ].every(Number.isFinite) ||
              radius <= 0 ||
              height <= 0 ||
              agent.speed < 0 ||
              agent.speed > 100 ||
              character.arrivalDistance <= 0 ||
              character.stuckSeconds <= 0 ||
              Math.abs(m[1] as number) > 1e-5 ||
              Math.abs(m[4] as number) > 1e-5 ||
              Math.abs(m[6] as number) > 1e-5 ||
              Math.abs(m[9] as number) > 1e-5 ||
              sy <= 0 ||
              Math.abs((m[0] as number) * (m[8] as number) + (m[2] as number) * (m[10] as number)) >
                1e-5 * sx * sz ||
              radius + cc.offset + 0.001 > surface.settings.radius + 1e-5 ||
              height > surface.settings.height + 1e-5 ||
              cc.maxSlopeClimbDeg + 1e-5 < surface.settings.maxSlopeDeg ||
              cc.autoStepMaxHeight + 1e-5 < surface.settings.maxStep
            )
              throw invalidInput(
                'NavigationCharacter',
                { entity, radius, height },
                'Upright kinematic nonsensor capsule within baked clearance and KCC slope/step capability',
              );
            let live = agent;
            if (character.sourceDigest && character.sourceDigest !== surface.sourceDigest) {
              world
                .set(entity, NavigationAgent, {
                  path: new Float32Array(0),
                  waypoint: 0,
                  status: NavigationAgentStatus.idle,
                })
                .unwrap();
              world
                .set(entity, NavigationCharacter, {
                  sourceDigest: '',
                  desired: [0, 0, 0],
                  actual: [0, 0, 0],
                  verticalSpeed: 0,
                })
                .unwrap();
              live = world.get(entity, NavigationAgent).unwrap();
            }
            const x = m[12] as number,
              y = m[13] as number,
              z = m[14] as number;
            let waypoint = live.waypoint,
              dx = 0,
              dz = 0,
              distance = 0,
              moving = live.status === NavigationAgentStatus.following;
            if (moving) {
              const path = live.path;
              if (
                !character.sourceDigest ||
                path.length < 3 ||
                path.length % 3 !== 0 ||
                waypoint >= path.length / 3 ||
                !Array.from(path).every(Number.isFinite)
              )
                throw invalidInput(
                  'physical path',
                  { entity, waypoint },
                  'Use setNavigationTarget for a current world-space path',
                );
              while (waypoint < path.length / 3) {
                dx = (path[waypoint * 3] as number) - x;
                dz = (path[waypoint * 3 + 2] as number) - z;
                distance = Math.hypot(dx, dz);
                const vertical = Math.abs((path[waypoint * 3 + 1] as number) - (y - height / 2));
                if (waypoint + 1 < path.length / 3) {
                  const next: NavigationPoint = [
                    path[(waypoint + 1) * 3] as number,
                    path[(waypoint + 1) * 3 + 1] as number,
                    path[(waypoint + 1) * 3 + 2] as number,
                  ];
                  const past =
                    (x - (path[waypoint * 3] as number)) *
                      (next[0] - (path[waypoint * 3] as number)) +
                    (z - (path[waypoint * 3 + 2] as number)) *
                      (next[2] - (path[waypoint * 3 + 2] as number));
                  // Avoidance can carry the physical pose past a corner without hitting its exact coordinate.
                  if (
                    past > 0 &&
                    canTraverse(
                      surface,
                      [x, y - height / 2, z],
                      next,
                      surface.settings.maxStep + surface.settings.cellHeight * 2 + cc.offset,
                      256,
                    )
                  ) {
                    waypoint++;
                    continue;
                  }
                }
                if (
                  distance >
                    (waypoint === path.length / 3 - 1 ? character.arrivalDistance : 0.005) ||
                  vertical > surface.settings.maxStep + surface.settings.cellHeight * 2 + cc.offset
                )
                  break;
                waypoint++;
              }
              if (waypoint === path.length / 3) {
                world
                  .set(entity, NavigationAgent, {
                    waypoint,
                    status: NavigationAgentStatus.arrived,
                  })
                  .unwrap();
                dx = 0;
                dz = 0;
                moving = false;
              } else {
                const factor = Math.min(live.speed, distance / dt) / Math.max(distance, 1e-12);
                dx *= factor;
                dz *= factor;
              }
            }
            if (agents.length >= 4096)
              throw invalidInput(
                'agents',
                agents.length + 1,
                'At most 4096 physical navigation characters',
              );
            const actual = character.actual;
            agents.push({
              id: entity,
              x,
              y,
              z,
              radius: radius + cc.offset,
              height,
              vx: (actual[0] as number) / dt,
              vz: (actual[2] as number) / dt,
              desiredX: dx,
              desiredZ: dz,
              maxSpeed: moving ? live.speed : 0,
            });
            rows.set(entity, {
              entity,
              x,
              y,
              z,
              height,
              waypoint,
              grounded: cc.grounded,
              clearance: surface.settings.maxStep + surface.settings.cellHeight * 2 + cc.offset,
            });
          }
          const velocities = solveNavigationAvoidance(agents, options, (a, vx, vz) => {
            const r = rows.get(a.id);
            if (!r) return false;
            return canTraverse(
              surface,
              [r.x, r.y - r.height / 2, r.z],
              [r.x + vx * dt, r.y - r.height / 2, r.z + vz * dt],
              r.clearance,
              4096,
            );
          }).unwrap();
          for (const v of velocities) {
            const r = rows.get(v.id);
            if (r === undefined)
              throw invalidInput('avoidance output', v.id, 'A velocity for a collected character');
            const a = world.get(r.entity, NavigationAgent).unwrap(),
              c = world.get(r.entity, NavigationCharacter).unwrap();
            if (a.status !== NavigationAgentStatus.following) {
              if (
                c.verticalSpeed !== 0 ||
                Array.from(c.desired).some((v) => v !== 0) ||
                Array.from(c.actual).some((v) => v !== 0)
              )
                world
                  .set(r.entity, NavigationCharacter, {
                    desired: [0, 0, 0],
                    actual: [0, 0, 0],
                    verticalSpeed: 0,
                  })
                  .unwrap();
              continue;
            }
            const vx = v.x,
              vz = v.z;

            const vy = r.grounded
              ? Math.min(0, gravityY) * dt
              : Math.max(-50, c.verticalSpeed + gravityY * dt);
            const desired = vec3.create(vx * dt, vy * dt, vz * dt),
              actual = physics.moveAndSlide(r.entity, desired);
            const distance = Math.hypot(
              (a.path[r.waypoint * 3] as number) - (r.x + (actual[0] as number)),
              (a.path[r.waypoint * 3 + 2] as number) - (r.z + (actual[2] as number)),
            );
            const improved = a.waypoint !== r.waypoint || distance < c.bestDistance - 0.001;
            const stalledFor = improved ? 0 : c.stalledFor + dt;
            if (stalledFor >= c.stuckSeconds && c.recoveryAttempts < 2) {
              // A bounded repair handles avoidance leaving the selected corridor.
              // The final target remains the sole target; no timer or late result.
              const end = a.path.length - 3;
              const repaired = surface.findPath(
                [
                  r.x + (actual[0] as number),
                  r.y + (actual[1] as number) - r.height / 2,
                  r.z + (actual[2] as number),
                ],
                [a.path[end] as number, a.path[end + 1] as number, a.path[end + 2] as number],
                { maxProjection: surface.settings.cellSize, maxPolygons: 512, maxVisited: 512 },
              );
              world
                .set(r.entity, NavigationCharacter, {
                  recoveryAttempts: c.recoveryAttempts + 1,
                  stalledFor: repaired.ok ? 0 : stalledFor,
                  bestDistance: 1e20,
                  desired,
                  actual,
                  verticalSpeed: (actual[1] as number) / dt,
                })
                .unwrap();
              if (repaired.ok) {
                world
                  .set(r.entity, NavigationAgent, {
                    path: repaired.value.points,
                    waypoint: 0,
                  })
                  .unwrap();
                continue;
              }
            }
            const status =
              stalledFor >= c.stuckSeconds
                ? NavigationAgentStatus.blocked
                : NavigationAgentStatus.following;
            if (a.waypoint !== r.waypoint || a.status !== status)
              world.set(r.entity, NavigationAgent, { waypoint: r.waypoint, status }).unwrap();
            world
              .set(r.entity, NavigationCharacter, {
                desired,
                actual,
                stalledFor,
                bestDistance: improved ? distance : c.bestDistance,
                verticalSpeed: (actual[1] as number) / dt,
              })
              .unwrap();
          }
        },
      });
      ctx.effect(() => {
        world.addSystem(FixedUpdate, system).unwrap();
        return () => world.removeSystem(FixedUpdate, NAVIGATION_CHARACTER_SYSTEM);
      }, 'navigation/character-motor');
    },
  };
}
