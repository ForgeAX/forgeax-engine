// Inspection receipts and advanced billboard/topology state of the GPU particle feature.

import type { RenderFeatureSubmission } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import type {
  ParticleRendererSourceV3,
  ParticleTopologyRendererSourceV3,
} from '@forgeax/engine-vfx';
import type { VfxStagePlanObservation } from './stage-plan.js';

type ParticleRendererKind = ParticleRendererSourceV3['kind'];
type ParticleTopologyKind = ParticleTopologyRendererSourceV3['kind'];
type VfxStageOutput = VfxStagePlanObservation['stageOutput'];

interface VfxRenderStageState {
  readonly stageOutput: VfxStageOutput;
}

interface VfxRenderInspectSnapshot extends VfxRenderStageState {
  readonly topology: ParticleRendererKind;
  readonly counters: {
    readonly capacity: number;
    readonly produced: number;
    readonly dropped: number;
  };
  readonly stageReadiness: readonly unknown[];
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

export interface VfxRenderInspectInput {
  readonly topology: ParticleRendererKind;
  readonly capacity: number;
  readonly produced: number;
  readonly dropped: number;
  readonly stageReadiness: readonly unknown[];
  readonly stageOutput?: VfxStageOutput;
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

/** Bounded receipt of VFX work that reached render-graph submission. */
export interface VfxRenderObservation {
  readonly frameNumber: number;
  readonly dispatches: number;
  readonly indirectDraws: number;
  readonly subjectOutputs: number;
}

export function createVfxRenderInspectSnapshot(
  input: VfxRenderInspectInput,
): VfxRenderInspectSnapshot {
  return {
    topology: input.topology,
    counters: { capacity: input.capacity, produced: input.produced, dropped: input.dropped },
    stageReadiness: input.stageReadiness,
    stageOutput: input.stageOutput ?? 'empty',
    providerReadiness: input.providerReadiness,
    gpuTiming: input.gpuTiming,
  } as const;
}

export interface BillboardAdvancedSample {
  readonly age: number;
  readonly lifetime: number;
  readonly particleDepth: number;
  readonly sceneDepth: number;
  readonly depthAvailable: boolean;
}

export function resolveBillboardAdvancedState(
  renderer: Extract<ParticleRendererSourceV3, { readonly kind: 'billboard' }>,
  sample: BillboardAdvancedSample,
) {
  if (renderer.softParticle !== undefined && !sample.depthAvailable) {
    return err({
      code: 'vfx-renderer-depth-missing' as const,
      expected: 'a scene-depth provider for soft particles',
      hint: 'attach the scene-depth data interface or disable soft particles',
      detail: { path: 'renderer.softParticle' },
    });
  }
  const sheet = renderer.textureSheet;
  const frameCount = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
  const frameIndex =
    sheet === undefined || sheet.frameRate === 0
      ? 0
      : Math.min(
          frameCount - 1,
          Math.max(0, Math.floor(Math.max(0, sample.age) * sheet.frameRate)),
        );
  const softParticleFade =
    renderer.softParticle === undefined || sample.sceneDepth <= 0
      ? 1
      : Math.max(
          0,
          Math.min(
            1,
            (sample.particleDepth - sample.sceneDepth) / renderer.softParticle.fadeDistance,
          ),
        );
  return ok({
    frameIndex,
    pivot: renderer.pivot ?? ([0, 0] as const),
    softParticleFade,
    sortingKey:
      renderer.sorting === 'view-depth' || renderer.sorting === 'view-distance'
        ? sample.particleDepth
        : 0,
  });
}

export function topologyRecoveryHint(
  topology: ParticleTopologyKind,
  reason: 'capacity' | 'broken' | 'degenerate' | 'device',
): string {
  if (reason === 'capacity')
    return `${topology} capacity overflow was bounded; increase its explicit capacity`;
  if (reason === 'broken')
    return `${topology} continuity broke; inspect its explicit source key and keep the last valid segment`;
  if (reason === 'degenerate')
    return `${topology} produced no drawable segment; preserve zero output and inspect source endpoints`;
  return `${topology} device resources recovered from the last known good generation`;
}

/** Receipt of the VFX work one submitted frame actually executed. */
export function submittedObservation(
  frameNumber: number,
  submission: RenderFeatureSubmission,
): VfxRenderObservation {
  let dispatches = 0;
  let indirectDraws = 0;
  let subjectOutputs = 0;
  for (const work of submission.works)
    for (const pass of work.passes) {
      dispatches += pass.resolvedGpuCompute?.dispatches.length ?? 0;
      if (pass.shadowCaster === true || pass.graphics === undefined) continue;
      subjectOutputs += pass.graphics.draws.length;
      for (const draw of pass.graphics.draws)
        if (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect')
          indirectDraws += 1;
    }
  return Object.freeze({ frameNumber, dispatches, indirectDraws, subjectOutputs });
}
