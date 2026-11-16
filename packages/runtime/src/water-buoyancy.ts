import {
  beginScheduleWork,
  defineSystem,
  Entity,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  hasScheduleRunObservers,
  registerScheduleWork,
  type SchemaOf,
  type ShapeOf,
  Time,
  type World,
} from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  PhysicsBodyDynamics,
  PhysicsSolverParticipant,
  PhysicsWorld,
} from '@forgeax/engine-physics';
import {
  PhysicsSimulation,
  PhysicsSync,
  PhysicsWorldResource,
  PhysicsWritebackPhase,
} from '@forgeax/engine-physics';
import { ChildOf, GlobalTransform, Transform, WaterPontoonSet } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  decodeWaterSolverOutput,
  encodeWaterSolverSnapshot,
  rotateWaterVector,
  stepWaterBuoyancy,
  type Vec3,
  WATER_BUOYANCY_DEFAULTS,
  WATER_BUOYANCY_RESOURCE,
  type WaterAsyncOutputSelection,
  WaterAsyncOutputTimeline,
  type WaterBodySnapshot,
  WaterBuoyancyCoefficientCache,
  type WaterBuoyancyError,
  type WaterBuoyancyFailure,
  type WaterBuoyancySettings,
  type WaterBuoyancyState,
  type WaterBuoyancyStep,
  type WaterPontoon,
  type WaterSplashWakeEvent,
  type WaterSystem,
  type WaterWaveSetAsset,
  waterSolverBodySnapshot,
} from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { WaterBuoyancy, WaterBuoyancyCompletion } from './water-system-order.js';

export { WATER_BUOYANCY_RESOURCE, type WaterBuoyancyState } from '@forgeax/engine-water';

const WATER_BUOYANCY_PROFILE_WORK = [
  'water/buoyancy/body-dynamics',
  'water/buoyancy/signature-match',
  'water/buoyancy/sensor-overlaps',
  'water/buoyancy/pontoon-resolution',
  'water/buoyancy/ocean-query-preparation',
  'water/buoyancy/spline-sample',
  'water/buoyancy/candidate-query',
  'water/buoyancy/worker-snapshot',
  'water/buoyancy/worker-submit',
  'water/zone/ground-snapshot-copy',
  'water/query/terrain-routing',
  'water/query/terrain-sample',
  'water/query/wave-preparation',
  'water/query/spline-evaluation',
  'water/query/wave-evaluation',
  'water/query/residual-evaluation',
] as const;

const invalid = (detail: WaterBuoyancyError['detail']): WaterBuoyancyFailure => ({
  code: 'buoyancy-config-invalid',
  expected:
    'WaterPontoonSet configurationVersion 1 with one exclusive, live root-relative anchor authority',
  hint: 'repair the saved pontoon configuration or socket hierarchy',
  detail,
});
const point = (values: ArrayLike<number>, index: number): Vec3 => [
  values[index * 3] as number,
  values[index * 3 + 1] as number,
  values[index * 3 + 2] as number,
];

function configurationKeys(c: ShapeOf<SchemaOf<typeof WaterPontoonSet>>, asyncEnabled: boolean) {
  const geometryKey = JSON.stringify([
    c.configurationVersion,
    c.anchorMode,
    Array.from(c.radiiM),
    Array.from(c.anchorsM),
    Array.from(c.socketEntities),
    c.centerPontoonsOnCOM,
  ]);
  return {
    geometryKey,
    signature: JSON.stringify([
      geometryKey,
      c.enabled,
      c.useAsyncPath,
      asyncEnabled,
      Array.from(c.enabledPontoons),
      ...Object.keys(WATER_BUOYANCY_DEFAULTS).map(
        (key) => c[key as keyof typeof WATER_BUOYANCY_DEFAULTS],
      ),
    ]),
  };
}

