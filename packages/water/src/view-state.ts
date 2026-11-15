import { vec3 } from '@forgeax/engine-math';
import type { PhysicsSweepError, PhysicsWorld, SphereSweepHit } from '@forgeax/engine-physics';
import {
  err,
  ok,
  type Result,
  WATER_UNDERWATER_POST_PROCESS_DEFAULTS,
} from '@forgeax/engine-types';
import {
  type Vec3,
  type WaterBodySnapshot,
  type WaterError,
  WaterQueryFlags,
  type WaterQueryInput,
  type WaterQueryResult,
} from './contracts.js';
import { prepareWaterBodyWaves, type WaterBodyWavePreparation } from './waves.js';

export type WaterIntersection = 'none' | 'underwater' | 'possibly-intersecting';
const OUTSIDE_WATER_DEPTH_M = -0.01;
/** First Physics membership/filter group maps the default WorldStatic water trace channel. */
export const WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK = 0x0001_0001;
export type WaterViewRejection =
  | 'not-water'
  | 'not-rendered'
  | 'missing-post-process'
  | 'query-failed'
  | 'excluded'
  | 'lower-surface'
  | 'outside-tolerance';
export type WaterViewError = Readonly<{
  code: 'water-view-input-invalid' | 'water-view-sweep-unavailable' | 'water-view-sweep-failed';
  expected: string;
  hint: string;
  detail: Readonly<{ field: string; cause?: PhysicsSweepError }>;
}>;
export interface WaterViewInput {
  readonly viewId: string;
  readonly traceGeneration: number;
  readonly positionM: Vec3;
  readonly timeSeconds: number;
  /** Length of the selected view near-plane corner in its camera XY plane. */
  readonly nearPlaneCornerDistanceM: number;
  readonly postProcessEnabled?: boolean;
}
export interface WaterViewCandidate {
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly colliderId: number;
  readonly hasWaves: boolean;
  readonly overlapMaterialPriority: number;
  readonly outcome: 'selected' | 'accepted' | WaterViewRejection;
  readonly query?: WaterQueryResult;
  readonly queryError?: WaterError;
}
/** Independent consumers share one selection receipt, never one underwater boolean. */
export interface WaterViewState {
  readonly viewId: string;
  readonly traceGeneration: number;
  readonly sceneGeneration: number;
  readonly trace: Readonly<{
    coarse: readonly SphereSweepHit[];
    precise: readonly SphereSweepHit[];
    usedPrecise: boolean;
  }>;
  readonly candidates: readonly WaterViewCandidate[];
  readonly selectedBody?: string;
  readonly selectedBodyGeneration?: number;
  readonly intersection: WaterIntersection;
  readonly visualPpActive: boolean;
  readonly immersionDepthM: number;
  readonly audioUnderwater: boolean;
  readonly postProcess?: Readonly<{
    materialGuid: string;
    enabled: boolean;
    priority: number;
    blendRadiusM: number;
    blendWeight: number;
  }>;
}
export interface WaterViewAudioTransition {
  readonly viewId: string;
  readonly traceGeneration: number;
  readonly underwater: boolean;
  readonly immersionDepthM: number;
}
export interface WaterViewSelectionInput {
  readonly view: WaterViewInput;
  readonly sceneGeneration: number;
  readonly bodies: readonly WaterBodySnapshot[];
  readonly collisionFilterMask: number;
  readonly isBodyRendered?: (body: WaterBodySnapshot) => boolean;
  readonly physics: Pick<PhysicsWorld, 'sweepSphereAll'> | undefined;
  readonly queryBody: (
    bodyGuid: string,
    query: WaterQueryInput,
  ) => Result<WaterQueryResult, WaterError>;
}

/** UE WaterSubsystem view selection, expressed in engine meters and Y-up. */
export function selectWaterView(
  input: WaterViewSelectionInput,
): Result<WaterViewState, WaterViewError> {
  return selectPreparedWaterView(input);
}

