import type { RenderPipeline } from '@forgeax/engine-rhi';
import {
  captureGeometrySource,
  GEOMETRY_OBSERVATION_MAX_MEMBERS,
  type GeometryCommandCapture,
  type GeometryGBufferProgram,
  type GeometrySourceIdentity,
} from '../geometry-observation';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { gbufferProgramDigest } from './gbuffer-order-diagnostic';
import type { LiveRasterBatch } from './live-raster';
import type { ProjectedRasterClass } from './production-raster-classes';
import type { BatchPreparation } from './production-raster-prepare';

/** Primary-view indirect commands captured for one requested geometry observation. */
export interface GpuGeometryCapture {
  commands: GeometryCommandCapture[];
  members: number;
  failure?: string;
  source: (
    slot: RenderSceneSlot,
  ) => Pick<GeometrySourceIdentity, 'worldIdentity' | 'meshGuid' | 'sourceKey' | 'sourceRevision'>;
}

/**
 * Join every candidate of a drawn batch to its current scene row and source
 * identity. Budget or generation failures stop the join and mark the capture.
 */
export function captureGeometrySources(
  capture: GpuGeometryCapture,
  forward: BatchPreparation['cached'],
  live: LiveRasterBatch,
): Map<number, GeometrySourceIdentity> {
  const sources = new Map<number, GeometrySourceIdentity>();
  const { batch } = live;
  for (const candidate of batch.candidates) {
    if (++capture.members > GEOMETRY_OBSERVATION_MAX_MEMBERS) {
      capture.failure = 'source-budget';
      break;
    }
    const slot = forward?.slotAt(candidate.primitiveIndex);
    const row = forward?.scene.instanceIndexForSlot(
      candidate.primitiveIndex,
      candidate.instanceOrdinal,
    );
    if (slot === undefined || slot.generation !== candidate.generation || row === undefined) {
      capture.failure = 'source-generation-mismatch';
      break;
    }
    const material = (slot.snapshot.materials[batch.key.materialSlot] ?? slot.snapshot.material)
      .snapshot;
    captureGeometrySource(sources, row, {
      ...capture.source(slot),
      entityKey: slot.entityKey,
      primitiveSlot: slot.slot,
      slotGeneration: slot.generation,
      meshHandle: slot.snapshot.assetHandle ?? 0,
      drawItemIndex: batch.binding?.drawItemIndex ?? candidate.drawItemIndex,
      materialSlot: batch.key.materialSlot,
      ...(material.materialHandle === undefined ? {} : { materialHandle: material.materialHandle }),
      ...(material.materialPublication === undefined
        ? {}
        : { materialPublication: material.materialPublication.identity }),
      instanceOrdinal: candidate.instanceOrdinal,
    });
  }
  return sources;
}

/** The selected G-buffer artifact and pipeline a captured command executed. */
export function gbufferGeometryProgram(
  batch: ProjectedRasterClass,
  visibleSurface: boolean,
  pipeline: RenderPipeline,
): GeometryGBufferProgram {
  const { artifact } = batch;
  const sourceDigest =
    batch.diagnosticSourceDigest ?? gbufferProgramDigest(artifact.program.source);
  batch.diagnosticSourceDigest = sourceDigest;
  return Object.freeze({
    scope: 'selected-gpu-driven-gbuffer-artifact' as const,
    material: artifact.material,
    pass: artifact.pass,
    programIdentity: artifact.program.identity,
    artifactSourceSha256: sourceDigest,
    specializationKey: artifact.specializationKey ?? null,
    layoutIdentity: artifact.layoutIdentity,
    receiptIdentity: artifact.receipt?.receiptIdentity ?? null,
    receiptGeneration: artifact.receipt?.generation ?? null,
    vertexEntry: batch.raster.diagnosticGBufferVertexEntry(artifact) ?? null,
    fragmentEntry:
      batch.deformation === 'skin' && visibleSurface ? SKIN_UNCOVERED_GBUFFER_ENTRY : 'fs_gbuffer',
    pipelineIdentity: getOpaqueResourceIdentity(pipeline as object),
    nativeShader: 'unobserved' as const,
  });
}
