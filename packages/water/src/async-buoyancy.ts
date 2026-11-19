import type {
  PhysicsBodyDynamics,
  PhysicsSensorOverlaps,
  PhysicsSolverOutput,
  PhysicsSolverStepContext,
  PhysicsSolverTask,
} from '@forgeax/engine-physics';
import { PhysicsFixedError } from '@forgeax/engine-physics';
import { err, ok, type Result, sha256 } from '@forgeax/engine-types';
import {
  rotateWaterVector,
  stepWaterBuoyancy,
  type WaterBuoyancyCoefficientCache,
  type WaterBuoyancySettings,
  type WaterPontoon,
} from './buoyancy.js';
import type { WaterBodySnapshot } from './contracts.js';
import { queryWaterBodySnapshot, type WaterQueryBodySnapshot } from './query.js';
import { composeWaterQueryResidual, type WaterResidualQuerySource } from './query-residual.js';
import { decodeWaterSolverSnapshot, encodeWaterSolverResult } from './water-solver-codec.js';

export { decodeWaterSolverOutput } from './water-solver-codec.js';

export type WaterSolverBodySnapshot = Readonly<{
  entity: number;
  body: WaterQueryBodySnapshot;
  terrainEntities: readonly number[];
  groundGeneration: number;
  localResidual?: WaterResidualQuerySource;
}>;
export type WaterBuoyancySolverSnapshot = Readonly<{
  schema: 'forgeax-water-solver/3';
  nativePhysicsTimeSeconds: number | null;
  sourceDynamics: PhysicsBodyDynamics;
  overlaps: PhysicsSensorOverlaps;
  pontoons: readonly WaterPontoon[];
  coefficientResolution: ReturnType<WaterBuoyancyCoefficientCache['resolve']>;
  settings: WaterBuoyancySettings;
  bodies: readonly WaterSolverBodySnapshot[];
}>;
const encoder = new TextEncoder();

/** Only detached Water POD enters the worker; native world bytes travel through the backend separately. */
export function waterSolverBodySnapshot(
  body: WaterBodySnapshot,
  terrainEntities: readonly number[],
  groundGeneration: number,
  localResidual?: WaterResidualQuerySource,
): WaterSolverBodySnapshot {
  return {
    entity: body.instanceEntity ?? 0,
    groundGeneration,
    terrainEntities: [...terrainEntities],
    ...(localResidual ? { localResidual } : {}),
    body: {
      guid: body.guid,
      sceneGeneration: body.sceneGeneration,
      asset: body.asset,
      worldMatrixM: [...body.worldMatrixM],
      binding: body.binding,
      exclusionVolumes: [],
      dependencies: body.dependencies.filter((dependency) => dependency.field === 'waveSetGuid'),
    },
  };
}

export function encodeWaterSolverSnapshot(
  snapshot: WaterBuoyancySolverSnapshot,
): Readonly<{ payload: Uint8Array; snapshotHash: string }> {
  const json = JSON.stringify(snapshot);
  return { payload: encoder.encode(json), snapshotHash: sha256(json) };
}

