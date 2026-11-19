import {
  beginScheduleWork,
  defineSystem,
  type EntityHandle,
  FixedTime,
  hasScheduleRunObservers,
  registerScheduleWork,
  Time,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import { readEntityComponentEpoch } from '@forgeax/engine-ecs/projection';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { type PhysicsWorld, PhysicsWorldResource, RigidBody } from '@forgeax/engine-physics';
import { GlobalTransform, WaterContactProbeSet } from '@forgeax/engine-scene';
import {
  rotateWaterVector,
  type Vec3,
  WATER_VISUAL_CONTACTS_RESOURCE,
  type WaterBodySnapshot,
  WaterQueryFlags,
  type WaterSystem,
  type WaterVisualContactState,
} from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { WaterContactProbes, WaterSceneReconcile } from './water-system-order.js';

export { WATER_VISUAL_CONTACTS_RESOURCE } from '@forgeax/engine-water';

const WATER_CONTACT_PROFILE_WORK = [
  'water/contact-probes/body-dynamics',
  'water/contact-probes/body-query',
  'water/query/terrain-routing',
  'water/query/terrain-sample',
  'water/query/wave-preparation',
  'water/query/spline-evaluation',
  'water/query/wave-evaluation',
  'water/query/residual-evaluation',
] as const;

export function installWaterContactProbes(
  world: World,
  water: WaterSystem,
  resolveBody: (entity: number) => WaterBodySnapshot | undefined,
): () => void {
  const releaseProfileWork = WATER_CONTACT_PROFILE_WORK.map((name) =>
    registerScheduleWork(world, name),
  );
  world.insertResource<WaterVisualContactState>(WATER_VISUAL_CONTACTS_RESOURCE, {
    roots: [],
    contacts: [],
    failures: [],
  });
  const waterContactProbesSystem = defineSystem({
    name: 'waterContactProbes',
    sets: [WaterContactProbes],
    after: [WaterSceneReconcile],
    queries: [],
    fn: () => {
      const observe = hasScheduleRunObservers(world)
        ? { begin: (operation: string) => beginScheduleWork(world, operation) }
        : undefined;
      const roots: WaterVisualContactState['roots'][number][] = [];
      const contacts: WaterVisualContactState['contacts'][number][] = [];
      const failures: WaterVisualContactState['failures'][number][] = [];
      const physics = world.hasResource(PhysicsWorldResource)
        ? world.getResource<PhysicsWorld>(PhysicsWorldResource)
        : undefined;
      const time = world.getResource(Time);
      for (const span of world
        .query({ read: [WaterContactProbeSet, GlobalTransform] })
        .unwrap()
        .spans()
        .unwrap()) {
        const entities = span.entities;
        const enabled = span.get(WaterContactProbeSet).enabled;
        for (let index = 0; index < span.length; index++) {
          const entity = entities[index] as EntityHandle;
          const c = world.get(entity, WaterContactProbeSet).unwrap();
          if (enabled[index] === 0) continue;
          const matrix = world.get(entity, GlobalTransform).unwrap().world;
          const invalidProbeConfiguration = () =>
            c.radiiM.length === 0 ||
            c.radiiM.length > 128 ||
            c.centersM.length !== c.radiiM.length * 3 ||
            !Array.from(c.centersM).every(Number.isFinite) ||
            !Array.from(c.radiiM).every((radius) => Number.isFinite(radius) && radius > 0) ||
            !Number.isFinite(c.contactCoverage) ||
            c.contactCoverage < 0 ||
            c.contactCoverage > 1 ||
            !Array.from(matrix).every(Number.isFinite);
          if (invalidProbeConfiguration()) {
            failures.push({
              entity: entity,
              code: 'water-contact-probes-invalid',
              detail: { count: c.radiiM.length },
            });
            continue;
          }
          const body = c.body === null ? undefined : resolveBody(c.body);
          if (body === undefined) {
            failures.push({
              entity: entity,
              code: 'water-contact-body-unavailable',
              detail: { bodyEntity: c.body },
            });
            continue;
          }
          const dynamicsScope = beginScheduleWork(world, 'water/contact-probes/body-dynamics');
          let dynamicsResult:
            | ReturnType<NonNullable<PhysicsWorld['getCommittedBodyDynamics']>>
            | undefined;
          try {
            dynamicsResult = physics?.getCommittedBodyDynamics?.(entity);
          } finally {
            dynamicsScope?.end();
          }
          if (world.get(entity, RigidBody).ok && !dynamicsResult?.ok) {
            failures.push({
              entity: entity,
              code: 'water-contact-dynamics-unavailable',
              detail: dynamicsResult?.error ?? { reason: 'physics-unavailable' },
            });
            continue;
          }
          const dynamics = dynamicsResult?.ok ? dynamicsResult.value : undefined;
          const epoch = readEntityComponentEpoch(world, entity, WaterContactProbeSet);
          const root = Object.freeze({
            rootEntity: entity,
            rootGeneration: dynamics?.generation ?? epoch,
            sourceIdentity: `visual-probe:${epoch}`,
          });
          roots.push(root);
          const rotation = quat.create();
          mat4.decompose(vec3.create(), rotation, vec3.create(), matrix);
          const inverseRotation = [
            -requireWaterValue(rotation[0]),
            -requireWaterValue(rotation[1]),
            -requireWaterValue(rotation[2]),
            requireWaterValue(rotation[3]),
          ] as const;
          const captureProbeContacts = () => {
            for (let index = 0; index < c.radiiM.length; index++) {
              const local: Vec3 = [
                requireWaterValue(c.centersM[index * 3]),
                requireWaterValue(c.centersM[index * 3 + 1]),
                requireWaterValue(c.centersM[index * 3 + 2]),
              ];
              let offset: Vec3 = [
                requireWaterValue(matrix[0]) * local[0] +
                  requireWaterValue(matrix[4]) * local[1] +
                  requireWaterValue(matrix[8]) * local[2],
                requireWaterValue(matrix[1]) * local[0] +
                  requireWaterValue(matrix[5]) * local[1] +
                  requireWaterValue(matrix[9]) * local[2],
                requireWaterValue(matrix[2]) * local[0] +
                  requireWaterValue(matrix[6]) * local[1] +
                  requireWaterValue(matrix[10]) * local[2],
              ];
              if (dynamics !== undefined)
                offset = rotateWaterVector(
                  dynamics.rotation,
                  rotateWaterVector(inverseRotation, offset),
                );
              const origin = dynamics?.positionM ?? [
                requireWaterValue(matrix[12]),
                requireWaterValue(matrix[13]),
                requireWaterValue(matrix[14]),
              ];
              const position: Vec3 = [
                requireWaterValue(origin[0]) + offset[0],
                requireWaterValue(origin[1]) + offset[1],
                requireWaterValue(origin[2]) + offset[2],
              ];
              water.prepareOceanPatchQueries(body.guid, body.sceneGeneration, [position]);
              const nativeClock = physics?.getSolverClock?.();
              const queryInput = {
                positionM: position,
                timeSeconds: time.elapsed,
                expectedBodyGeneration: body.sceneGeneration,
                ...(nativeClock === undefined
                  ? {}
                  : {
                      nativePhysics: {
                        completedStep: nativeClock.completedStep,
                        timeSeconds: nativeClock.simulationTimeSeconds,
                      },
                    }),
                flags:
                  WaterQueryFlags.ComputeLocation |
                  WaterQueryFlags.ComputeNormal |
                  WaterQueryFlags.ComputeVelocity |
                  WaterQueryFlags.IncludeWaves,
              };
              const queryScope = beginScheduleWork(world, 'water/contact-probes/body-query');
              let query: ReturnType<WaterSystem['queryBody']>;
              try {
                query = water.queryBody(body.guid, queryInput, observe);
              } finally {
                queryScope?.end();
              }
              if (!query.ok) {
                failures.push({
                  entity: entity,
                  code: 'water-contact-query-failed',
                  detail: query.error,
                });
                continue;
              }
              const sample = query.value;
              const waterY = sample.surfaceM?.[1];
              const radius = requireWaterValue(c.radiiM[index]);
              if (
                sample.excluded ||
                waterY === undefined ||
                Math.abs(waterY - position[1]) >= radius
              )
                continue;
              const contactPosition: Vec3 = Object.freeze([position[0], waterY, position[2]]);
              const r =
                dynamics === undefined
                  ? [0, 0, 0]
                  : contactPosition.map(
                      (value, axis) => value - requireWaterValue(dynamics.centerOfMassM[axis]),
                    );
              const angular = dynamics?.angularVelocityRadps ?? [0, 0, 0];
              const linear = dynamics?.linearVelocityMps ?? [0, 0, 0];
              const waterVelocity = sample.velocityMPerSec ?? [0, 0, 0];
              const relativeVelocityMps: Vec3 = Object.freeze([
                requireWaterValue(linear[0]) +
                  requireWaterValue(angular[1]) * requireWaterValue(r[2]) -
                  requireWaterValue(angular[2]) * requireWaterValue(r[1]) -
                  requireWaterValue(waterVelocity[0]),
                requireWaterValue(linear[1]) +
                  requireWaterValue(angular[2]) * requireWaterValue(r[0]) -
                  requireWaterValue(angular[0]) * requireWaterValue(r[2]) -
                  requireWaterValue(waterVelocity[1]),
                requireWaterValue(linear[2]) +
                  requireWaterValue(angular[0]) * requireWaterValue(r[1]) -
                  requireWaterValue(angular[1]) * requireWaterValue(r[0]) -
                  requireWaterValue(waterVelocity[2]),
              ]);
              contacts.push(
                Object.freeze({
                  ...root,
                  kind: 'visual-probe',
                  sourcePhysicsStep:
                    nativeClock?.completedStep ??
                    dynamics?.completedStep ??
                    world.getResource(FixedTime).tick,
                  queryTimeSeconds: time.elapsed,
                  probeId: `probe-${index}`,
                  bodyGuid: body.guid,
                  bodyGeneration: body.sceneGeneration,
                  phase: 'contact',
                  coverage: c.contactCoverage,
                  contact: Object.freeze({
                    kind: 'water-plane-intersection',
                    positionM: contactPosition,
                    radiusM: Math.sqrt(radius * radius - (waterY - position[1]) ** 2),
                    relativeVelocityMps,
                  }),
                }),
              );
            }
          };
          captureProbeContacts();
        }
      }
      world.insertResource<WaterVisualContactState>(
        WATER_VISUAL_CONTACTS_RESOURCE,
        Object.freeze({
          roots: Object.freeze(roots),
          contacts: Object.freeze(contacts),
          failures: Object.freeze(failures),
        }),
      );
    },
  });
  world.addSystem(Update, waterContactProbesSystem).unwrap();
  return () => {
    world.removeSystem(Update, waterContactProbesSystem);
    world.removeResource(WATER_VISUAL_CONTACTS_RESOURCE);
    for (const release of releaseProfileWork) release();
  };
}
