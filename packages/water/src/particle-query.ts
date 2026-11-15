import { err, ok, type Result } from '@forgeax/engine-types';
import { type Vec3, type WaterError, WaterQueryFlags, type WaterQueryResult } from './contracts.js';
import type { WaterSystem } from './system.js';

export type WaterParticleQueryError =
  | WaterError
  | Readonly<{
      code: 'water-gpu-particle-query-unsupported';
      expected: string;
      hint: string;
      detail: Readonly<{ simulation: 'gpu'; bodyGuid?: string }>;
    }>
  | Readonly<{
      code: 'water-particle-query-context-unavailable';
      expected: string;
      hint: string;
      detail: Readonly<{
        reason:
          | 'invalid-tick'
          | 'missing-tick'
          | 'tick-mismatch'
          | 'body-generation-mismatch'
          | 'system-depth-unavailable';
        requestedTick: number;
        acceptedTick?: number;
        bodyGuid?: string;
        bodyGeneration?: number;
      }>;
    }>;

export type WaterParticleSystemTick = Readonly<{
  tick: number;
  bodyGuid?: string;
  bodyGeneration?: number;
  systemPositionM: Vec3;
  timeSeconds: number;
  evaluateSystemDepth?: boolean;
  evaluateSystemDepthPerFrame?: boolean;
}>;
export type WaterParticleSystemDepth = Readonly<{
  bodyGuid: string;
  bodyGeneration: number;
  sourceTick: number;
  positionM: Vec3;
  timeSeconds: number;
  depthM: number;
  excluded: boolean;
  evaluated: boolean;
}>;

const contextError = (
  reason: Extract<
    WaterParticleQueryError,
    { code: 'water-particle-query-context-unavailable' }
  >['detail']['reason'],
  tick: WaterParticleSystemTick,
  acceptedTick?: number,
): WaterParticleQueryError => ({
  code: 'water-particle-query-context-unavailable',
  expected: 'the exact Body generation and completed CPU particle-system tick own the system depth',
  hint: 'tick this instance against its specified Body before querying its particles',
  detail: {
    reason,
    requestedTick: tick.tick,
    ...(acceptedTick === undefined ? {} : { acceptedTick }),
    ...(tick.bodyGuid === undefined ? {} : { bodyGuid: tick.bodyGuid }),
    ...(tick.bodyGeneration === undefined ? {} : { bodyGeneration: tick.bodyGeneration }),
  },
});

/** Explicit CPU instance lifetime. One system-position depth query serves all its particles. */
export class WaterParticleQueryInstance {
  private current: WaterParticleSystemTick | undefined;
  private depth: Result<WaterParticleSystemDepth | undefined, WaterParticleQueryError> =
    ok(undefined);

