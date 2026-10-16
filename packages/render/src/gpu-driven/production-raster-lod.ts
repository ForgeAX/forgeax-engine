import { mat4, vec3 } from '@forgeax/engine-math';
import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import { type RecordProfileRunner, runRecordProfilePhase } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { lodDraws, selectLod } from '../scene/visibility/lod-selector';
import {
  batchLodLevelCount,
  type GpuDrivenBatch,
  type GpuDrivenBatchLod,
  projectedHeightForCandidate,
  type SubmissionPlan,
} from './batch-topology';

/** LOD0 is always resident; lower levels need a physical range in the current mesh. */
export function lodLevelReady(lod: GpuDrivenBatchLod | undefined, level: number): boolean {
  return level === 0 || lod?.ranges?.[level - 1] !== undefined;
}

export function selectedLodLevel(
  lod: GpuDrivenBatchLod | undefined,
  projectedHeight: number,
): number {
  const coverages = lod?.coverages;
  if (coverages === undefined || coverages.length <= 1) return 0;
  return selectLod({
    levels: coverages.slice(1).map((screenCoverage) => ({ screenCoverage })),
    projectedHeight,
    previousLevel: 0,
    hysteresis: lod?.hysteresis ?? 0.08,
    ready: coverages.map((_, level) => lodLevelReady(lod, level)),
    historyValid: false,
  }).level;
}

/** Indirect raster commands of admitted batches: one per LOD level slot. */
export function admittedRasterBatchCount(plan: SubmissionPlan): number {
  return plan.batches.reduce(
    (count, batch) => count + (batch.visibleCapacity > 0 ? batchLodLevelCount(batch) : 0),
    0,
  );
}

export function gpuDrawEntityCount(drawKeys: ReadonlySet<string>): number {
  const entities = new Set<string>();
  for (const key of drawKeys) {
    const separator = key.indexOf(':');
    if (separator > 0) entities.add(key.slice(0, separator));
  }
  return entities.size;
}

/** Only rigid Standard PBR shading reads the per-item LOD fade. */
export function lodCrossfadeCapable(batch: Pick<GpuDrivenBatch, 'prepared'>): boolean {
  return (
    isStandardPbrMaterialShader(batch.prepared?.identity.material) &&
    batch.prepared?.identity.deformation === 'rigid'
  );
}

/** Raster draws for one LOD owner at an explicit projected height. */
export function rasterLodDraws(
  batch: Pick<GpuDrivenBatch, 'prepared'>,
  lod: GpuDrivenBatchLod | undefined,
  projectedHeight: number,
) {
  if (!lodCrossfadeCapable(batch)) {
    return [{ level: selectedLodLevel(lod, projectedHeight), fade: 0 }];
  }
  const coverages = lod?.coverages ?? [1];
  return lodDraws({
    levels: coverages.slice(1).map((screenCoverage) => ({ screenCoverage })),
    projectedHeight,
    hysteresis: lod?.hysteresis ?? 0.08,
    ready: coverages.map((_, level) => lodLevelReady(lod, level)),
  });
}

export interface LodProjectionPlan {
  readonly groups: readonly {
    readonly source: GpuDrivenBatch;
    readonly primitiveIndex: number;
    readonly candidateCount: number;
  }[];
  readonly primitives: readonly number[];
}

/** CPU LOD inputs belong to the batch and primitive, independently of instance index. */
export function prepareLodProjectionPlan(source: SubmissionPlan): LodProjectionPlan {
  const groups: { source: GpuDrivenBatch; primitiveIndex: number; candidateCount: number }[] = [];
  const primitives = new Set<number>();
  for (const batch of source.batches) {
    if ((batch.lod?.coverages.length ?? 0) <= 1) continue;
    const byPrimitive = new Map<number, (typeof groups)[number]>();
    for (const candidate of batch.candidates) {
      const primitive = candidate.primitiveIndex;
      const group = byPrimitive.get(primitive);
      if (group !== undefined) group.candidateCount += 1;
      else {
        const next = { source: batch, primitiveIndex: primitive, candidateCount: 1 };
        byPrimitive.set(primitive, next);
        groups.push(next);
        primitives.add(primitive);
      }
    }
  }
  return {
    groups: Object.freeze(groups.map((group) => Object.freeze(group))),
    primitives: Object.freeze([...primitives]),
  };
}

