import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import { gpuLanePreparesAsynchronously } from './batch-execution';
import type { LiveRasterBatch } from './live-raster';
import { prepareHiddenGpuDrivenPipelines } from './material-artifacts';
import {
  type ProjectedRasterClass,
  type RasterPipelineFor,
  selectRasterPipeline,
} from './production-raster-classes';
import type { PipelinePreparationJob, ProjectedRasterGraph } from './production-raster-frame';

/** Real consumer PSOs, retained by the compiled graph's preparation job map. */
export function registerRasterPipelinePreparation(
  projected: ProjectedRasterGraph,
  jobs: Map<string, PipelinePreparationJob>,
  factory: NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>,
  pass: {
    readonly formats: readonly TextureFormat[];
    readonly filter: RenderPipelineGpuDrivenFilter | undefined;
    readonly fragmentEntryPoint: string | undefined;
    readonly coverageOnly: boolean;
    readonly sampleCount: 1 | 4;
    readonly seededDepth: boolean;
    readonly opaqueDepthPrimed?: boolean;
  },
  liveBatches: () => readonly LiveRasterBatch[],
  classFor: (live: LiveRasterBatch) => ProjectedRasterClass | undefined,
): void {
  const {
    formats,
    filter,
    fragmentEntryPoint,
    coverageOnly,
    sampleCount,
    seededDepth,
    opaqueDepthPrimed = false,
  } = pass;
  const key = JSON.stringify([
    formats,
    filter,
    fragmentEntryPoint,
    coverageOnly,
    sampleCount,
    seededDepth,
    opaqueDepthPrimed,
  ]);
  if (jobs.has(key)) return;
  // Classes may join a compiled stock graph; select pipelines from the
  // current live batches whenever that set is replaced.
  let selectedFor: readonly LiveRasterBatch[] | undefined;
  const selected = new Map<RasterPipelineFor, MaterialShaderArtifact>();
  const select = (
    lives: readonly LiveRasterBatch[],
    target: Map<RasterPipelineFor, MaterialShaderArtifact>,
  ) => {
    target.clear();
    for (const live of lives) {
      const batch = classFor(live);
      if (batch !== undefined)
        target.set(
          selectRasterPipeline(batch, fragmentEntryPoint, coverageOnly, seededDepth),
          batch.artifact,
        );
    }
    return target;
  };
  const ordinarySelection = () => {
    const lives = liveBatches();
    if (selectedFor !== lives) {
      selectedFor = lives;
      select(lives, selected);
    }
    return selected;
  };
  ordinarySelection();
  const { frame } = projected;
  const ownedFormats = [...formats];
  const formatKey = ownedFormats.join(',');
  const request = (pipelineFor: RasterPipelineFor, artifact: MaterialShaderArtifact) =>
    pipelineFor(
      ownedFormats,
      formatKey,
      gpuLanePreparesAsynchronously(artifact),
      sampleCount,
      opaqueDepthPrimed,
    ).ok;
  jobs.set(key, {
    prepare(entries, artifacts, onPending, materials) {
      let ready = true;
      for (const [pipelineFor, artifact] of ordinarySelection())
        if (!request(pipelineFor, artifact)) {
          ready = false;
          onPending?.({
            code: 'scene-pipeline-preparation',
            pass: (fragmentEntryPoint ?? filter ?? 'forward').slice(0, 256),
            shader: artifact.material.slice(0, 256),
          });
        }
      const hiddenReady = prepareHiddenGpuDrivenPipelines({
        entries,
        artifacts,
        materials,
        resolve: frame.input.materialArtifactResolver,
        shaders: frame.input.materialShaderRegistry,
        factory,
        formats: ownedFormats,
        sampleCount,
        shaderUvSetCount: frame.materialPipelineState.standardPbrShaderUvSetCount,
        filter,
        fragmentEntry: fragmentEntryPoint,
        coverageOnly,
        seededDepth,
        opaqueDepthPrimed,
        visibleSurface: frame.input.visibleSurface !== undefined,
        viewClipping: frame.viewClippingLive,
        directionalShadowSimple: frame.input.directionalShadowSimple === true,
        leanLighting: frame.input.leanLighting === true,
        ...(onPending === undefined ? {} : { onPending }),
      });
      return ready && hiddenReady;
    },
    *sourceRequests(prospective) {
      // This selection belongs to the request iterator and is never retained by the graph.
      for (const [pipelineFor, artifact] of select(prospective, new Map()))
        yield () => request(pipelineFor, artifact);
    },
  });
}
