import { type BindGroup, type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import { gpuLanePreparesAsynchronously } from '../gpu-driven/batch-execution';
import type { PreparedRasterBindings } from '../gpu-driven/prepared-raster-bundle';
import type {
  NativeMainGraphPreparation,
  SourceShadowRow,
} from '../gpu-driven/source-raster-preparation';
import type { GpuDrivenViewCreationStep } from '../gpu-driven/view-gpu';
import { skylightBindGroupResources } from '../ibl/skylight-bind-group';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  buildPerSubmeshMaterialBg,
  type MaterialBindingAddress,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialUniformRecording } from '../record/material-uniforms';
import {
  MATERIAL_UNIFORM_BYTES,
  type PipelinePreparationCompletion,
} from '../record/render-context';
import {
  directionalShadowCasterOffset,
  spotShadowCasterOffset,
} from '../record/shadow-caster-uniforms';
import {
  assignShadowBatchBindings,
  ensureTypedShadowViewBg,
  prepareShadowSingletonMaterialBinding,
  prepareStaticShadowDepthClear,
  requestGpuDrivenShadowPipeline,
  shadowBatchOwnsMaterial,
  shadowsRecordDirectly,
} from '../record/shadow-pass';
import { pointShadowViewOffset } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare the actual Source shadow consumers before accepting',
  });
}

/** Reuses actual shadow factories and View command owners; no shadow update, compute or raster. */
export function* prepareSourceShadowBindings(
  owner: ViewSettlementOwner,
  source: RenderResourceScope,
  camera: CameraSnapshot,
  native: NativeMainGraphPreparation,
  current: () => boolean,
): Generator<
  GpuDrivenViewCreationStep,
  { readonly isCurrent: () => boolean; readonly release: () => void }
> {
  const { internals, frameState } = owner;
  const pipeline = recordContext(internals).getPipelineState();
  if (pipeline === null) throw invalid('the actual Source shadow pipeline state');
  const counts = { createBindGroup: 0, keys: [] as string[] },
    uniforms = new MaterialUniformRecording();
  const ports = {
    runtime: internals,
    frameState,
    pipelineState: pipeline,
    bindGroupCounts: counts,
    store: internals.gpuStore,
  };
  let issued = false;
  try {
    const rows = yield* native.shadowRows();
    const staticRow = rows.find((row) => row.identity.layer === 'static');
    if (staticRow !== undefined) {
      const clearCurrent = yield* prepareStaticShadowDepthClear(internals, current);
      native.holdShadow(staticRow, clearCurrent);
    }
    for (const row of rows) {
      const live = () => current() && row.isCurrent();
      if (!live()) throw invalid('current prospective shadow recipe');
      const view = shadowViewBinding(ports, row);
      if (view === null) throw invalid('the original typed shadow View binding');
      yield;
      const program = yield* prepareShadowProgram(owner, camera, row, live);
      const ownsMaterial = shadowBatchOwnsMaterial(row.batch, row.projection);
      const capture: NonNullable<MaterialBindingAddress['capture']> = { current: undefined };
      const material = shadowMaterialBinding(
        ports,
        source,
        native.materialBuffer,
        row,
        uniforms,
        ownsMaterial,
        capture,
      );
      const binding = capture.current;
      if (binding !== undefined && !binding())
        throw invalid('current source shadow material binding receipt');
      if (material === null || !live()) throw invalid('current original shadow material binding');
      const indirect = row.view.indirectBuffer;
      if (indirect === undefined) throw invalid('the original shadow indirect buffer');
      const observed: Partial<{
        -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
      }> = { view, viewOffset: 0, materialOffset: 0, indirect };
      const raster = assignShadowBatchBindings(
        row.view,
        row.batch,
        row.projection,
        program,
        material,
        observed,
        camera.clipping,
      );
      let commands: (() => boolean) | undefined;
      if (
        shadowsRecordDirectly(
          row.identity,
          internals.device.caps,
          internals.options?.retainIndirectBundles,
        )
      ) {
        commands = () => row.view.indirectBuffer === raster.indirect;
      } else {
        row.view.resolveShadowBundle(row.projection.bundles, raster, live);
        commands = row.view.shadowBundleCurrent(row.projection.bundles);
      }
      if (commands === undefined || !live()) throw invalid('completed native shadow command owner');
      native.holdShadow(row, () => commands() && (binding?.() ?? true));
      yield;
    }
    issued = true;
    return { isCurrent: () => native.isCurrent(), release: () => uniforms.complete() };
  } finally {
    if (!issued) uniforms.complete();
  }
}

