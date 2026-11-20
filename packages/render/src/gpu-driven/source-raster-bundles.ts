import {
  type BindGroup,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { MaterialResource } from '../material-resource';
import type { ScenePipelineDemand } from '../record/scene-pipeline-preparation';
import type { GpuDrivenDrawPhase } from '../render-pipeline';
import type { PreparedRasterCounters, PreparedRasterPassCache } from './prepared-raster-bundle';
import { rasterClassFor, selectRasterPipeline } from './production-raster-classes';
import {
  IndirectPassBindings,
  preparedVisibleWindows,
  rasterMaterialOffset,
} from './production-raster-encode';
import type { ProjectedRasterGraph, RasterProjectionFrame } from './production-raster-frame';
import { captureRasterMeshBinding } from './raster-mesh-bindings';

export interface SourceRasterPassBindings {
  readonly demand: ScenePipelineDemand;
  readonly view: BindGroup;
  readonly materials: ReadonlyMap<
    MaterialResource,
    ReadonlyMap<string, { readonly group: BindGroup; readonly byteOffset: number }>
  >;
  readonly cluster: BindGroup | undefined;
}

export function rasterPassKey(
  filter: string | undefined,
  fragment: string | undefined,
  coverage: boolean,
  phase: GpuDrivenDrawPhase,
  seeded: boolean,
  viewOffset = 0,
  opaqueDepthPrimed = false,
): string {
  return `${filter ?? ''}/${fragment ?? ''}/${coverage ? 1 : 0}/${phase}/${viewOffset}/${opaqueDepthPrimed ? 1 : 0}${seeded ? '/seeded' : ''}`;
}

/** Record actual native indirect commands through the ordinary command/bundle owner; no render pass executes. */
export function* prepareSourceRasterBundles(
  frame: RasterProjectionFrame,
  projected: ProjectedRasterGraph,
  device: RhiDevice,
  passes: PreparedRasterPassCache,
  input: SourceRasterPassBindings,
  current: () => boolean,
  receipts: (() => boolean)[],
): Generator<void, Result<void, RhiError>> {
  const { demand } = input;
  if (!demand.pass.gpu) return ok(undefined);
  const invalid = () =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'current original GPU Pass native command preparation',
        hint: 'prepare its actual bindings and physical native resources before display',
      }),
    );
  const descriptor = demand.bundleDescriptor;
  const indirect = frame.view.indirectBuffer;
  if (descriptor === undefined || indirect === undefined || !current()) return invalid();
  const phase = demand.gpuPhase;
  if (phase === undefined) return invalid();
  const region = phase === 'late' ? projected.lateRegion : undefined;
  if (phase === 'late' && region === undefined) return invalid();
  const pass = passes.prepare(
    rasterPassKey(
      demand.pass.gpuFilter,
      demand.gpuFragmentEntryPoint,
      demand.coverageOnly,
      phase,
      demand.seededDepth === true,
      0,
      demand.opaqueDepthPrimed === true,
    ),
    descriptor,
  );
  const counters: PreparedRasterCounters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
  const bindings = new IndirectPassBindings(undefined, input.view, descriptor, pass, 0, {
    current,
    receipts,
  });
  bindings.indirect = indirect;
  const scope = { frame, projected, device, input, current, bindings, phase, region, counters };
  for (const live of frame.liveRasterBatches) {
    const prepared = prepareSourceBundleBatch(scope, live);
    if (!prepared.ok) return prepared;
    yield;
  }
  bindings.finish();
  return current() && receipts.every((receipt) => receipt()) ? ok(undefined) : invalid();
}

interface SourceBundleScope {
  readonly frame: RasterProjectionFrame;
  readonly projected: ProjectedRasterGraph;
  readonly device: RhiDevice;
  readonly input: SourceRasterPassBindings;
  readonly current: () => boolean;
  readonly counters: PreparedRasterCounters;
  readonly bindings: IndirectPassBindings;
  readonly phase: GpuDrivenDrawPhase;
  readonly region: ProjectedRasterGraph['lateRegion'];
}
function prepareSourceBundleBatch(
  scope: SourceBundleScope,
  live: import('./live-raster').LiveRasterBatch,
): Result<void, RhiError> {
  const { frame, projected, device, input, current, bindings, phase, region, counters } = scope;
  const { demand } = input;
  const invalid = () =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'current original native batch command inputs',
        hint: 'prepare the actual Pass bindings before display',
      }),
    );
  if (!current()) return invalid();
  const batch = rasterClassFor(
    projected.rasterClasses,
    true,
    live,
    demand.pass.gpuFilter,
    demand.gpuFragmentEntryPoint,
    demand.coverageOnly,
  );
  if (batch === undefined) return ok(undefined);
  const material = live.batch.binding?.material;
  const binding =
    material === undefined
      ? undefined
      : input.materials.get(material)?.get(live.materialBindingClass);
  if (binding === undefined) return ok(undefined);
  const pipeline = selectRasterPipeline(
    batch,
    demand.gpuFragmentEntryPoint,
    demand.coverageOnly,
    demand.seededDepth === true,
  )(
    demand.formats,
    demand.formats.join(','),
    false,
    demand.sampleCount,
    demand.opaqueDepthPrimed === true,
  );
  if (!pipeline.ok) return pipeline;
  const mesh = batch.clustered
    ? input.cluster
    : batch.raster
        .sceneMeshBindGroup(
          frame.scene.scene.transformBuffer,
          frame.scene.scene.transformByteLength,
          frame.view.skinTaskBinding(),
        )
        .unwrap();
  if (mesh === undefined) return invalid();
  bindings.bindPipeline(pipeline.value);
  bindings.bindMaterial(binding.group, rasterMaterialOffset(batch, binding.byteOffset));
  bindings.bindMesh(mesh, batch.deformation, frame.view);
  captureRasterMeshBinding(live.meshBinding);
  if (!current()) return invalid();
  bindings.bindRecordedGeometry(live.meshBinding, live.mesh.indexFormat);
  const windows = preparedVisibleWindows(
    live,
    batch,
    phase === 'late' ? 'late' : 'early',
    region?.visibleBase ?? 0,
  );
  bindings.recordBundle(
    live,
    windows,
    (region?.indirectByteOffset ?? 0) + live.batch.indirectOffset,
    frame.view,
    device,
    counters,
  );

  return ok(undefined);
}
