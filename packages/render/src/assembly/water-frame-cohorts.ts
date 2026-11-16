import type { BindGroupLayout, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { WATER_BODY_DATA_STRIDE_BYTES } from '@forgeax/engine-water';
import type { RenderSystemInternals } from '../record/render-context';
import type { PipelineState } from '../render-system';
import {
  type waterInfoFramePublicationForRenderer,
  waterInfoMaterialBindingSnapshots,
} from '../water/water-info-feature';
import {
  buildWaterMaterialFrameUpload,
  createWaterMaterialFrameBindings,
  uploadWaterMaterialFrame,
  WATER_BODY_ONLY_BINDING_KEY,
  waterMaterialFrameBindingResources,
} from '../water/wave-material';
import type { WebGPURendererInternals } from './webgpu-renderer-bootstrap';
export function prepareWaterFrameBindingCohorts(
  publication: NonNullable<ReturnType<typeof waterInfoFramePublicationForRenderer>>,
  internals: WebGPURendererInternals,
  owner: object,
  waterMaterialFrameSamplers: WeakMap<object, import('@forgeax/engine-rhi').Sampler>,
  device: RhiDevice,
  waterInfoTextureViews: Map<string, TextureView>,
  waterMeshDraws: Map<string, import('../water/wave-material').WaterMeshInstanceDrawUpload>,
  input: Parameters<NonNullable<RenderSystemInternals['getWaterMaterialFrameBindings']>>[0],
  waterMaterialBuffers: (
    bindings: import('../water/wave-material').WaterMaterialFrameGpuBuffers,
  ) => import('@forgeax/engine-rhi').Buffer[],
  waterMaterialFrameLayout: (
    state: PipelineState,
    format: 'rgba16float' | 'rgba32float' | 'none',
  ) => BindGroupLayout | undefined,
  key: string,
  cached: ReturnType<
    NonNullable<
      ReturnType<
        Map<
          object,
          Map<
            string,
            {
              lifetime: 'active' | 'retiring' | 'destroyed';
              readonly viewIdentity: string;
              readonly frameGeneration: number;
              readonly deviceGeneration: number;
              readonly publication: NonNullable<
                ReturnType<typeof waterInfoFramePublicationForRenderer>
              >;
              readonly bindings: ReadonlyMap<
                string,
                import('../water/wave-material').WaterMaterialFrameBindings
              >;
              readonly waterMeshDraws: ReadonlyMap<
                string,
                import('../water/wave-material').WaterMeshInstanceDrawUpload
              >;
              readonly waterMeshDrawUploads: readonly import('../water/wave-material').WaterMeshInstanceDrawUpload[];
              readonly viewOriginM: readonly [number, number, number];
              readonly pipelineState: PipelineState;
              readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
            }
          >
        >['get']
      >
    >['get']
  >,
  entries: NonNullable<
    ReturnType<
      Map<
        object,
        Map<
          string,
          {
            lifetime: 'active' | 'retiring' | 'destroyed';
            readonly viewIdentity: string;
            readonly frameGeneration: number;
            readonly deviceGeneration: number;
            readonly publication: NonNullable<
              ReturnType<typeof waterInfoFramePublicationForRenderer>
            >;
            readonly bindings: ReadonlyMap<
              string,
              import('../water/wave-material').WaterMaterialFrameBindings
            >;
            readonly waterMeshDraws: ReadonlyMap<
              string,
              import('../water/wave-material').WaterMeshInstanceDrawUpload
            >;
            readonly waterMeshDrawUploads: readonly import('../water/wave-material').WaterMeshInstanceDrawUpload[];
            readonly viewOriginM: readonly [number, number, number];
            readonly pipelineState: PipelineState;
            readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
          }
        >
      >['get']
    >
  >,
  pipelineState: PipelineState,
) {
  const snapshots = waterInfoMaterialBindingSnapshots(publication);
  if (!snapshots.ok) {
    internals.errorRegistry.fire(snapshots.error);
    return undefined;
  }
  let sampler = waterMaterialFrameSamplers.get(owner);
  if (sampler === undefined) {
    const created = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    if (!created.ok) {
      internals.errorRegistry.fire(created.error);
      return undefined;
    }
    sampler = created.value;
    waterMaterialFrameSamplers.set(owner, sampler);
  }
  const nextBindings = new Map<
    string,
    import('../water/wave-material').WaterMaterialFrameBindings
  >();
  const createdBuffers: import('@forgeax/engine-rhi').Buffer[] = [];
  const destroyUploads = (): void => {
    for (const buffer of createdBuffers) device.destroyBuffer(buffer);
  };
  for (const snapshot of snapshots.value) {
    const target = snapshot.targets[0];
    const waterInfoTextureView =
      target === undefined ? undefined : waterInfoTextureViews.get(target.targetName);
    if (target !== undefined && waterInfoTextureView === undefined) continue;
    const descriptors = new Map([...snapshot.rows].map(([key, row]) => [key, row.descriptor]));
    const bodyTargetNames = new Map([...snapshot.rows].map(([key, row]) => [key, row.targetName]));
    const bodyTargetFormats = new Map(
      [...snapshot.rows].map(([key, row]) => [key, row.targetFormat]),
    );
    const cohortDraws = [...waterMeshDraws.values()].filter(
      (draw) =>
        snapshot.rows.has(draw.bodyGuid) &&
        draw.transitionTargets.every((peer) => snapshot.rows.has(peer.bodyGuid)),
    );
    let upload: ReturnType<typeof buildWaterMaterialFrameUpload>;
    try {
      upload = buildWaterMaterialFrameUpload(
        snapshot.waveUploadPlan,
        descriptors,
        cohortDraws,
        Number(device.limits.minStorageBufferOffsetAlignment ?? 256),
        input.viewOriginM,
      );
      const validateWaterFrameBufferRequirements = (
        upload: ReturnType<typeof buildWaterMaterialFrameUpload>,
      ) => {
        const maxBufferSize = Number(device.limits.maxBufferSize ?? 256 * 1024 * 1024);
        const maxStorageBindingSize = Number(
          device.limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024,
        );
        const maxUniformBindingSize = Number(device.limits.maxUniformBufferBindingSize ?? 65536);
        const bufferRequirements = [
          [
            'body data storage',
            upload.bodyData,
            WATER_BODY_DATA_STRIDE_BYTES,
            'storage',
            WATER_BODY_DATA_STRIDE_BYTES,
          ],
          ['wave data storage', upload.waveData, 48, 'storage', 48],
          ['WaterInfo descriptors uniform', upload.waterInfoDescriptors, 256, 'uniform', 48],
          ['draw data uniform', upload.drawData, 256, 'uniform', 16],
          [
            'WaterMesh tile storage',
            upload.waterMeshInstances.bytes,
            96,
            'storage',
            upload.waterMeshInstances.bindingSize,
          ],
          ['Baked descriptors storage', upload.bakedDescriptors, 48, 'storage', 48],
          ['Baked samples storage', upload.bakedSamples, 16, 'storage', 16],
        ] as const;
        for (const [label, bytes, minimumSize, kind, bindingSize] of bufferRequirements) {
          const bufferSize = Math.max(minimumSize, bytes.byteLength);
          const actualBindingSize =
            label === 'WaterMesh tile storage'
              ? bindingSize
              : kind === 'storage'
                ? bufferSize
                : bindingSize;
          const bindingLimit = kind === 'storage' ? maxStorageBindingSize : maxUniformBindingSize;
          if (bufferSize > maxBufferSize || actualBindingSize > bindingLimit)
            throw new RangeError(
              `${label} requires ${bufferSize} buffer bytes and a ${actualBindingSize}-byte binding; limits are ${maxBufferSize}/${bindingLimit}`,
            );
        }
      };
      validateWaterFrameBufferRequirements(upload);
    } catch (cause) {
      destroyUploads();
      internals.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected:
            'water frame buffers within device buffer and binding limits and one complete WaterInfo target cohort',
          hint: 'reduce the per-view water body, wave, Baked sample or WaterMesh draw data before upload',
          detail: {
            error: {
              code: 'water-material-frame-upload-invalid',
              message: cause instanceof Error ? cause.message : String(cause),
            },
          },
        }),
      );
      return undefined;
    }
    const uploaded = uploadWaterMaterialFrame(device, upload);
    if (!uploaded.ok) {
      destroyUploads();
      internals.errorRegistry.fire(uploaded.error);
      return undefined;
    }
    createdBuffers.push(...waterMaterialBuffers(uploaded.value));
    const layout = waterMaterialFrameLayout(pipelineState, target?.targetFormat ?? 'none');
    if (layout === undefined) {
      destroyUploads();
      return undefined;
    }
    const resources = waterMaterialFrameBindingResources({
      upload,
      buffers: uploaded.value,
      ...(target === undefined || waterInfoTextureView === undefined
        ? {}
        : {
            waterInfoContentFrameGeneration: target.contentFrameGeneration,
            waterInfoContentGraphResourceVersion: target.graphResourceVersion,
            waterInfoTextureView,
            waterInfoTargetName: target.targetName,
            waterInfoFormat: target.targetFormat,
            waterInfoSampler: sampler,
          }),
      bodyTargetNames,
      bodyTargetFormats,
      viewIdentity: input.viewIdentity,
      deviceGeneration: input.deviceGeneration,
      frameGeneration: input.frameGeneration,
    });
    const bound = createWaterMaterialFrameBindings(device, layout, resources);
    if (!bound.ok) {
      destroyUploads();
      internals.errorRegistry.fire(bound.error);
      return undefined;
    }
    nextBindings.set(target?.targetName ?? WATER_BODY_ONLY_BINDING_KEY, bound.value);
  }
  if (nextBindings.size === 0) {
    destroyUploads();
    return undefined;
  }
  entries.set(key, {
    lifetime: 'active',
    viewIdentity: input.viewIdentity,
    frameGeneration: input.frameGeneration,
    deviceGeneration: input.deviceGeneration,
    publication,
    bindings: nextBindings,
    waterMeshDraws,
    waterMeshDrawUploads: input.waterMeshDraws,
    viewOriginM: Object.freeze([...input.viewOriginM]) as readonly [number, number, number],
    pipelineState,
    retiredBuffers:
      cached === undefined
        ? []
        : [...cached.retiredBuffers, ...[...cached.bindings.values()].map(waterMaterialBuffers)],
  });
  return nextBindings;
}