function socketPosition(
  world: World,
  root: EntityHandle,
  socket: EntityHandle,
): Result<Readonly<{ rootPositionM: Vec3; coefficientPositionM: Vec3 }>, WaterBuoyancyFailure> {
  if (socket === root) return err(invalid({ kind: 'socket', socket, reason: 'not-descendant' }));
  const chain: EntityHandle[] = [];
  let current = socket;
  while (current !== root) {
    if (chain.length >= 128 || chain.includes(current) || !world.get(current, Entity).ok)
      return err(invalid({ kind: 'socket', socket, reason: 'stale-or-cyclic' }));
    chain.push(current);
    const parent = world.get(current, ChildOf);
    if (!parent.ok || parent.value.parent === null)
      return err(invalid({ kind: 'socket', socket, reason: 'detached' }));
    current = parent.value.parent;
  }
  const matrix = mat4.identity(mat4.create()),
    local = mat4.create();
  for (const entity of chain.reverse()) {
    const transform = world.get(entity, Transform);
    if (!transform.ok) return err(invalid({ kind: 'socket', socket, reason: 'transform-missing' }));
    const t = transform.value;
    mat4.compose(local, t.pos, t.quat, t.scale, t.shear);
    mat4.multiply(matrix, matrix, local);
  }
  const socketTransform = world.get(socket, Transform);
  if (!socketTransform.ok)
    return err(invalid({ kind: 'socket', socket, reason: 'transform-missing' }));
  return ok({
    rootPositionM: [matrix[12] as number, matrix[13] as number, matrix[14] as number],
    coefficientPositionM: point(socketTransform.value.pos, 0),
  });
}

function resolvePontoons(
  world: World,
  entity: EntityHandle,
  dynamics: PhysicsBodyDynamics,
): Result<readonly WaterPontoon[], WaterBuoyancyFailure> {
  const read = world.get(entity, WaterPontoonSet);
  if (!read.ok) return err(invalid({ kind: 'configuration', entity, reason: 'retired' }));
  const c = read.value,
    n = c.radiiM.length;
  if (
    c.configurationVersion !== 1 ||
    n < 1 ||
    n > 32 ||
    c.anchorsM.length !== n * 3 ||
    (c.enabledPontoons.length !== 0 && c.enabledPontoons.length !== n) ||
    (c.anchorMode !== 0 && c.anchorMode !== 1) ||
    (c.anchorMode === 0 && c.socketEntities.length !== 0) ||
    (c.anchorMode === 1 && c.socketEntities.length !== n)
  )
    return err(invalid({ kind: 'configuration', entity, reason: 'cardinality' }));
  if (Array.from(c.enabledPontoons).some((enabled) => enabled !== 0 && enabled !== 1))
    return err(invalid({ kind: 'configuration', entity, reason: 'enabled-mask' }));
  const transform = world.get(entity, GlobalTransform);
  if (!transform.ok)
    return err(invalid({ kind: 'configuration', entity, reason: 'root-transform-missing' }));
  const m = transform.value.world;
  const sourceRotation = quat.create();
  const resolvePontoonSourceRotation = () => {
    if (world.get(entity, ChildOf).ok) {
      // Match ordinary Physics' source orientation; retain the complete affine remainder.
      mat4.decompose(vec3.create(), sourceRotation, vec3.create(), m);
    } else {
      const local = world.get(entity, Transform);
      if (!local.ok)
        return err(invalid({ kind: 'configuration', entity, reason: 'root-transform-missing' }));
      sourceRotation.set(local.value.quat);
    }
    return undefined;
  };
  const rotationFailure = resolvePontoonSourceRotation();
  if (rotationFailure !== undefined) return rotationFailure;
  const length = Math.hypot(...sourceRotation);
  if (!Array.from(m).every(Number.isFinite) || !Number.isFinite(length) || length === 0)
    return err(invalid({ kind: 'configuration', entity, reason: 'root-transform-invalid' }));
  const inverseRotation: PhysicsBodyDynamics['rotation'] = [
    -(sourceRotation[0] as number) / length,
    -(sourceRotation[1] as number) / length,
    -(sourceRotation[2] as number) / length,
    (sourceRotation[3] as number) / length,
  ];
  const worldPosition = (local: Vec3): Vec3 => {
    const affine: Vec3 = [
      (m[0] as number) * local[0] + (m[4] as number) * local[1] + (m[8] as number) * local[2],
      (m[1] as number) * local[0] + (m[5] as number) * local[1] + (m[9] as number) * local[2],
      (m[2] as number) * local[0] + (m[6] as number) * local[1] + (m[10] as number) * local[2],
    ];
    const rotated = rotateWaterVector(
      dynamics.rotation,
      rotateWaterVector(inverseRotation, affine),
    );
    return [
      dynamics.positionM[0] + rotated[0],
      dynamics.positionM[1] + rotated[1],
      dynamics.positionM[2] + rotated[2],
    ];
  };
  const collectPontoons = () => {
    const output: WaterPontoon[] = [];
    for (let i = 0; i < n; i++) {
      const authored = point(c.anchorsM, i);
      let coefficientPosition = authored,
        center = worldPosition(authored);
      if (c.anchorMode === 1) {
        const socket = socketPosition(world, entity, c.socketEntities[i] as EntityHandle);
        if (!socket.ok) return socket;
        coefficientPosition = socket.value.coefficientPositionM;
        const position = worldPosition(socket.value.rootPositionM);
        center = [position[0] + authored[0], position[1] + authored[1], position[2] + authored[2]];
      }
      output.push({
        id: `pontoon-${i}`,
        radiusM: c.radiiM[i] as number,
        enabled: c.enabledPontoons.length === 0 || c.enabledPontoons[i] === 1,
        centerM: center,
        coefficientPositionM: coefficientPosition,
        anchor: c.anchorMode === 0 ? 'relative' : 'socket',
      });
    }
    return ok(output);
  };
  return collectPontoons();
}