  tick(
    water: WaterSystem,
    input: WaterParticleSystemTick,
  ): Result<WaterParticleSystemDepth | undefined, WaterParticleQueryError> {
    if (
      !Number.isSafeInteger(input.tick) ||
      input.tick < 0 ||
      !Number.isFinite(input.timeSeconds) ||
      !input.systemPositionM.every(Number.isFinite)
    )
      return err(contextError('invalid-tick', input));
    const sameBody =
      this.current?.bodyGuid === input.bodyGuid &&
      this.current?.bodyGeneration === input.bodyGeneration;
    const retainsCurrentTick = (): boolean =>
      Boolean(
        sameBody &&
          this.current?.tick === input.tick &&
          this.current.timeSeconds === input.timeSeconds &&
          this.current.evaluateSystemDepth === input.evaluateSystemDepth &&
          this.current.evaluateSystemDepthPerFrame === input.evaluateSystemDepthPerFrame,
      );
    if (retainsCurrentTick()) return this.depth;
    const previous = sameBody && this.depth.ok ? this.depth.value : undefined;
    this.current = Object.freeze({
      ...input,
      systemPositionM: Object.freeze<Vec3>([...input.systemPositionM]),
    });
    this.depth = ok(undefined);
    if (input.bodyGuid === undefined || input.bodyGeneration === undefined) return this.depth;
    if (input.evaluateSystemDepth === false) {
      this.depth = ok(
        Object.freeze({
          bodyGuid: input.bodyGuid,
          bodyGeneration: input.bodyGeneration,
          sourceTick: input.tick,
          positionM: this.current.systemPositionM,
          timeSeconds: input.timeSeconds,
          depthM: 0,
          excluded: false,
          evaluated: false,
        }),
      );
      return this.depth;
    }
    if (input.evaluateSystemDepthPerFrame === false && previous?.evaluated === true) {
      this.depth = ok(previous);
      return this.depth;
    }
    const sample = water.queryBody(input.bodyGuid, {
      positionM: input.systemPositionM,
      timeSeconds: input.timeSeconds,
      expectedBodyGeneration: input.bodyGeneration,
      flags: WaterQueryFlags.ComputeDepth,
    });
    if (!sample.ok) {
      this.depth = sample;
      return sample;
    }
    this.depth = ok(
      Object.freeze({
        bodyGuid: sample.value.bodyGuid,
        bodyGeneration: sample.value.bodyGeneration,
        sourceTick: input.tick,
        positionM: this.current.systemPositionM,
        timeSeconds: input.timeSeconds,
        depthM: sample.value.excluded ? 0 : (sample.value.depthM ?? 0),
        excluded: sample.value.excluded,
        evaluated: true,
      }),
    );
    return this.depth;
  }

  systemDepth(
    request: WaterParticleSystemTick,
  ): Result<WaterParticleSystemDepth, WaterParticleQueryError> {
    if (this.current === undefined) return err(contextError('missing-tick', request));
    if (this.current.tick !== request.tick || this.current.timeSeconds !== request.timeSeconds)
      return err(contextError('tick-mismatch', request, this.current.tick));
    if (
      this.current.bodyGuid !== request.bodyGuid ||
      this.current.bodyGeneration !== request.bodyGeneration
    )
      return err(contextError('body-generation-mismatch', request, this.current.tick));
    if (!this.depth.ok) return this.depth;
    return this.depth.value === undefined
      ? err(contextError('system-depth-unavailable', request, this.current.tick))
      : ok(this.depth.value);
  }
}

export type WaterParticleQueryRequest = Readonly<{
  simulation: 'cpu' | 'gpu';
  instance: WaterParticleQueryInstance;
  tick: number;
  bodyGuid?: string;
  bodyGeneration?: number;
  positionM: Vec3;
  timeSeconds: number;
  executeQuery?: boolean;
  includeDepth?: boolean;
  includeWaves?: boolean;
  simpleWaves?: boolean;
  /** Engine adapter for the source depth-query CVar, whose default is system-instance. */
  depthQueryMode?: 'system-instance' | 'particle';
}>;
export type WaterParticleQueryResult = Readonly<{
  simulation: 'cpu';
  valid: boolean;
  requestedBodyGuid?: string;
  requestedBodyGeneration?: number;
  bodyGuid?: string;
  bodyGeneration?: number;
  tick: number;
  timeSeconds: number;
  queryFlags: number;
  surfacePositionM: Vec3;
  planePositionM: Vec3;
  planeNormalYUp: Vec3;
  waterVelocityMps: Vec3;
  waterDepthM: number;
  depthSource: 'disabled' | 'system-instance' | 'particle';
  excluded: boolean;
  sample?: WaterQueryResult;
  systemDepth?: WaterParticleSystemDepth;
}>;