/** Runs in the solver worker before native integration of this fixed step. */
export function processWaterBuoyancySolverTask(
  task: PhysicsSolverTask,
  context: PhysicsSolverStepContext,
): Result<Uint8Array, PhysicsFixedError> {
  const decoded = decodeWaterSolverSnapshot(task);
  if (!decoded.ok) return decoded;
  const snapshot = decoded.value;
  if (
    snapshot.sourceDynamics.entity !== task.entity ||
    snapshot.sourceDynamics.generation !== task.entityGeneration ||
    snapshot.sourceDynamics.completedStep !== task.sourceStep
  )
    return err(
      new PhysicsFixedError('fixed-step-stale', {
        entity: task.entity,
        reason: 'Water input identity does not match its admitted solver fence',
      }),
    );
  const dynamics = context.getBodyDynamics(task.entity);
  if (!dynamics.ok) return dynamics;
  const source = snapshot.sourceDynamics;
  const inverse = [
    -source.rotation[0],
    -source.rotation[1],
    -source.rotation[2],
    source.rotation[3],
  ] as const;
  const pontoons = snapshot.pontoons.map((pontoon) => {
    const local = rotateWaterVector(inverse, [
      pontoon.centerM[0] - source.positionM[0],
      pontoon.centerM[1] - source.positionM[1],
      pontoon.centerM[2] - source.positionM[2],
    ]);
    const relative = rotateWaterVector(dynamics.value.rotation, local);
    return {
      ...pontoon,
      centerM: [
        dynamics.value.positionM[0] + relative[0],
        dynamics.value.positionM[1] + relative[1],
        dynamics.value.positionM[2] + relative[2],
      ] as const,
    };
  });
  const result = stepWaterBuoyancy({
    solverSafe: true,
    dynamics: dynamics.value,
    overlaps: snapshot.overlaps,
    pontoons,
    coefficientResolution: snapshot.coefficientResolution,
    settings: snapshot.settings,
    fixedDeltaSeconds: context.deltaSeconds,
    fixedTimeSeconds: task.referenceTimeSeconds,
    nativePhysicsTimeSeconds: context.timestampSeconds,
    physics: {
      applyBodyForceAtPoint: context.applyForceAtPoint,
      applyBodyTorque: context.applyTorque,
    },
    resolveBody: (overlap) => {
      const captured = snapshot.bodies.find((body) => body.entity === overlap.entity);
      return captured
        ? ok(captured.body)
        : err(
            new PhysicsFixedError('fixed-step-stale', {
              entity: overlap.entity,
              reason: 'Water overlap is absent from the captured body roster',
            }),
          );
    },
    water: {
      queryBody: (guid, input) => {
        const captured = snapshot.bodies.find((body) => body.body.guid === guid);
        const heightM =
          captured && (captured.body.asset.type === 'lake' || captured.body.asset.type === 'ocean')
            ? context.traceTerrainDown(input.positionM, captured.terrainEntities, 1000)
            : undefined;
        const terrain =
          heightM === undefined || !captured || captured.body.binding.kind !== 'bound'
            ? undefined
            : {
                heightM,
                providerGuid: 'solver-static-collision-roster',
                providerVersion: captured.groundGeneration,
                zoneGeneration: captured.body.binding.zoneGeneration,
                groundGeneration: captured.groundGeneration,
              };
        const queried = queryWaterBodySnapshot(captured?.body, input, terrain, 'solver-safe');
        return queried.ok
          ? composeWaterQueryResidual(queried.value, input, captured?.localResidual)
          : queried;
      },
    },
  });
  return encodeWaterSolverResult(result, task.entity);
}

export type WaterAsyncOutputSelection = Readonly<{
  current?: PhysicsSolverOutput;
  next?: PhysicsSolverOutput;
  alpha: number;
  consumed: readonly PhysicsSolverOutput[];
}>;

/** Bounded latest/next selection with a copied current state. */
export class WaterAsyncOutputTimeline {
  private readonly pending: PhysicsSolverOutput[] = [];
  private current: PhysicsSolverOutput | undefined;
  constructor(readonly capacity = 64) {}
  clear(): void {
    this.pending.length = 0;
    this.current = undefined;
  }
  admit(output: PhysicsSolverOutput): boolean {
    if (
      !Number.isFinite(output.outputTimestampSeconds) ||
      this.pending.length >= this.capacity ||
      this.current?.taskId === output.taskId ||
      (this.current !== undefined &&
        output.outputTimestampSeconds < this.current.outputTimestampSeconds) ||
      this.pending.some((value) => value.taskId === output.taskId)
    )
      return false;
    this.pending.push(output);
    this.pending.sort(
      (a, b) => a.outputTimestampSeconds - b.outputTimestampSeconds || a.taskId - b.taskId,
    );
    return true;
  }
  select(resultsTimeSeconds: number): WaterAsyncOutputSelection {
    const consumed: PhysicsSolverOutput[] = [];
    while (this.pending[0] && this.pending[0].outputTimestampSeconds <= resultsTimeSeconds) {
      this.current = this.pending.shift();
      if (this.current) consumed.push(this.current);
    }
    const next = this.pending[0],
      current = this.current;
    const span = next && current ? next.outputTimestampSeconds - current.outputTimestampSeconds : 0;
    return {
      ...(current ? { current } : {}),
      ...(next ? { next } : {}),
      alpha:
        span > 1e-8 && current ? (resultsTimeSeconds - current.outputTimestampSeconds) / span : 0,
      consumed,
    };
  }
}