/** Internal Admitted Body route. */
export function selectPreparedWaterView(
  input: WaterViewSelectionInput,
  prepareWaves?: (body: WaterBodySnapshot) => WaterBodyWavePreparation | undefined,
): Result<WaterViewState, WaterViewError> {
  const view = input.view;
  if (invalidWaterCollisionFilter(input.collisionFilterMask))
    return err({
      code: 'water-view-input-invalid',
      expected: 'a packed unsigned 32-bit Physics collision filter',
      hint: 'configure the WaterSystem underwater trace membership and filter groups',
      detail: { field: 'collisionFilterMask' },
    });
  if (invalidWaterSelectionView(view))
    return err({
      code: 'water-view-input-invalid',
      expected:
        'a generation-qualified view with finite meter position, time and near-plane corner distance',
      hint: 'supply the selected camera projection and current frame generation',
      detail: { field: 'view' },
    });
  const empty = (): WaterViewState =>
    Object.freeze({
      viewId: view.viewId,
      traceGeneration: view.traceGeneration,
      sceneGeneration: input.sceneGeneration,
      trace: Object.freeze({
        coarse: Object.freeze([]),
        precise: Object.freeze([]),
        usedPrecise: false,
      }),
      candidates: Object.freeze([]),
      intersection: 'none',
      visualPpActive: false,
      immersionDepthM: OUTSIDE_WATER_DEPTH_M,
      audioUnderwater: false,
    });
  if (view.postProcessEnabled === false || input.bodies.length === 0) return ok(empty());
  if (input.physics?.sweepSphereAll === undefined)
    return err({
      code: 'water-view-sweep-unavailable',
      expected: 'the scene PhysicsWorld supports native all-hit sphere sweeps',
      hint: 'attach the 3D physics backend and enable Body collision on the selected query channel',
      detail: { field: 'PhysicsWorld.sweepSphereAll' },
    });
  const start = view.positionM;
  const sweepStart = vec3.clone(start);
  const sweepEnd = vec3.create(start[0], start[1] + 1, start[2]);
  const coarse = input.physics.sweepSphereAll(sweepStart, sweepEnd, 1, input.collisionFilterMask);
  if (!coarse.ok)
    return err({
      code: 'water-view-sweep-failed',
      expected: coarse.error.expected,
      hint: coarse.error.hint,
      detail: { field: 'coarse', cause: coarse.error },
    });
  const bodiesByEntity = new Map(
    input.bodies.flatMap((body) =>
      body.instanceEntity === undefined ? [] : [[body.instanceEntity, body] as const],
    ),
  );
  const waterCoarse = coarse.value.filter((hit) => bodiesByEntity.has(hit.entity));
  const usedPrecise = waterCoarse.some((hit) => {
    const height = hit.point[1];
    return height !== undefined && height > start[1] - 0.01;
  });
  const precise = usedPrecise
    ? input.physics.sweepSphereAll(sweepStart, sweepStart, 0.1, input.collisionFilterMask)
    : ok<readonly SphereSweepHit[]>([]);
  if (!precise.ok)
    return err({
      code: 'water-view-sweep-failed',
      expected: precise.error.expected,
      hint: precise.error.hint,
      detail: { field: 'precise', cause: precise.error },
    });
  const hits = (usedPrecise ? precise.value : waterCoarse).flatMap((hit) => {
    const body = bodiesByEntity.get(hit.entity);
    return body === undefined ? [] : [{ hit, body }];
  });
  const hasWaves = new Map(
    input.bodies.map((body) => {
      const prepared = prepareWaves?.(body) ?? prepareWaterBodyWaves(body);
      const dependency = prepared.dependency;
      return [
        body.guid,
        body.asset.type !== 'river' &&
          dependency?.status === 'valid' &&
          dependency.kind === 'water-wave-set' &&
          prepared.cooked?.ok === true,
      ] as const;
    }),
  );
  if (!usedPrecise)
    hits.sort((a, b) => {
      return (
        Number(hasWaves.get(b.body.guid)) - Number(hasWaves.get(a.body.guid)) ||
        b.body.asset.overlapPriority - a.body.asset.overlapPriority
      );
    });
  const candidates: WaterViewCandidate[] = [];
  const accepted: {
    readonly body: WaterBodySnapshot;
    readonly candidate: WaterViewCandidate & { readonly query: WaterQueryResult };
    readonly materialGuid: string;
    readonly index: number;
  }[] = [];
  const seen = new Set<string>();
  let maximumSurfaceM = -Infinity;
  let intersection: WaterIntersection = 'none';
  let selected:
    | { body: WaterBodySnapshot; query: WaterQueryResult; materialGuid: string }
    | undefined;
  function collectQueriedWaterViewCandidate(
    body: WaterBodySnapshot,
    diagnostic: {
      bodyGuid: string;
      bodyGeneration: number;
      colliderId: number;
      hasWaves: boolean;
      overlapMaterialPriority: number;
    },
  ): void {
    const materialGuid = body.asset.underwaterPostProcessMaterialGuid;
    if (materialGuid === undefined) {
      candidates.push({ ...diagnostic, outcome: 'missing-post-process' });
      return;
    }
    const query = input.queryBody(body.guid, {
      positionM: start,
      timeSeconds: view.timeSeconds,
      expectedBodyGeneration: body.sceneGeneration,
      flags:
        WaterQueryFlags.ComputeImmersionDepth |
        WaterQueryFlags.ComputeLocation |
        WaterQueryFlags.IncludeWaves,
    });
    if (!query.ok) {
      candidates.push({ ...diagnostic, outcome: 'query-failed', queryError: query.error });
      return;
    }
    const sample = query.value;
    if (sample.excluded) {
      candidates.push({ ...diagnostic, outcome: 'excluded', query: sample });
      return;
    }
    const surface = sample.surfaceM ?? sample.locationM;
    if (
      surface === undefined ||
      sample.immersionM === undefined ||
      !sample.valid.has('immersion')
    ) {
      candidates.push({ ...diagnostic, outcome: 'query-failed', query: sample });
      return;
    }
    const maxWaveHeightM = sample.waveInfo?.maxHeightM ?? 0;
    const planeY = surface[1] - (sample.waveInfo?.heightM ?? 0);
    const surfaceMaximum = planeY + maxWaveHeightM;
    if (surfaceMaximum <= maximumSurfaceM) {
      candidates.push({ ...diagnostic, outcome: 'lower-surface', query: sample });
      return;
    }
    maximumSurfaceM = surfaceMaximum;
    const candidate = { ...diagnostic, outcome: 'accepted' as const, query: sample };
    accepted.push({ body, candidate, materialGuid, index: candidates.length });
    candidates.push(candidate);
  }
  function collectWaterViewCandidates(): void {
    for (const { hit, body } of hits) {
      if (seen.has(body.guid)) continue;
      seen.add(body.guid);
      const diagnostic = {
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        colliderId: hit.colliderId,
        hasWaves: hasWaves.get(body.guid) === true,
        overlapMaterialPriority: body.asset.overlapPriority,
      };
      if (body.asset.renderOptions?.visible === false || input.isBodyRendered?.(body) === false) {
        candidates.push({ ...diagnostic, outcome: 'not-rendered' });
        continue;
      }
      collectQueriedWaterViewCandidate(body, diagnostic);
    }
  }
  collectWaterViewCandidates();
  function selectWaterPostProcessCandidate(): void {
    for (const { body, candidate, materialGuid, index } of accepted) {
      const sample = candidate.query;
      const surface = sample.surfaceM ?? sample.locationM;
      const immersionM = sample.immersionM;
      if (surface === undefined || immersionM === undefined) continue;
      const maxWaveHeightM = sample.waveInfo?.maxHeightM ?? 0;
      const planeY = surface[1] - (sample.waveInfo?.heightM ?? 0);
      const immersionWithoutWaves = planeY - start[1];
      if (Math.abs(immersionWithoutWaves) - view.nearPlaneCornerDistanceM <= maxWaveHeightM)
        intersection = 'possibly-intersecting';
      else if (
        immersionWithoutWaves - view.nearPlaneCornerDistanceM > maxWaveHeightM &&
        intersection !== 'possibly-intersecting'
      )
        intersection = 'underwater';
      const toleranceY = Math.max(maxWaveHeightM, (sample.waveInfo?.attenuation ?? 1) * 0.1);
      const ppEligible =
        immersionM >= 0 ||
        (Math.abs(surface[0] - start[0]) <= 0.1 &&
          Math.abs(surface[2] - start[2]) <= 0.1 &&
          Math.abs(surface[1] - start[1]) <= toleranceY);
      if (ppEligible) {
        selected = { body, query: sample, materialGuid };
        candidates[index] = { ...candidate, outcome: 'selected' };
        break;
      }
      candidates[index] = { ...candidate, outcome: 'outside-tolerance' };
    }
  }
  selectWaterPostProcessCandidate();
  const settings = selected?.body.asset.underwaterSettings;
  const immersionDepthM = Math.max(
    selected?.query.immersionM ?? OUTSIDE_WATER_DEPTH_M,
    OUTSIDE_WATER_DEPTH_M,
  );
  const defaults = WATER_UNDERWATER_POST_PROCESS_DEFAULTS;
  const selectedPostProcessIsActive = (): boolean => {
    const visualPpActive =
      selected !== undefined &&
      (settings?.enabled ?? defaults.enabled) &&
      (settings?.blendWeight ?? defaults.blendWeight) > 0;
    return visualPpActive;
  };
  const visualPpActive = selectedPostProcessIsActive();
  return ok(
    Object.freeze({
      ...empty(),
      trace: Object.freeze({ coarse: coarse.value, precise: precise.value, usedPrecise }),
      candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
      intersection,
      visualPpActive,
      immersionDepthM,
      audioUnderwater: immersionDepthM > 0,
      ...(selected === undefined
        ? {}
        : {
            selectedBody: selected.body.guid,
            selectedBodyGeneration: selected.body.sceneGeneration,
            postProcess: Object.freeze({
              materialGuid: selected.materialGuid,
              enabled: settings?.enabled ?? defaults.enabled,
              priority: settings?.priority ?? defaults.priority,
              blendRadiusM: settings?.blendRadiusM ?? defaults.blendRadiusM,
              blendWeight: settings?.blendWeight ?? defaults.blendWeight,
            }),
          }),
    }),
  );
}

function invalidWaterSelectionView(view: WaterViewInput): boolean {
  return (
    !view.viewId ||
    !Number.isSafeInteger(view.traceGeneration) ||
    view.traceGeneration < 0 ||
    view.positionM.length !== 3 ||
    !view.positionM.every(Number.isFinite) ||
    !Number.isFinite(view.timeSeconds) ||
    !Number.isFinite(view.nearPlaneCornerDistanceM) ||
    view.nearPlaneCornerDistanceM < 0
  );
}

function invalidWaterCollisionFilter(collisionFilterMask: number): boolean {
  return (
    !Number.isInteger(collisionFilterMask) ||
    collisionFilterMask < 0 ||
    collisionFilterMask > 0xffff_ffff
  );
}
