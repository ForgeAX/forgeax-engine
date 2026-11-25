import {
  type BindGroup,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { viewForPipeline } from '../environment/bindings';
import type { MaterialResource } from '../material-resource';
import { standardPipelineMaterialLayoutIndex } from '../pbr-pipeline';
import { rasterMaterialOffset } from '../record/geometry-bind-offsets';
import type { ScenePipelineDemand } from '../record/scene-pipeline-preparation';
import { type PrimitiveReflection, primitiveForPipeline } from '../reflection/primitive-bindings';
import type { GpuDrivenDrawPhase } from '../render-pipeline';
import type { PreparedRasterCounters, PreparedRasterPassCache } from './prepared-raster-bundle';
import { rasterClassFor, selectRasterPipeline } from './production-raster-classes';
import { IndirectPassBindings, preparedVisibleWindows } from './production-raster-encode';
import type { ProjectedRasterGraph, RasterProjectionFrame } from './production-raster-frame';
import { captureRasterMeshBinding } from './raster-mesh-bindings';

export interface SourceRasterMaterialBinding {
  readonly group: BindGroup;
  readonly byteOffset: number;
  readonly dynamicOffsetCount?: 0 | 1;
  readonly reflection?: PrimitiveReflection;
}
export type SourceRasterMaterialResolver = (
  standardMaterialLayoutIndex: number,
  program: string,
) => SourceRasterMaterialBinding;
export interface SourceRasterPassBindings {
  readonly demand: ScenePipelineDemand;
  readonly view: BindGroup;
  readonly materials: ReadonlyMap<
    MaterialResource,
    ReadonlyMap<string, SourceRasterMaterialResolver>
  >;
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
  if (indirect === undefined || !current()) return invalid();
  const phase = demand.gpuPhase;
  if (phase === undefined) return invalid();
  const region = phase === 'late' ? projected.lateRegion : undefined;
  if (phase === 'late' && region === undefined) return invalid();
  const pass =
    descriptor === undefined
      ? undefined
      : passes.prepare(
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
  const bindings =
    descriptor === undefined
      ? undefined
      : new IndirectPassBindings(undefined, input.view, descriptor, pass, 0, {
          current,
          receipts,
        });
  if (bindings !== undefined) bindings.indirect = indirect;
  const scope = {
    frame,
    projected,
    device,
    input,
    current,
    bindings,
    phase,
    region,
    counters,
    formatKey: demand.formats.join(','),
  };
  for (const live of frame.liveRasterBatches) {
    const prepared = prepareSourceBundleBatch(scope, live);
    if (!prepared.ok) return prepared;
    yield;
  }
  bindings?.finish();
  return current() && receipts.every((receipt) => receipt()) ? ok(undefined) : invalid();
}

interface SourceBundleScope {
  readonly formatKey: string;
  readonly frame: RasterProjectionFrame;
  readonly projected: ProjectedRasterGraph;
  readonly device: RhiDevice;
  readonly input: SourceRasterPassBindings;
  readonly current: () => boolean;
  readonly counters: PreparedRasterCounters;
  readonly bindings: IndirectPassBindings | undefined;
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
  const materialBinding =
    material === undefined
      ? undefined
      : input.materials.get(material)?.get(live.materialBindingClass);
  if (materialBinding === undefined) return ok(undefined);
  const pipeline = selectRasterPipeline(
    batch,
    demand.gpuFragmentEntryPoint,
    demand.coverageOnly,
    demand.seededDepth === true,
  )(demand.formats, scope.formatKey, false, demand.sampleCount, demand.opaqueDepthPrimed === true);
  if (!pipeline.ok) return pipeline;
  const binding = materialBinding(
    standardPipelineMaterialLayoutIndex(pipeline.value),
    batch.artifact.specializationKey ?? batch.artifact.material,
  );
  const mesh = batch.raster.primitiveBindGroup(frame.view.skinTaskBinding()).unwrap();
  const primitive = primitiveForPipeline(device, pipeline.value, mesh, binding.reflection);
  const windows = preparedVisibleWindows(
    live,
    batch,
    phase === 'late' ? 'late' : 'early',
    region?.visibleBase ?? 0,
    pipeline.value,
  );
  // A directly encoded pass prepares its physical bindings, with no native command object to retain.
  if (bindings === undefined) {
    viewForPipeline(device, pipeline.value, input.view);
    return current() ? ok(undefined) : invalid();
  }
  bindings.bindPipeline(pipeline.value, device);
  bindings.bindMaterial(
    binding.group,
    rasterMaterialOffset(
      binding.byteOffset,
      binding.dynamicOffsetCount,
      batch.artifact.program.materialUniformRequired,
    ),
  );
  bindings.bindMesh(primitive, batch.deformation, frame.view);
  captureRasterMeshBinding(live.meshBinding);
  if (!current()) return invalid();
  bindings.bindRecordedGeometry(live.meshBinding, live.mesh.indexFormat);
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
