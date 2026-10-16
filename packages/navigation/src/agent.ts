import {
  defineComponent,
  defineSystem,
  type EcsError,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  type World,
} from '@forgeax/engine-ecs';
import { CharacterController } from '@forgeax/engine-physics';
import type { Plugin } from '@forgeax/engine-plugin';
import { PROPAGATE_TRANSFORMS_FIXED_SYSTEM, scenePlugin, Transform } from '@forgeax/engine-scene';
import { err, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';
import { NAVIGATION_MAX_NODES } from './graph';

export const NavigationAgentStatus = { idle: 0, following: 1, arrived: 2, blocked: 3 } as const;

/** Path points and Transform.pos share the entity's local coordinate space. */
export const NavigationAgent = defineComponent(
  'NavigationAgent',
  {
    path: { type: 'array<f32>', default: new Float32Array(0) },
    waypoint: { type: 'u32', default: 0 },
    speed: { type: 'f32', default: 1 },
    status: { type: 'enum', default: NavigationAgentStatus.idle, labels: NavigationAgentStatus },
  },
  { requires: [Transform] },
);

/** Validate the complete route once and atomically restart following. Empty cancels. */
export function setNavigationPath(
  world: World,
  entity: EntityHandle,
  points: ArrayLike<number>,
): Result<void, NavigationError | EcsError> {
  if (world.hasComponent(entity, CharacterController) && points.length > 0)
    return err(invalidInput('path', entity, 'Use setNavigationTarget for physical characters'));
  if (
    !Number.isInteger(points.length) ||
    points.length < 0 ||
    points.length % 3 !== 0 ||
    points.length > NAVIGATION_MAX_NODES * 3
  )
    return err(
      invalidInput('path.length', points.length, `At most ${NAVIGATION_MAX_NODES} XYZ triples`),
    );
  const path = Float32Array.from(points);
  for (let i = 0; i < path.length; i++) {
    if (!Number.isFinite(path[i]))
      return err(invalidInput(`path[${i}]`, points[i], 'Finite Float32 coordinate'));
  }
  return world.set(entity, NavigationAgent, {
    path,
    waypoint: 0,
    status: path.length === 0 ? NavigationAgentStatus.idle : NavigationAgentStatus.following,
  });
}

export const NAVIGATION_FOLLOW_SYSTEM = 'navigation/follow-path';
/** Kinematic integration, not collision or avoidance. Custom motors consume paths directly. */
export const navigationFollowSystem = defineSystem({
  name: NAVIGATION_FOLLOW_SYSTEM,
  before: [PROPAGATE_TRANSFORMS_FIXED_SYSTEM],
  queries: [{ write: [NavigationAgent, Transform], without: [CharacterController] }],
  fn(world, [agents]) {
    const delta = world.getResource(FixedTime).delta;
    for (const span of agents.spans().unwrap()) {
      const agentColumns = span.get(NavigationAgent);
      const positions = span.get(Transform).pos;
      let transformWrites: Float32Array | undefined;
      let agentWrites: typeof agentColumns | undefined;
      for (let index = 0; index < span.length; index++) {
        if (agentColumns.status[index] !== NavigationAgentStatus.following) continue;
        const entity = span.entities[index] as EntityHandle;
        const agent = world.get(entity, NavigationAgent).unwrap();

        if (!Number.isFinite(agent.speed) || agent.speed < 0)
          throw invalidInput('speed', agent.speed, 'Finite non-negative speed');
        const path = agent.path;
        if (path.length === 0 || path.length % 3 !== 0 || agent.waypoint >= path.length / 3)
          throw invalidInput(
            'path',
            { length: path.length, waypoint: agent.waypoint },
            'Non-empty XYZ route with an in-range waypoint',
          );
        const base = index * 3;
        let x = positions[base] as number;
        let y = positions[base + 1] as number;
        let z = positions[base + 2] as number;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
          throw invalidInput('Transform.pos', [x, y, z], 'Finite local position');
        let remaining = agent.speed * delta;
        let waypoint = agent.waypoint;
        // Each iteration consumes a waypoint or the remaining travel distance.
        while (waypoint < path.length / 3) {
          const px = path[waypoint * 3] as number;
          const py = path[waypoint * 3 + 1] as number;
          const pz = path[waypoint * 3 + 2] as number;
          if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz))
            throw invalidInput(
              'path',
              waypoint,
              'Finite waypoint coordinates; use setNavigationPath',
            );
          const dx = px - x;
          const dy = py - y;
          const dz = pz - z;
          // Float32 coordinates keep their squared differences in Float64 range.
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (distance > remaining) {
            if (remaining > 0) {
              const scale = remaining / distance;
              x += dx * scale;
              y += dy * scale;
              z += dz * scale;
            }
            break;
          }
          x = px;
          y = py;
          z = pz;
          remaining -= distance;
          waypoint++;
        }
        if (x !== positions[base] || y !== positions[base + 1] || z !== positions[base + 2]) {
          transformWrites ??= span.mut(Transform).pos;
          transformWrites[base] = x;
          transformWrites[base + 1] = y;
          transformWrites[base + 2] = z;
        }
        if (waypoint !== agent.waypoint) {
          agentWrites ??= span.mut(NavigationAgent);
          agentWrites.waypoint[index] = waypoint;
          if (waypoint === path.length / 3)
            agentWrites.status[index] = NavigationAgentStatus.arrived;
        }
      }
    }
  },
});

/** Native Cordis lifetime; no graph registry or parallel agent state. */
export function navigationPlugin(): Plugin {
  return {
    name: 'navigation',
    inject: ['world'],
    async apply(ctx) {
      await ctx.plugin(scenePlugin());
      ctx.effect(() => {
        const lease = ctx.world.components.register(NavigationAgent).unwrap();
        return () => lease.dispose();
      }, 'navigation/components');
      ctx.effect(() => {
        const added = ctx.world.addSystem(FixedUpdate, navigationFollowSystem);
        if (!added.ok) throw added.error;
        return () => {
          ctx.world.removeSystem(FixedUpdate, NAVIGATION_FOLLOW_SYSTEM);
        };
      }, 'navigation/follow');
    },
  };
}
