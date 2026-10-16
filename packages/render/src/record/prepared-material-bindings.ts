import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { BindGroupEntry, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-rhi';
import { STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import {
  derive,
  type Handle,
  type MaterialAsset,
  type MaterialTextureValue,
  materialValuesToLinearRuntime,
  type SamplerAsset,
} from '@forgeax/engine-types';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import {
  assembleMaterialWithSkylightEntries,
  skylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  omittedStandardMaterialBindings,
  sharedMaterialBindingDeclarations,
  standardNormalInputField,
} from '../pbr-pipeline';
import type { RenderResourceScope } from '../publication/resource-scope';
import { internSharedRefFromGuid, materialStandardTextureMask } from '../render-system-extract';
import {
  applyParamSchemaDefaultsToUbo,
  applyParamSnapshotToUbo,
  defaultViewForUserRegionField,
  residentTextureView,
} from './main-pass-material';
import type { RenderSystemInternals } from './render-context';

export type PreparedResolverCaches = {
  readonly preparedPipelineIds: WeakMap<object, string>;
  readonly preparedMaterialPipelineShaders: WeakMap<object, string>;
  readonly preparedGroup0Pipelines: WeakSet<object>;
  readonly preparedViewOnlyPipelines: WeakSet<object>;
  readonly preparedRenderMaterialPipelines: WeakSet<object>;
};

export function createPreparedResolverCaches(): PreparedResolverCaches {
  return {
    preparedPipelineIds: new WeakMap(),
    preparedMaterialPipelineShaders: new WeakMap(),
    preparedGroup0Pipelines: new WeakSet(),
    preparedViewOnlyPipelines: new WeakSet(),
    preparedRenderMaterialPipelines: new WeakSet(),
  };
}

function preparedHandle<Brand extends string>(
  runtime: RenderSystemInternals,
  world: RenderResourceScope,
  guid: string,
  brand: Brand,
): Handle<Brand, 'shared'> | undefined {
  if ('resolveAsset' in world)
    return world.handleForGuid(guid) as Handle<Brand, 'shared'> | undefined;
  return internSharedRefFromGuid(world, runtime.assets, guid, brand);
}

export function preparedMaterialBindings(
  runtime: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
  materialShaderId: string,
  worldIndex: number,
  materialGuid: string,
  layout: BindGroupLayout,
  skylightResources?: SkylightBindGroupResources,
) {
  const world = worlds[worldIndex];
  const handle =
    world === undefined ? undefined : preparedHandle(runtime, world, materialGuid, 'MaterialAsset');
  const pipelineState = runtime.getPipelineState();
  if (world === undefined || handle === undefined || pipelineState === null) {
    return err(new Error('prepared material asset is unavailable'));
  }
  const resolved = resolveAssetHandle<MaterialAsset>(world, handle);
  if (!resolved.ok) return resolved;
  const material = resolved.value;
  if (material.kind !== 'material') return err(new Error('prepared material asset is unavailable'));
  const schema = runtime.getParamSchema?.(materialShaderId) ?? [];
  // Feature materials share the ordinary linear parameter domain and semantic texture defaults.
  const values = materialValuesToLinearRuntime(
    material.values,
    [...schema, ...(material.parameters ?? [])],
    material.colorSpace,
  );
  const derived = derive(schema);
  const fields = [...derived.textureFieldNames];
  let buffer: Buffer | undefined;
  let payloadByteLength = 0;
  if (derived.uboLayout.totalBytes > 0) {
    const payload = new Uint8Array(Math.max(16, derived.uboLayout.totalBytes));
    applyParamSchemaDefaultsToUbo(payload, schema);
    applyParamSnapshotToUbo(
      payload,
      schema,
      values as Readonly<Record<string, number | readonly number[]>>,
    );
    const created = runtime.device.createBuffer({
      label: `prepared-material:${materialGuid}`,
      size: payload.byteLength,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) return created;
    buffer = created.value;
    payloadByteLength = payload.byteLength;
    const written = runtime.device.queue.writeBuffer(buffer, 0, payload);
    if (!written.ok) {
      runtime.device.destroyBuffer(buffer);
      return written;
    }
  }
  const textureResources: Array<{
    sampler: import('@forgeax/engine-rhi').Sampler;
    view: import('@forgeax/engine-rhi').TextureView;
  }> = [];
  const textureMask = materialStandardTextureMask(material.parameters, materialShaderId, values);
  for (const slot of fields) {
    const field = standardNormalInputField(slot, textureMask);
    const value = values[field];
    const textureValue =
      typeof value === 'object' && value !== null && 'texture' in value
        ? (value as MaterialTextureValue)
        : undefined;
    let sampler = pipelineState.defaultSampler;
    if (textureValue?.sampler !== undefined) {
      const handle = preparedHandle(runtime, world, String(textureValue.sampler), 'SamplerAsset');
      if (handle !== undefined) {
        const asset = resolveAssetHandle<SamplerAsset>(world, handle);
        if (asset.ok) {
          const resident = runtime.gpuStore.ensureSamplerResident(handle, asset.value, world);
          if (resident.ok) sampler = resident.value;
        }
      }
    }
    let view = defaultViewForUserRegionField(field, pipelineState, schema);
    if (textureValue !== undefined) {
      const handle = preparedHandle(runtime, world, String(textureValue.texture), 'TextureAsset');
      if (handle !== undefined) {
        view = residentTextureView(world, runtime.gpuStore, runtime, handle) ?? view;
      }
    }
    textureResources.push({ sampler, view });
  }
  const entries: BindGroupEntry[] = [];
  let textureIndex = 0;
  for (let index = 0; index < derived.bglEntries.length; index += 1) {
    const expected = derived.bglEntries[index];
    if (expected?.buffer?.type === 'uniform' && buffer !== undefined) {
      entries.push({
        binding: expected.binding,
        resource: { kind: 'buffer', value: { buffer, size: payloadByteLength } },
      });
      continue;
    }
    const textureResource = textureResources[textureIndex];
    if (
      expected?.sampler?.type === 'filtering' &&
      derived.bglEntries[index + 1]?.texture !== undefined &&
      textureResource !== undefined
    ) {
      entries.push({
        binding: expected.binding,
        resource: { kind: 'sampler', value: textureResource.sampler },
      });
      continue;
    }
    if (expected?.texture !== undefined && textureResource !== undefined) {
      entries.push({
        binding: expected.binding,
        resource: { kind: 'textureView', value: textureResource.view },
      });
      textureIndex += 1;
      continue;
    }
    if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
    return err(new Error('prepared material schema contains unsupported binding kinds'));
  }
  const fallback = pipelineState.skylightFallback;
  if (fallback === null) {
    if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
    return err(new Error('prepared material skylight fallback is unavailable'));
  }
  const omitted = omittedStandardMaterialBindings(
    fields,
    transmissionBackdropAvailable(runtime.device.limits.maxSampledTexturesPerShaderStage),
    isStandardPbrMaterialShader(materialShaderId),
    isCanonicalStandardPbrMaterialShader(materialShaderId),
    sharedMaterialBindingDeclarations(runtime.shaderRegistry, materialShaderId),
  );
  const completeEntries = assembleMaterialWithSkylightEntries(
    entries,
    skylightResources ?? skylightBindGroupResources(fallback),
    transmissionBackdropAvailable(runtime.device.limits.maxSampledTexturesPerShaderStage)
      ? undefined
      : null,
  ).filter((entry) => !omitted.has(entry.binding));
  if (materialUsesDirectDfgLut(schema)) {
    const lut = getOrCreateDirectDfgLut(runtime.device, runtime.deviceScope);
    if (!lut.ok) {
      if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
      return lut;
    }
    completeEntries.push({
      binding: STANDARD_DIRECT_DFG_LUT_BINDING,
      resource: { kind: 'textureView', value: lut.value.view },
    });
  }
  // Per-shader PBR layouts reserve the scene-material SSBO at binding 46 on
  // storage-capable devices. Prepared feature materials use this same layout,
  // so they must provide the neutral producer-owned table even when their
  // authored shader does not read it. Omitting the entry makes Dawn reject the
  // bind group before submission.
  if (runtime.device.caps.storageBuffer) {
    completeEntries.push({
      binding: 46,
      resource: {
        kind: 'buffer',
        value: { buffer: meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer },
      },
    });
  }
  const group = runtime.device.createBindGroup({ layout, entries: completeEntries });
  if (!group.ok) {
    if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
    return group;
  }
  if (buffer === undefined) return group;
  return ok({
    handle: group.value,
    dynamicOffsets: [0],
    release: () => runtime.device.destroyBuffer(buffer),
  });
}