/** Installed by the existing Water Scene owner; no separate body/asset registry. */
export function installWaterBuoyancy(
  world: World,
  water: WaterSystem,
  resolveBody: (entity: number) => WaterBodySnapshot | undefined,
): () => void {
  const releaseProfileWork = WATER_BUOYANCY_PROFILE_WORK.map((name) =>
    registerScheduleWork(world, name),
  );
  const state: WaterBuoyancyState = {
    asyncEnabled: true,
    async: {
      execution: 'disabled',
      submitted: 0,
      completed: 0,
      cancelled: 0,
      rejected: 0,
      pending: 0,
      selections: [],
    },
    steps: [],
    forceEvents: [],
    splashWakeEvents: [],
  };
  let solver: PhysicsSolverParticipant | undefined,
    taskId = 0;
  let splashWakeBatchTimeSeconds = Number.NaN;
  const pendingTasks = new Map<
    number,
    {
      entity: number;
      generation: number;
      signature: string;
      snapshotHash: string;
      sourceStep: number;
      solveStep: number;
      bodies: readonly Readonly<{
        entity: number;
        guid: string;
        generation: number;
        collisionRevision: number;
        zoneGuid?: string;
        groundGeneration: number;
        residualLifecycle?: string;
      }>[];
    }
  >();
  const cancelEntity = (entity: number) => {
    for (const [id, task] of pendingTasks)
      if (task.entity === entity) {
        solver?.cancel(id);
        pendingTasks.delete(id);
        state.async = {
          ...state.async,
          cancelled: state.async.cancelled + 1,
          pending: pendingTasks.size,
        };
      }
    const participant = participants.get(entity);
    if (participant) {
      participant.timeline.clear();
      delete participant.selection;
      delete participant.pending;
    }
  };
  const participants = new Map<
    number,
    {
      rootGeneration: number;
      geometryKey: string;
      coefficientCache: WaterBuoyancyCoefficientCache;
      pending?: WaterBuoyancyStep;
      previous: Map<string, NonNullable<WaterPontoon['previousWaterState']>>;
      timeline: WaterAsyncOutputTimeline;
      signature: string;
      selection?: WaterAsyncOutputSelection;
    }
  >();
  const retainCurrentWetState = (
    participant: { previous: Map<string, NonNullable<WaterPontoon['previousWaterState']>> },
    step: WaterBuoyancyStep,
  ) => {
    for (const pontoon of step.pontoons)
      if (pontoon.enabled)
        participant.previous.set(pontoon.pontoonId, {
          inWater: pontoon.inWater,
          ...(pontoon.selectedBodyGuid === undefined || pontoon.selectedBodyGeneration === undefined
            ? {}
            : {
                bodyGuid: pontoon.selectedBodyGuid,
                bodyGeneration: pontoon.selectedBodyGeneration,
              }),
        });
  };
  const incarnations = world.query({ added: [WaterPontoonSet] }).unwrap();
  world.insertResource(WATER_BUOYANCY_RESOURCE, state);
  const waterBuoyancySystem = defineSystem({
    name: 'waterBuoyancy',
    sets: [WaterBuoyancy],
    after: [PhysicsSync],
    before: [PhysicsSimulation],
    queries: [],
    fn: () => {
      const observe = hasScheduleRunObservers(world)
        ? { begin: (operation: string) => beginScheduleWork(world, operation) }
        : undefined;
      state.forceEvents = [];
      for (const row of incarnations) {
        cancelEntity(row.entity);
        participants.delete(row.entity);
      }
      const physics = world.hasResource(PhysicsWorldResource)
          ? world.getResource<PhysicsWorld>(PhysicsWorldResource)
          : undefined,
        time = world.getResource(FixedTime);
      // Cancellation must precede the native participant's pre-integration boundary.
      const cancelStaleBuoyancyTasks = () => {
        for (const task of pendingTasks.values())
          if (
            task.bodies.some((body) => {
              const current = resolveBody(body.entity);
              return (
                current?.guid !== body.guid ||
                current.sceneGeneration !== body.generation ||
                current.dirty.has('collision') ||
                current.outputGenerations.collision !== body.collisionRevision ||
                water.oceanPatchQueryLifecycle(body.guid) !== body.residualLifecycle ||
                (body.zoneGuid !== undefined &&
                  (water.zoneGroundSnapshot(body.zoneGuid, observe)?.generation ?? 0) !==
                    body.groundGeneration)
              );
            })
          )
            cancelEntity(task.entity);
      };
      cancelStaleBuoyancyTasks();
      const steps: { entity: number; result: Result<WaterBuoyancyStep, WaterBuoyancyFailure> }[] =
          [],
        live = new Set<number>();
      let hasAsyncParticipant = false;
      const queryReceivers: { entity: number; generation: number }[] = [];
      const processBuoyancyPontoonRoster = () => {
        for (const span of world
          .query({ read: [WaterPontoonSet] })
          .unwrap()
          .spans()
          .unwrap()) {
          const entities = span.entities;
          const enabled = span.get(WaterPontoonSet).enabled;
          for (let index = 0; index < span.length; index++) {
            const entity = entities[index] as EntityHandle;
            const c = world.get(entity, WaterPontoonSet).unwrap();
            live.add(entity);
            if (enabled[index] === 0) {
              cancelEntity(entity);
              continue;
            }
            hasAsyncParticipant ||= c.useAsyncPath && state.asyncEnabled;
            const fail = (error: WaterBuoyancyFailure) =>
              steps.push({ entity, result: err(error) });
            if (!physics?.getCommittedBodyDynamics || !physics.getSensorOverlaps) {
              fail({
                code: 'buoyancy-physics-unsupported',
                expected: 'ordinary committed dynamics and persistent completed sensor roster',
                hint: 'select a backend with the synchronous buoyancy prerequisites',
                detail: {
                  kind: 'physics',
                  reason: physics === undefined ? 'backend-missing' : 'dynamics-capability',
                  entity,
                },
              });
              continue;
            }
            const dynamicsScope = beginScheduleWork(world, 'water/buoyancy/body-dynamics');
            let dynamics: ReturnType<NonNullable<typeof physics.getCommittedBodyDynamics>>;
            try {
              dynamics = physics.getCommittedBodyDynamics(entity);
            } finally {
              dynamicsScope?.end();
            }
            if (!dynamics.ok) {
              fail(dynamics.error);
              continue;
            }
            const reconcileBuoyancyParticipantSignature = () => {
              const signatureScope = beginScheduleWork(world, 'water/buoyancy/signature-match');
              let geometryKey: string, signature: string;
              try {
                ({ geometryKey, signature } = configurationKeys(c, state.asyncEnabled));
              } finally {
                signatureScope?.end();
              }
              let participant = participants.get(entity);
              if (
                participant === undefined ||
                participant.rootGeneration !== dynamics.value.generation ||
                participant.geometryKey !== geometryKey
              ) {
                cancelEntity(entity);
                participant = {
                  rootGeneration: dynamics.value.generation,
                  geometryKey,
                  coefficientCache: new WaterBuoyancyCoefficientCache(),
                  previous: new Map(),
                  timeline: new WaterAsyncOutputTimeline(64),
                  signature,
                };
                participants.set(entity, participant);
              }
              if (participant.signature !== signature) {
                cancelEntity(entity);
                participant.signature = signature;
              }
              return { participant, signature };
            };
            const { participant, signature } = reconcileBuoyancyParticipantSignature();
            const overlapScope = beginScheduleWork(world, 'water/buoyancy/sensor-overlaps');
            let overlaps: ReturnType<NonNullable<typeof physics.getSensorOverlaps>>;
            try {
              overlaps = physics.getSensorOverlaps(entity, c.overlapFilterMask);
            } finally {
              overlapScope?.end();
            }
            if (!overlaps.ok) {
              fail(overlaps.error);
              continue;
            }
            const readBuoyancyResolvedPontoons = () => {
              const pontoonScope = beginScheduleWork(world, 'water/buoyancy/pontoon-resolution');
              let pontoons: ReturnType<typeof resolvePontoons>;
              try {
                pontoons = resolvePontoons(world, entity, dynamics.value);
              } finally {
                pontoonScope?.end();
              }

              return pontoons;
            };
            const pontoons = readBuoyancyResolvedPontoons();
            if (!pontoons.ok) {
              fail(pontoons.error);
              continue;
            }
            const retireStalePontoonStates = () => {
              for (const [id, previous] of participant.previous)
                if (
                  previous.bodyGuid !== undefined &&
                  water.snapshot(previous.bodyGuid)?.sceneGeneration !== previous.bodyGeneration
                )
                  participant.previous.delete(id);
            };
            retireStalePontoonStates();
            const inputs = pontoons.value.map((pontoon) => ({
              ...pontoon,
              previousWaterState: participant.previous.get(pontoon.id) ?? { inWater: false },
            }));
            queryReceivers.push({ entity, generation: dynamics.value.generation });
            const prepareBuoyancyOceanQueries = () => {
              for (const overlap of overlaps.value.current) {
                const body = resolveBody(overlap.entity);
                if (body) {
                  const queryPreparationScope = beginScheduleWork(
                    world,
                    'water/buoyancy/ocean-query-preparation',
                  );
                  try {
                    water.prepareOceanPatchQueries(
                      body.guid,
                      body.sceneGeneration,
                      inputs.filter((pontoon) => pontoon.enabled).map((pontoon) => pontoon.centerM),
                      { entity, generation: dynamics.value.generation },
                    );
                  } finally {
                    queryPreparationScope?.end();
                  }
                }
              }
            };
            prepareBuoyancyOceanQueries();
            const readBuoyancyWaveTimeSettings = () => {
              const settings = Object.fromEntries(
                Object.keys(WATER_BUOYANCY_DEFAULTS).map((key) => [
                  key,
                  c[key as keyof typeof WATER_BUOYANCY_DEFAULTS],
                ]),
              ) as WaterBuoyancySettings;
              const wavedBody = overlaps.value.current
                .map((overlap) => resolveBody(overlap.entity))
                .find((body) => body && body.asset.type !== 'river' && body.asset.waveSetGuid);
              const waveSet = wavedBody?.dependencies.find(
                (dependency) => dependency.field === 'waveSetGuid' && dependency.status === 'valid',
              )?.payload as WaterWaveSetAsset | undefined;
              const referenceTimeSeconds =
                waveSet?.timeSource === 'fixed-step'
                  ? time.tick * time.delta
                  : world.getResource(Time).elapsed;
              return { settings, referenceTimeSeconds };
            };
            const { settings, referenceTimeSeconds } = readBuoyancyWaveTimeSettings();
            let useAsync = c.useAsyncPath && state.asyncEnabled;
            const prepareAsynchronousBuoyancySolver = () => {
              if (useAsync && !solver) {
                const created = physics.createSolverParticipant?.({
                  id: 'water-buoyancy',
                  capacity: 64,
                  workerUrl: new URL('./water-buoyancy-solver.mjs', import.meta.url).href,
                });
                if (
                  !created?.ok ||
                  !created.value.asyncResults ||
                  created.value.execution !== 'worker-solver' ||
                  !physics.getSolverClock
                ) {
                  if (created?.ok) created.value.dispose();
                  if (
                    created &&
                    !created.ok &&
                    created.error.code !== 'fixed-operation-unavailable'
                  ) {
                    fail(created.error);
                    state.async = { ...state.async, rejected: state.async.rejected + 1 };
                    return true;
                  }
                  state.async = { ...state.async, execution: 'unsupported' };
                  useAsync = false;
                } else {
                  solver = created.value;
                }
              }

              return false;
            };
            if (prepareAsynchronousBuoyancySolver()) continue;
            const submitAsynchronousBuoyancyStep = () => {
              if (useAsync && solver) {
                const collectBuoyancyWorkerBodies = () => {
                  const bodies = overlaps.value.current.flatMap((overlap) => {
                    const snapshot = resolveBody(overlap.entity),
                      publication = physics.getDerivedPublication?.(overlap.entity);
                    if (
                      !snapshot ||
                      !publication ||
                      publication.revision !== snapshot.outputGenerations.collision ||
                      snapshot.dirty.has('collision')
                    )
                      return [];
                    const ground =
                      snapshot.binding.kind === 'bound'
                        ? water.zoneGroundSnapshot(snapshot.binding.zoneGuid, observe)
                        : undefined;
                    return [
                      waterSolverBodySnapshot(
                        snapshot,
                        ground?.providers.map((provider) => provider.entity) ?? [],
                        ground?.generation ?? 0,
                        water.oceanPatchQuerySnapshot(snapshot.guid),
                      ),
                    ];
                  });
                  return bodies;
                };
                const bodies = collectBuoyancyWorkerBodies();
                const snapshotScope = beginScheduleWork(world, 'water/buoyancy/worker-snapshot');
                let encoded: ReturnType<typeof encodeWaterSolverSnapshot>;
                try {
                  encoded = encodeWaterSolverSnapshot({
                    schema: 'forgeax-water-solver/3',
                    nativePhysicsTimeSeconds:
                      physics.getSolverClock?.().simulationTimeSeconds ?? null,
                    sourceDynamics: dynamics.value,
                    overlaps: overlaps.value,
                    pontoons: inputs,
                    settings,
                    bodies,
                    coefficientResolution: participant.coefficientCache.resolve(
                      pontoons.value,
                      dynamics.value.localCenterOfMassM,
                      settings.centerPontoonsOnCOM,
                    ),
                  });
                } finally {
                  snapshotScope?.end();
                }
                const id = ++taskId;
                const submitScope = beginScheduleWork(world, 'water/buoyancy/worker-submit');
                let submitted: ReturnType<typeof solver.submit>;
                try {
                  submitted = solver.submit({
                    taskId: id,
                    entity,
                    entityGeneration: dynamics.value.generation,
                    sourceStep: dynamics.value.completedStep,
                    solveStep: dynamics.value.nextFixedStep,
                    referenceTimeSeconds,
                    ...encoded,
                  });
                } finally {
                  submitScope?.end();
                }
                if (!submitted.ok) {
                  fail(submitted.error);
                  state.async = { ...state.async, rejected: state.async.rejected + 1 };
                  return true;
                }
                const retainSubmittedBuoyancyTask = () => {
                  pendingTasks.set(id, {
                    entity,
                    generation: dynamics.value.generation,
                    signature,
                    snapshotHash: encoded.snapshotHash,
                    sourceStep: dynamics.value.completedStep,
                    solveStep: dynamics.value.nextFixedStep,
                    bodies: bodies.map((body) => ({
                      entity: body.entity,
                      guid: body.body.guid,
                      generation: body.body.sceneGeneration,
                      collisionRevision: requireWaterValue(resolveBody(body.entity))
                        .outputGenerations.collision,
                      ...(body.body.binding.kind === 'bound'
                        ? { zoneGuid: body.body.binding.zoneGuid }
                        : {}),
                      groundGeneration: body.groundGeneration,
                      ...(water.oceanPatchQueryLifecycle(body.body.guid) === undefined
                        ? {}
                        : {
                            residualLifecycle: requireWaterValue(
                              water.oceanPatchQueryLifecycle(body.body.guid),
                            ),
                          }),
                    })),
                  });
                };
                retainSubmittedBuoyancyTask();
                state.async = {
                  ...state.async,
                  execution: 'worker-solver',
                  submitted: state.async.submitted + 1,
                  pending: pendingTasks.size,
                };
                const current =
                  participant.selection?.current &&
                  state.steps.find((step) => step.entity === entity);
                if (current) steps.push(current);
                return true;
              }

              return false;
            };
            if (submitAsynchronousBuoyancyStep()) continue;
            const completeSynchronousBuoyancyStep = () => {
              const result = stepWaterBuoyancy({
                physics,
                water,
                dynamics: dynamics.value,
                overlaps: overlaps.value,
                coefficientCache: participant.coefficientCache,
                pontoons: inputs,
                settings,
                fixedDeltaSeconds: time.delta,
                fixedTimeSeconds: referenceTimeSeconds,
                ...(physics.getSolverClock
                  ? { nativePhysicsTimeSeconds: physics.getSolverClock().simulationTimeSeconds }
                  : {}),
                ...(observe === undefined ? {} : { observe }),
                resolveBody: (overlap) => {
                  const snapshot = resolveBody(overlap.entity),
                    publication = physics.getDerivedPublication?.(overlap.entity);
                  if (
                    !snapshot ||
                    !publication ||
                    publication.revision !== snapshot.outputGenerations.collision ||
                    snapshot.dirty.has('collision')
                  )
                    return err({
                      code: 'buoyancy-candidate-rejected',
                      expected:
                        'the overlap collider resolves to the current accepted Water collision and Scene generation',
                      hint: 'wait for this Body collision publication; non-water sensors never become water candidates',
                      detail: {
                        kind: 'candidate',
                        reason: 'water-publication',
                        overlap,
                        ...(snapshot === undefined
                          ? {}
                          : { bodyGuid: snapshot.guid, bodyGeneration: snapshot.sceneGeneration }),
                        ...(publication === undefined
                          ? {}
                          : { collisionRevision: publication.revision }),
                      },
                    });
                  return ok(snapshot);
                },
              });
              steps.push({ entity, result });
              if (result.ok) participant.pending = result.value;
            };
            completeSynchronousBuoyancyStep();
          }
        }
      };
      processBuoyancyPontoonRoster();
      const retireMissingBuoyancyParticipants = () => {
        for (const entity of participants.keys())
          if (!live.has(entity)) {
            cancelEntity(entity);
            participants.delete(entity);
          }
      };
      retireMissingBuoyancyParticipants();
      const completeBuoyancyForcePublication = () => {
        water.retainOceanPatchQueryReceivers(queryReceivers);
        if (solver && !hasAsyncParticipant) {
          for (const entity of participants.keys()) cancelEntity(entity);
          solver.dispose();
          solver = undefined;
          state.async = { ...state.async, execution: 'disabled' };
        }
        state.steps = Object.freeze(steps);
        state.forceEvents = Object.freeze(
          steps.flatMap((step) => (step.result.ok ? [...step.result.value.forceEvents] : [])),
        );
      };
      completeBuoyancyForcePublication();
    },
  });
  world.addSystem(FixedUpdate, waterBuoyancySystem).unwrap();
  const waterBuoyancyCompletionSystem = defineSystem({
    name: 'waterBuoyancyCompletion',
    sets: [WaterBuoyancyCompletion],
    after: [PhysicsWritebackPhase],
    queries: [],
    fn: () => {
      const observe = hasScheduleRunObservers(world)
        ? { begin: (operation: string) => beginScheduleWork(world, operation) }
        : undefined;
      const events: WaterSplashWakeEvent[] = [];
      if (!world.hasResource(PhysicsWorldResource)) {
        state.splashWakeEvents = [];
        return;
      }
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      const completed: { entity: number; step: WaterBuoyancyStep; synchronous: boolean }[] = [];
      for (const [entity, participant] of participants) {
        if (participant.pending)
          completed.push({ entity, step: participant.pending, synchronous: true });
        delete participant.pending;
      }
      const validTask = (id: number) => {
        const task = pendingTasks.get(id);
        const participant = task && participants.get(task.entity);
        const component = task && world.get(task.entity as EntityHandle, WaterPontoonSet);
        const dynamics = task && physics.getCommittedBodyDynamics?.(task.entity);
        return task &&
          participant &&
          participant.signature === task.signature &&
          component?.ok &&
          component.value.enabled &&
          component.value.useAsyncPath &&
          state.asyncEnabled &&
          configurationKeys(component.value, state.asyncEnabled).signature === task.signature &&
          dynamics?.ok &&
          dynamics.value.generation === task.generation &&
          !task.bodies.some((body) => {
            const current = resolveBody(body.entity);
            return (
              current?.guid !== body.guid ||
              current.sceneGeneration !== body.generation ||
              current.dirty.has('collision') ||
              current.outputGenerations.collision !== body.collisionRevision ||
              water.oceanPatchQueryLifecycle(body.guid) !== body.residualLifecycle ||
              (body.zoneGuid !== undefined &&
                (water.zoneGroundSnapshot(body.zoneGuid, observe)?.generation ?? 0) !==
                  body.groundGeneration)
            );
          })
          ? task
          : undefined;
      };
      for (const [id, task] of pendingTasks) if (!validTask(id)) cancelEntity(task.entity);
      const admitCompletedBuoyancyOutputs = () => {
        for (const output of solver?.drain() ?? []) {
          const task = validTask(output.taskId);
          const participant = task && participants.get(task.entity);
          if (
            !task ||
            !participant ||
            output.entity !== task.entity ||
            output.entityGeneration !== task.generation ||
            output.snapshotHash !== task.snapshotHash ||
            output.sourceStep !== task.sourceStep ||
            output.solveStep !== task.solveStep ||
            output.completedStep !== task.solveStep
          ) {
            pendingTasks.delete(output.taskId);
            continue;
          }
          if (!participant.timeline.admit(output))
            throw new Error('Water async output timeline reached its bounded capacity');
          state.async = { ...state.async, completed: state.async.completed + 1 };
        }
      };
      admitCompletedBuoyancyOutputs();
      const physicsResultsTimeSeconds = physics.getSolverClock?.().resultsTimeSeconds;
      // Water consumes the source's external physics-frame cutoff, including zero-delta continuations.
      const resultsTimeSeconds =
        physicsResultsTimeSeconds === undefined
          ? undefined
          : physicsResultsTimeSeconds + world.getResource(Time).delta;
      if (resultsTimeSeconds !== undefined) state.async = { ...state.async, resultsTimeSeconds };
      const selectCompletedBuoyancyOutputs = () => {
        for (const [entity, participant] of participants) {
          if (resultsTimeSeconds === undefined) continue;
          const previousTaskId = participant.selection?.current?.taskId;
          participant.selection = participant.timeline.select(resultsTimeSeconds);
          for (const consumed of participant.selection.consumed) {
            const task = validTask(consumed.taskId);
            if (!task) continue;
            const result = decodeWaterSolverOutput(consumed);
            if (result.ok) completed.push({ entity, step: result.value, synchronous: false });
            if (consumed.taskId !== participant.selection.current?.taskId)
              pendingTasks.delete(consumed.taskId);
          }
          if (
            previousTaskId !== undefined &&
            previousTaskId !== participant.selection.current?.taskId
          )
            pendingTasks.delete(previousTaskId);
          if (participant.selection.current) {
            const result = decodeWaterSolverOutput(participant.selection.current);
            state.steps = Object.freeze([
              ...state.steps.filter((step) => step.entity !== entity),
              { entity, result },
            ]);
            if (result.ok) retainCurrentWetState(participant, result.value);
          }
        }
      };
      selectCompletedBuoyancyOutputs();
      const retainedCurrent = [...participants.values()].filter(
        (participant) => participant.selection?.current !== undefined,
      ).length;
      state.async = {
        ...state.async,
        pending: pendingTasks.size - retainedCurrent,
        selections: Object.freeze(
          [...participants].flatMap(([entity, participant]) => {
            const selection = participant.selection;
            return selection
              ? [
                  {
                    entity,
                    ...(selection.current
                      ? {
                          currentTaskId: selection.current.taskId,
                          sourceStep: selection.current.sourceStep,
                          solveStep: selection.current.solveStep,
                          referenceTimeSeconds: selection.current.referenceTimeSeconds,
                          outputTimestampSeconds: selection.current.outputTimestampSeconds,
                        }
                      : {}),
                    ...(selection.next ? { nextTaskId: selection.next.taskId } : {}),
                    alpha: selection.alpha,
                  },
                ]
              : [];
          }),
        ),
      };
      state.forceEvents = Object.freeze(
        state.steps.flatMap((step) => (step.result.ok ? [...step.result.value.forceEvents] : [])),
      );
      const collectCompletedBuoyancyEvents = () => {
        for (const { entity, step, synchronous } of completed) {
          const participant = participants.get(entity);
          if (!participant) continue;
          const dynamics = physics.getCommittedBodyDynamics?.(entity);
          if (
            !dynamics?.ok ||
            dynamics.value.generation !== step.rootGeneration ||
            dynamics.value.completedStep < step.physicsStep
          )
            continue;
          for (const event of step.splashWakeEvents) {
            if (
              event.bodyGuid !== undefined &&
              water.snapshot(event.bodyGuid)?.sceneGeneration !== event.bodyGeneration
            ) {
              participant.previous.delete(event.pontoonId);
              continue;
            }
            events.push(event);
          }
          if (synchronous) retainCurrentWetState(participant, step);
        }
      };
      collectCompletedBuoyancyEvents();
      const batchTimeSeconds = world.getResource(Time).elapsed;
      state.splashWakeEvents = Object.freeze([
        ...(batchTimeSeconds === splashWakeBatchTimeSeconds ? state.splashWakeEvents : []),
        ...events,
      ]);
      splashWakeBatchTimeSeconds = batchTimeSeconds;
    },
  });
  world.addSystem(FixedUpdate, waterBuoyancyCompletionSystem).unwrap();
  return () => {
    world.removeSystem(FixedUpdate, waterBuoyancySystem);
    world.removeSystem(FixedUpdate, waterBuoyancyCompletionSystem);
    world.removeResource(WATER_BUOYANCY_RESOURCE);
    for (const release of releaseProfileWork) release();
    water.retainOceanPatchQueryReceivers([]);
    for (const entity of participants.keys()) cancelEntity(entity);
    solver?.dispose();
    participants.clear();
  };
}
