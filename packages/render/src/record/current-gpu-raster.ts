import type { RenderGraphBuilder, RenderGraphNativePass } from '@forgeax/engine-render-graph';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { addCurrentCameraOcclusion } from '../depth-pyramid/graph';
import type { CurrentCameraRaster } from '../gpu-driven/production-raster';
import type {
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineGpuDrivenTarget,
} from '../render-pipeline';
import type { RenderFrameState } from './frame-snapshot';

type Registration = Parameters<
  NonNullable<RenderPipelineGpuDrivenProjection['registerPipelinePreparation']>
>;

/** A camera's physical selection and raster stages. Only the GPU producer owns its tables.
 * A camera with no eligible geometry has no buffers or raster programs to resolve. */
export function currentGpuRaster(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineGpuDrivenTarget,
  state: Pick<RenderFrameState, 'gpuDrivenFrame' | 'surfaceSubmissionObservation' | 'frameNumber'>,
  retainIndirectBundles: boolean,
) {
  const registrations: Registration[] = [];
  let shape: string | undefined;
  let projected: CurrentCameraRaster | undefined;
  let stagedFrame: number | undefined;
  const observation = () => state.surfaceSubmissionObservation;
  const view = (source = state.gpuDrivenFrame?.prepared) => {
    const camera = source?.cameraView;
    if (camera === undefined) {
      projected = undefined;
      stagedFrame = undefined;
      shape = undefined;
    }
    return camera;
  };
  const raster = (): RenderPipelineGpuDrivenProjection | undefined => {
    const source = state.gpuDrivenFrame?.prepared;
    if (view(source) === undefined || source?.projectCamera === undefined) return undefined;
    if (stagedFrame === state.frameNumber) return projected;
    const key =
      source.cameraRasterIdentity ??
      source._recordingTopologySignature?.() ??
      source.topologySignature();
    if (shape !== key || projected === undefined) {
      const next = source.projectCamera(target).unwrap();
      for (const args of registrations) next.registerPipelinePreparation?.(...args);
      shape = key;
      projected = next;
    }
    projected.stageCameraClasses?.();
    stagedFrame = state.frameNumber;
    return projected;
  };
  const late = target.lateOcclusion === true;
  const skin: RenderGraphNativePass = {
    kind: 'compute',
    name: 'gpu-driven.skin-demand',
    encode(pass) {
      view()?.recordSkinDemand(pass);
    },
  };
  const select: RenderGraphNativePass = {
    kind: 'compute',
    name: 'gpu-driven.view-selection',
    encode(pass) {
      view()?.recordViewSelection(pass, late);
    },
  };
  const readback: RenderGraphNativePass = {
    kind: 'copy',
    name: 'gpu-driven.lod-selection-readback',
    encode(encoder) {
      view()?.recordSelectionReadback(encoder, late, observation);
    },
  };
  const added = graph.addSubgraphPass('camera-gpu-selection', {
    accesses: [],
    profilePasses: () => (late ? [skin, select] : [skin, select, readback]),
    executeIf: () => view() !== undefined,
    commandsDirect(_frame, _resources, issue, recording) {
      state.gpuDrivenFrame?.prepared?.captureCameraMeshes?.();
      if (view()?.hasSkinDemand) issue(recording, skin);
      issue(recording, select);
      if (!late) issue(recording, readback);
    },
  });
  if (!added.ok) return added;
  const projection: RenderPipelineGpuDrivenProjection = {
    accesses: [],
    ...(retainIndirectBundles ? { retainIndirectBundles: true } : {}),
    currentCameraWork: () => view() !== undefined,
    ...(late
      ? {
          recordCameraOcclusion: (builder, inputs) =>
            addCurrentCameraOcclusion(builder, inputs, view, readback),
        }
      : {}),
    registerPipelinePreparation(...args) {
      registrations.push(args);
      projected?.registerPipelinePreparation?.(...args);
    },
    preparePipelines: (...args) => raster()?.preparePipelines?.(...args) ?? true,
    *prepareSource(source, graphCurrent) {
      // Prospective draws belong to this Source. Its preparation can span many
      // active frames, each with a different set of camera material classes.
      if (source.projectCamera !== undefined && graphCurrent()) {
        const made = source.projectCamera(target);
        if (!made.ok)
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'the prospective camera raster classes',
              hint: made.error.message,
            }),
          );
        for (const args of registrations) made.value.registerPipelinePreparation?.(...args);
        const jobs = made.value.prepareSource?.(source, graphCurrent);
        if (jobs !== undefined) return yield* jobs;
      }
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'a GPU camera projection for the staged Source',
          hint: 'project its Scene input and prepare the actual view passes',
        }),
      );
    },
    hasWork: (filter, entry) => raster()?.hasWork(filter, entry) ?? false,
    encode: (group, pass, resources, frame, filter, entry, coverage, phase, seeded, offset) =>
      raster()?.encode(
        group,
        pass,
        resources,
        frame,
        filter,
        entry,
        coverage,
        phase,
        seeded,
        offset,
      ),
  };
  return ok(projection);
}