export interface LodProjectionState {
  readonly selectionFingerprint: string;
  /** Selected raster levels per `prepared.lodPlan.groups` entry. */
  readonly selections: readonly (readonly number[])[];
  readonly projectedHeights?: ReadonlyMap<number, number>;
}

const NO_LOD_SELECTIONS: readonly (readonly number[])[] = Object.freeze([]);

/** Candidates whose selected levels differ between two selections of one prepared plan. */
export function lodSelectionChangeCount(
  previous: readonly (readonly number[])[],
  next: readonly (readonly number[])[],
  plan: LodProjectionPlan,
): number {
  if (previous.length !== next.length)
    return plan.groups.reduce((count, group) => count + group.candidateCount, 0);
  let changed = 0;
  for (let index = 0; index < next.length; index += 1) {
    const left = previous[index] as readonly number[];
    const right = next[index] as readonly number[];
    if (left.length !== right.length || left.some((level, at) => level !== right[at]))
      changed += plan.groups[index]?.candidateCount ?? 0;
  }
  return changed;
}

/**
 * Keep camera-dependent LOD payload separate from the filtered-plan identity.
 * The selected level remains structural because one indirect command owns one
 * geometry range; continuous height changes travel through the compact view
 * payload and do not rebuild an otherwise identical plan.
 */
export function lodProjectionState(
  prepared: { readonly lodPlan: LodProjectionPlan },
  camera: CameraSnapshot,
  slotAt: (primitiveIndex: number) => RenderSceneSlot | undefined,
  profile?: RecordProfileRunner,
): LodProjectionState {
  return runRecordProfilePhase(profile, 'record/gpu-driven-prepare/filter/lod', () => {
    if (prepared.lodPlan.groups.length === 0) {
      return { selectionFingerprint: '', selections: NO_LOD_SELECTIONS };
    }
    const projectedHeights = runRecordProfilePhase(
      profile,
      'record/gpu-driven-prepare/filter/lod/projection',
      () => {
        const heights = new Map<number, number>();
        for (const primitive of prepared.lodPlan.primitives) {
          const slot = slotAt(primitive);
          if (slot !== undefined) heights.set(primitive, projectedHeightForCandidate(slot, camera));
        }
        return heights;
      },
    );
    const selections = runRecordProfilePhase(
      profile,
      'record/gpu-driven-prepare/filter/lod/selection',
      () =>
        prepared.lodPlan.groups.map(({ source, primitiveIndex }) =>
          rasterLodDraws(
            source,
            source.lod,
            projectedHeights.get(primitiveIndex) ?? Number.NaN,
          ).map((draw) => draw.level),
        ),
    );
    const selectionFingerprint = runRecordProfilePhase(
      profile,
      'record/gpu-driven-prepare/filter/lod/identity',
      () => JSON.stringify(selections),
    );
    return { selectionFingerprint, selections, projectedHeights };
  });
}

/**
 * The LOD camera equivalent of a light view-projection, so shadow casters
 * rank by their footprint in the shadow target with the main camera's height
 * semantics. The clip-y row norm is `2 / orthoHeight` (orthographic) or
 * `1 / tan(fov / 2)` (perspective); a perspective eye is the point clip w
 * vanishes at, `M^-1 * (0, 0, 1, 0)`.
 */