type ShadowPorts = Parameters<typeof ensureTypedShadowViewBg>[0] & {
  readonly store: PerSubmeshMaterialBgDeps['store'];
};
function shadowViewBinding(ports: ShadowPorts, { identity }: SourceShadowRow): BindGroup | null {
  if (identity.kind === 'point') {
    if (identity.face === undefined) throw invalid('the original point shadow face');
    return ensureTypedShadowViewBg(
      ports,
      pointShadowViewOffset(identity.index, identity.face),
      0,
      `view-shadow-point-${identity.index}-${identity.face}`,
      true,
    );
  }
  return ensureTypedShadowViewBg(
    ports,
    0,
    identity.kind === 'directional'
      ? directionalShadowCasterOffset(identity.index)
      : spotShadowCasterOffset(identity.index),
    identity.kind === 'directional'
      ? `view-shadow-directional-${identity.index}`
      : `view-shadow-spot-${identity.index}`,
    true,
  );
}

function* prepareShadowProgram(
  owner: ViewSettlementOwner,
  camera: CameraSnapshot,
  row: SourceShadowRow,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep, RenderPipeline> {
  for (;;) {
    if (!current()) throw invalid('the actual current shadow program demand');
    let pipeline: RenderPipeline | null | undefined;
    const pending = new Set<PipelinePreparationCompletion>();
    const runtime = owner.internals;
    const prepare = () => {
      pipeline = requestGpuDrivenShadowPipeline(
        { runtime, camera },
        gpuLanePreparesAsynchronously(row.projection.shadowArtifact)
          ? runtime.prepareMaterialShaderPipeline
          : runtime.getMaterialShaderPipeline,
        row.projection,
        row.batch,
        row.identity.kind === 'point',
      );
    };
    if (owner.internals.withPipelinePreparationErrors === undefined) prepare();
    else
      owner.internals.withPipelinePreparationErrors(prepare, (completion) => {
        if (completion !== undefined) pending.add(completion);
      });
    if (pipeline != null) {
      if (!current()) throw invalid('the completed original shadow pipeline');
      return pipeline;
    }
    if (pending.size === 0) throw invalid('an actual pending shadow pipeline completion');
    yield Promise.all(pending).then((results) => {
      for (const result of results) result.unwrap();
    });
  }
}

function shadowMaterialBinding(
  ports: ShadowPorts,
  source: RenderResourceScope,
  sceneMaterialBuffer: PerSubmeshMaterialBgDeps['sceneMaterialBuffer'],
  row: SourceShadowRow,
  uniforms: MaterialUniformRecording,
  ownsMaterial: boolean,
  capture: NonNullable<MaterialBindingAddress['capture']>,
): BindGroup | null {
  if (sceneMaterialBuffer === undefined) throw invalid('the actual Scene material buffer');
  if (!ownsMaterial)
    return prepareShadowSingletonMaterialBinding(
      ports.runtime,
      ports.frameState,
      ports.pipelineState,
      sceneMaterialBuffer,
      ports.bindGroupCounts,
    );
  const fallback = ports.pipelineState.skylightFallback;
  if (fallback === null) throw invalid('the original shadow skylight fallback');
  const deps: PerSubmeshMaterialBgDeps = {
    runtime: ports.runtime,
    pipelineState: ports.pipelineState,
    world: source,
    store: ports.store,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: false,
    skylightResources: skylightBindGroupResources(fallback),
    materialBgAssemblyCache: ports.frameState.materialBgAssemblyCache,
    sceneMaterialBuffer,
    bindGroupCounts: ports.bindGroupCounts,
    frameState: ports.frameState,
  };
  const artifact = row.projection.shadowArtifact;
  const shader =
    artifact.material === SHADOW_CASTER_SHADER_ID
      ? 'forgeax::default-standard-pbr'
      : (artifact.specializationKey ?? artifact.material);
  return uniforms.runPrepared(() =>
    buildPerSubmeshMaterialBg(
      deps,
      row.projection.material,
      undefined,
      source,
      shader,
      0,
      undefined,
      0,
      undefined,
      { byteOffset: 0, dynamicOffsetCount: 1, capture },
    ),
  );
}
