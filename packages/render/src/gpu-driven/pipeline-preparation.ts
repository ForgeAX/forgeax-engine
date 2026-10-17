import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import type { RenderSystemInternals } from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { FramePresentationPendingReason } from '../render-contract';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import { eligibleGpuDrivenDraws } from './batch-topology';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import { requestMaterialAbiRasterPipeline } from './production-raster-material';

const isSingleLayerMediumArtifact = (artifact: MaterialShaderArtifact) =>
  artifact.receipt?.surface?.model === 'single-layer-medium';

/** Only explicitly requested hidden rows; admission and PSO specification are shared with real raster. */
export function prepareHiddenGpuDrivenPipelines(input: {
  readonly entries: readonly ValidatedRenderable[];
  readonly artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  readonly factory: NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
  readonly formats: readonly TextureFormat[];
  readonly sampleCount: 1 | 4;
  readonly shaderUvSetCount: number;
  readonly filter: RenderPipelineGpuDrivenFilter | undefined;
  readonly fragmentEntry: string | undefined;
  readonly coverageOnly: boolean;
  readonly visibleSurface: boolean;
  /** The same admitted source draw belongs to this pass's indirect lane. */
  readonly onSelected?: (entry: ValidatedRenderable, sourceDrawIndex: number) => void;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}): boolean {
  let ready = true;
  for (const entry of input.entries) {
    if (entry.source.authorVisible !== false) continue;
    for (const draw of eligibleGpuDrivenDraws(entry.source)) {
      const prepared = draw.prepared;
      if (prepared === undefined) continue;
      const material = entry.source.materials[draw.key.materialSlot] ?? entry.source.material;
      const artifactKey =
        capturedPreparedMaterialArtifactKey(prepared) ??
        gpuDrivenMaterialArtifactKey({
          material: prepared.identity.material,
          deformation: prepared.identity.deformation,
          receiptIdentity: prepared.receiptIdentity,
          receiptGeneration: prepared.receiptGeneration,
        });
      const artifact = input.artifacts?.get(artifactKey);
      if (artifact === undefined) {
        ready = false;
        input.onPending?.({
          code: 'scene-pipeline-preparation',
          worldId: entry.source.worldId,
          entity: entry.source.entityKey,
          pass: (input.fragmentEntry ?? input.filter ?? 'forward').slice(0, 256),
        });
        continue;
      }
      const medium = isSingleLayerMediumArtifact(artifact),
        filter = input.filter;
      if (
        (filter === 'single-layer-medium' && !medium) ||
        ((filter === 'opaque' ||
          filter === 'deferred-opaque' ||
          filter === 'forward-only-opaque') &&
          medium) ||
        (filter === 'deferred-opaque' && material.deferredPass !== true) ||
        (filter === 'forward-only-opaque' && material.deferredPass === true)
      )
        continue;
      input.onSelected?.(entry, draw.sourceDrawIndex);
      const fragment =
        input.fragmentEntry === 'fs_gbuffer' &&
        prepared.identity.deformation === 'skin' &&
        input.visibleSurface
          ? SKIN_UNCOVERED_GBUFFER_ENTRY
          : input.fragmentEntry;
      const selectedArtifact =
        fragment === undefined
          ? artifact
          : {
              ...artifact,
              fragmentEntry: fragment,
              ...(fragment === 'fs_temporal' ? { vertexEntry: 'vs_temporal' } : {}),
              ...(input.coverageOnly
                ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
                : {}),
            };
      const request = requestMaterialAbiRasterPipeline(input.factory, {
        artifact: selectedArtifact,
        deformation: prepared.identity.deformation,
        format: input.formats[0] ?? 'rgba16float',
        sampleCount: input.sampleCount,
        layoutProjection: entry.mesh.layoutProjection,
        shaderUvSetCount: input.shaderUvSetCount,
        topology: draw.key.topology,
        stripIndexFormat:
          draw.key.drawKind === 'indexed' &&
          (draw.key.topology === 'triangle-strip' || draw.key.topology === 'line-strip')
            ? entry.mesh.indexFormat
            : undefined,
        renderState:
          fragment === 'fs_temporal'
            ? geometryRenderStateForPass(material.renderState, 'temporal', input.coverageOnly)
            : material.renderState,
        additionalColorFormats: input.formats.slice(1),
        standardTextureMask: material.standardTextureMask,
        forwardColorPass: fragment === undefined || fragment === STANDARD_OPAQUE_FRAGMENT_ENTRY,
      });
      if (request === null) {
        ready = false;
        input.onPending?.({
          code: 'scene-pipeline-preparation',
          worldId: entry.source.worldId,
          entity: entry.source.entityKey,
          pass: (fragment ?? input.filter ?? 'forward').slice(0, 256),
          shader: selectedArtifact.material.slice(0, 256),
        });
      }
    }
  }
  return ready;
}