export function lodViewCameraFromMatrix(
  matrix: Float32Array,
): Pick<CameraSnapshot, 'position' | 'projection' | 'fov' | 'orthoTop' | 'orthoBottom'> {
  const rowY = Math.hypot(matrix[1] ?? 0, matrix[5] ?? 0, matrix[9] ?? 0);
  const perspective = (matrix[3] ?? 0) !== 0 || (matrix[7] ?? 0) !== 0 || (matrix[11] ?? 0) !== 0;
  if (!perspective) {
    const half = rowY > 0 ? 1 / rowY : 0;
    return {
      position: vec3.create(),
      projection: 'orthographic',
      fov: 0,
      orthoTop: half,
      orthoBottom: -half,
    };
  }
  const inverse = mat4.invert(mat4.create(), matrix);
  const w = inverse[11] ?? 0;
  return {
    position: vec3.create((inverse[8] ?? 0) / w, (inverse[9] ?? 0) / w, (inverse[10] ?? 0) / w),
    projection: 'perspective',
    fov: rowY > 0 ? 2 * Math.atan(1 / rowY) : 0,
    orthoTop: 1,
    orthoBottom: -1,
  };
}

/**
 * Levels a shadow caster may be coarser than the main camera draws it. A
 * coarser silhouette would self-shadow the visible mesh with depth it does not
 * have, so the light-view height is floored at the height that selects this
 * bound.
 */
export const SHADOW_LOD_MAX_COARSER = 1;

/** Lowest shadow height that keeps the selection within the clamp of `mainLevel`. */
export function shadowLodHeightFloor(
  lod: Pick<GpuDrivenBatchLod, 'coverages' | 'hysteresis'> | undefined,
  mainLevel: number,
): number {
  const coverages = lod?.coverages;
  const bound = mainLevel + SHADOW_LOD_MAX_COARSER;
  const threshold = coverages?.[bound + 1];
  if (threshold === undefined) return 0;
  // Stay clear of the cross-fade band that would blend in the next level.
  return threshold * (1 + (lod?.hysteresis ?? 0.08));
}

/**
 * LOD projection of one shadow view: casters select by their footprint in the
 * light view-projection, never more than `SHADOW_LOD_MAX_COARSER` levels
 * coarser than `main` selects for the same candidate.
 */
export function shadowLodProjectionState(
  prepared: { readonly lodPlan: LodProjectionPlan },
  matrix: Float32Array,
  main: LodProjectionState,
  slotAt: (primitiveIndex: number) => RenderSceneSlot | undefined,
  profile?: RecordProfileRunner,
): LodProjectionState {
  return runRecordProfilePhase(
    profile,
    'record/gpu-driven-prepare/shadow-views/project-view/lod',
    () => {
      if (prepared.lodPlan.groups.length === 0) {
        return { selectionFingerprint: '', selections: NO_LOD_SELECTIONS };
      }
      const projectedHeights = new Map<number, number>();
      const heights = runRecordProfilePhase(
        profile,
        'record/gpu-driven-prepare/shadow-views/project-view/lod/projection',
        () => {
          const camera = lodViewCameraFromMatrix(matrix);
          const lightHeights = new Map<number, number>();
          for (const primitive of prepared.lodPlan.primitives) {
            const slot = slotAt(primitive);
            lightHeights.set(
              primitive,
              slot === undefined ? Number.NaN : projectedHeightForCandidate(slot, camera),
            );
          }
          return prepared.lodPlan.groups.map(({ source, primitiveIndex }, index) => {
            const light = lightHeights.get(primitiveIndex) ?? Number.NaN;
            const mainLevel = Math.min(...(main.selections[index] ?? [0]));
            const height = Number.isFinite(light)
              ? Math.max(light, shadowLodHeightFloor(source.lod, mainLevel))
              : Number.NaN;
            // Preserve the existing last-owner payload when batches share a primitive.
            projectedHeights.set(primitiveIndex, height);
            return height;
          });
        },
      );
      const selections = runRecordProfilePhase(
        profile,
        'record/gpu-driven-prepare/shadow-views/project-view/lod/selection',
        () =>
          prepared.lodPlan.groups.map(({ source }, index) =>
            rasterLodDraws(source, source.lod, heights[index] ?? Number.NaN).map(
              (draw) => draw.level,
            ),
          ),
      );
      const selectionFingerprint = runRecordProfilePhase(
        profile,
        'record/gpu-driven-prepare/shadow-views/project-view/lod/identity',
        () => JSON.stringify(selections),
      );
      return { selectionFingerprint, selections, projectedHeights };
    },
  );
}
