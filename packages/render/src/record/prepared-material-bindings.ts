import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { BindGroup, BindGroupEntry, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
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

// A number marks an owned UBO slot until a miss creates its physical buffer.
type MaterialBindingEntry = BindGroupEntry | number;
const MATERIAL_UBO_PLACEHOLDER = {} as Buffer;

interface PreparedMaterialBindingRow {
  readonly device: RenderSystemInternals['device'];
  readonly generation: number;
  readonly world: RenderResourceScope;
  readonly layout: BindGroupLayout;
  readonly payload: Uint8Array | undefined;
  readonly entries: readonly MaterialBindingEntry[];
  readonly handle: BindGroup;
  readonly buffer: Buffer | undefined;
  references: number;
}

/** One resolver's outstanding material leases; never retained across frames. */
export type PreparedMaterialBindingsScope = PreparedMaterialBindingRow[];

function samePayload(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

function sameBindingEntry(left: MaterialBindingEntry, right: MaterialBindingEntry): boolean {
  if (typeof left === 'number' || typeof right === 'number') return left === right;
  if (left.binding !== right.binding || left.resource.kind !== right.resource.kind) return false;
  const resource = left.resource;
  const other = right.resource;
  if (resource.kind === 'buffer')
    return (
      other.kind === 'buffer' &&
      resource.value.buffer === other.value.buffer &&
      resource.value.offset === other.value.offset &&
      resource.value.size === other.value.size
    );
  return resource.value === other.value;
}

function acquireMaterialBinding(
  scope: PreparedMaterialBindingsScope,
  row: PreparedMaterialBindingRow,
) {
  row.references++;
  let released = false;
  return {
    handle: row.handle,
    ...(row.buffer === undefined ? {} : { dynamicOffsets: [0] }),
    release: () => {
      if (released) return ok(undefined);
      released = true;
      if (--row.references > 0) return ok(undefined);
      const index = scope.indexOf(row);
      if (index >= 0) scope.splice(index, 1);
      return row.buffer === undefined ? ok(undefined) : row.device.destroyBuffer(row.buffer);
    },
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

function unavailablePreparedMaterial(reason: string, worldIndex: number, materialGuid: string) {
  return err(
    new Error(
      `prepared material ${reason} (world=${worldIndex}, guid=${materialGuid.slice(0, 48)})`,
    ),
  );
}

export function preparedMaterialBindings(
  runtime: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
  materialShaderId: string,
  worldIndex: number,
  materialGuid: string,
  layout: BindGroupLayout,
  skylightResources?: SkylightBindGroupResources,
  scope?: PreparedMaterialBindingsScope,
  materialAssetHandle?: unknown,
) {
  const device = runtime.device;
  const generation = runtime.deviceScope?.generation ?? 0;
  const world = worlds[worldIndex];
  const handle =
    materialAssetHandle === undefined
      ? world === undefined
        ? undefined
        : preparedHandle(runtime, world, materialGuid, 'MaterialAsset')
      : typeof materialAssetHandle === 'number' &&
          Number.isSafeInteger(materialAssetHandle) &&
          materialAssetHandle >= 0
        ? (materialAssetHandle as Handle<'MaterialAsset', 'shared'>)
        : undefined;
  const pipelineState = runtime.getPipelineState();
  if (world === undefined)
    return unavailablePreparedMaterial('source-world-unavailable', worldIndex, materialGuid);
  if (handle === undefined)
    return unavailablePreparedMaterial(
      materialAssetHandle === undefined ? 'guid-handle-unavailable' : 'asset-handle-invalid',
      worldIndex,
      materialGuid,
    );
  if (pipelineState === null)
    return unavailablePreparedMaterial('pipeline-state-unavailable', worldIndex, materialGuid);
  const resolved = resolveAssetHandle<MaterialAsset>(world, handle);
  if (!resolved.ok) return resolved;
  const material = resolved.value;
  const kind = material.kind;
  if (kind !== 'material') {
    const label = typeof kind === 'string' ? (kind as string).slice(0, 24) : typeof kind;
    return unavailablePreparedMaterial(`asset-kind-mismatch:${label}`, worldIndex, materialGuid);
  }
  const schema = runtime.getParamSchema?.(materialShaderId) ?? [];
  // Feature materials share the ordinary linear parameter domain and semantic texture defaults.
  const values = materialValuesToLinearRuntime(
    material.values,
    [...schema, ...(material.parameters ?? [])],
    material.colorSpace,
  );
  const derived = derive(schema);
  const fields = [...derived.textureFieldNames];
  let payload: Uint8Array | undefined;
  if (derived.uboLayout.totalBytes > 0) {
    payload = new Uint8Array(Math.max(16, derived.uboLayout.totalBytes));
    applyParamSchemaDefaultsToUbo(payload, schema);
    applyParamSnapshotToUbo(
      payload,
      schema,
      values as Readonly<Record<string, number | readonly number[]>>,
    );
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
    if (expected?.buffer?.type === 'uniform' && payload !== undefined) {
      entries.push({
        binding: expected.binding,
        resource: {
          kind: 'buffer',
          value: { buffer: MATERIAL_UBO_PLACEHOLDER, size: payload.byteLength },
        },
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
    return err(new Error('prepared material schema contains unsupported binding kinds'));
  }
  const fallback = pipelineState.skylightFallback;
  if (fallback === null) {
    return err(new Error('prepared material skylight fallback is unavailable'));
  }
  const omitted = omittedStandardMaterialBindings(
    fields,
    transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage),
    isStandardPbrMaterialShader(materialShaderId),
    isCanonicalStandardPbrMaterialShader(materialShaderId),
    sharedMaterialBindingDeclarations(runtime.shaderRegistry, materialShaderId),
  );
  const completeEntries: MaterialBindingEntry[] = assembleMaterialWithSkylightEntries(
    entries,
    skylightResources ?? skylightBindGroupResources(fallback),
    transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage)
      ? undefined
      : null,
  ).filter((entry) => !omitted.has(entry.binding));
  for (let index = 0; index < completeEntries.length; index++) {
    const entry = completeEntries[index];
    if (
      entry !== undefined &&
      typeof entry !== 'number' &&
      entry.resource.kind === 'buffer' &&
      entry.resource.value.buffer === MATERIAL_UBO_PLACEHOLDER
    )
      completeEntries[index] = entry.binding;
  }
  if (materialUsesDirectDfgLut(schema)) {
    const lut = getOrCreateDirectDfgLut(device, runtime.deviceScope);
    if (!lut.ok) {
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
  if (device.caps.storageBuffer) {
    completeEntries.push({
      binding: 46,
      resource: {
        kind: 'buffer',
        value: { buffer: meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer },
      },
    });
  }
  // Resolve all current values and physical resources before sharing. Neither
  // a material GUID nor an immutable-looking source is sufficient authority.
  const previous = scope?.find(
    (row) =>
      row.device === device &&
      row.generation === generation &&
      row.world === world &&
      row.layout === layout &&
      samePayload(row.payload, payload) &&
      row.entries.length === completeEntries.length &&
      row.entries.every((entry, index) => {
        const other = completeEntries[index];
        return other !== undefined && sameBindingEntry(entry, other);
      }),
  );
  if (previous !== undefined && scope !== undefined)
    return ok(acquireMaterialBinding(scope, previous));
  let buffer: Buffer | undefined;
  if (payload !== undefined) {
    const created = device.createBuffer({
      label: `prepared-material:${materialGuid}`,
      size: payload.byteLength,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) return created;
    buffer = created.value;
    const written = device.queue.writeBuffer(buffer, 0, payload);
    if (!written.ok) {
      device.destroyBuffer(buffer);
      return written;
    }
  }
  const actualEntries: BindGroupEntry[] = [];
  for (const entry of completeEntries) {
    if (typeof entry !== 'number') actualEntries.push(entry);
    else if (buffer !== undefined)
      actualEntries.push({
        binding: entry,
        resource: {
          kind: 'buffer',
          value: { buffer, ...(payload === undefined ? {} : { size: payload.byteLength }) },
        },
      });
  }
  const group = device.createBindGroup({ layout, entries: actualEntries });
  if (!group.ok) {
    if (buffer !== undefined) device.destroyBuffer(buffer);
    return group;
  }
  if (scope !== undefined) {
    const row: PreparedMaterialBindingRow = {
      device,
      generation,
      world,
      layout,
      payload,
      entries: completeEntries,
      handle: group.value,
      buffer,
      references: 0,
    };
    scope.push(row);
    return ok(acquireMaterialBinding(scope, row));
  }
  if (buffer === undefined) return group;
  return ok({
    handle: group.value,
    dynamicOffsets: [0],
    release: () => device.destroyBuffer(buffer),
  });
}