/** Basic GetWaterSurfaceInfo pins. R2 owns all accepted geometry and query mathematics. */
export function queryWaterParticle(
  water: WaterSystem,
  request: WaterParticleQueryRequest,
): Result<WaterParticleQueryResult, WaterParticleQueryError> {
  if (request.simulation === 'gpu')
    return err({
      code: 'water-gpu-particle-query-unsupported',
      expected: 'the basic Water data interface runs on CPU particles',
      hint: 'use CPUSim; WaterInfo and local fluid RTs are independent visual producers',
      detail: {
        simulation: 'gpu',
        ...(request.bodyGuid === undefined ? {} : { bodyGuid: request.bodyGuid }),
      },
    });
  const base = {
    simulation: 'cpu' as const,
    tick: request.tick,
    timeSeconds: request.timeSeconds,
    ...(request.bodyGuid === undefined ? {} : { requestedBodyGuid: request.bodyGuid }),
    ...(request.bodyGeneration === undefined
      ? {}
      : { requestedBodyGeneration: request.bodyGeneration }),
  };
  if (
    request.executeQuery === false ||
    request.bodyGuid === undefined ||
    request.bodyGeneration === undefined
  )
    return ok(
      Object.freeze({
        ...base,
        valid: false,
        queryFlags: 0,
        surfacePositionM: [0, 0, 0] satisfies Vec3,
        planePositionM: [0, 0, 0] satisfies Vec3,
        planeNormalYUp: [0, 1, 0] satisfies Vec3,
        waterVelocityMps: [0, 0, 0] satisfies Vec3,
        waterDepthM: 0,
        depthSource: 'disabled',
        excluded: false,
      }),
    );
  const depthSource =
    request.includeDepth === false
      ? 'disabled'
      : request.depthQueryMode === 'particle'
        ? 'particle'
        : 'system-instance';
  const queryFlags = (): number => {
    let flags =
      WaterQueryFlags.ComputeLocation |
      WaterQueryFlags.ComputeNormal |
      WaterQueryFlags.ComputeVelocity;
    if (depthSource === 'particle') flags |= WaterQueryFlags.ComputeDepth;
    if (request.includeWaves !== false) {
      flags |= WaterQueryFlags.IncludeWaves;
      if (request.simpleWaves !== false) flags |= WaterQueryFlags.SimpleWaves;
    }
    return flags;
  };
  const flags = queryFlags();
  const sample = water.queryBody(request.bodyGuid, {
    positionM: request.positionM,
    flags,
    timeSeconds: request.timeSeconds,
    expectedBodyGeneration: request.bodyGeneration,
  });
  if (!sample.ok) return sample;
  const systemDepth =
    depthSource === 'system-instance'
      ? request.instance.systemDepth({
          tick: request.tick,
          timeSeconds: request.timeSeconds,
          bodyGuid: request.bodyGuid,
          bodyGeneration: request.bodyGeneration,
          systemPositionM: request.positionM,
        })
      : undefined;
  if (systemDepth !== undefined && !systemDepth.ok) return systemDepth;
  const queriedDepthM = (): number =>
    depthSource === 'disabled'
      ? 0
      : depthSource === 'particle'
        ? (sample.value.depthM ?? 0)
        : systemDepth?.ok
          ? systemDepth.value.depthM
          : 0;
  return ok(
    Object.freeze({
      ...base,
      valid: true,
      bodyGuid: sample.value.bodyGuid,
      bodyGeneration: sample.value.bodyGeneration,
      queryFlags: flags,
      surfacePositionM: sample.value.surfaceM ?? ([0, 0, 0] satisfies Vec3),
      planePositionM: sample.value.locationM ?? ([0, 0, 0] satisfies Vec3),
      planeNormalYUp: sample.value.planeNormalYUp ?? ([0, 1, 0] satisfies Vec3),
      waterVelocityMps: sample.value.velocityMPerSec ?? ([0, 0, 0] satisfies Vec3),
      waterDepthM: queriedDepthM(),
      depthSource,
      excluded: sample.value.excluded,
      sample: sample.value,
      ...(systemDepth?.ok ? { systemDepth: systemDepth.value } : {}),
    }),
  );
}
