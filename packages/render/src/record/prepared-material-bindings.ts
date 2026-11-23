import type { BindGroup, BindGroupEntry, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-rhi';
import { STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  derive,
  type MaterialAsset,
  materialValuesToLinearRuntime,
  type SamplerAsset,
} from '@forgeax/engine-types';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import type { ResidencyLease } from '../device/residency-lifetime';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import {
  assembleLitMaterialEntries,
  assembleMaterialWithSkylightEntries,
  skylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import { type MaterialSourceSnapshot, materialSourceScope } from '../material-source';
import {
  buildPbrMaterialUserRegionEntries,
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  materialUsesLitSceneInputs,
  omittedStandardMaterialBindings,
  programDeclaresTransmissionBackdrop,
  projectMaterialLayoutEntries,
  sharedMaterialBindingDeclarations,
  standardInputField,
} from '../pbr-pipeline';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  assetReferenceText,
  materialParametersToParamSchema,
  materialStandardTextureMask,
  materialTextureRef,
  materialTextureValue,
  resolveRuntimeAssetReference,
} from '../render-system-extract';
import { recordContext } from '../world/view-record-context';
import {
  defaultViewForUserRegionField,
  residentTextureView,
  writePreparedMaterialUbo,
} from './main-pass-material';
import type { RenderSystemInternals } from './render-context';

export type PreparedResolverCaches = {
  readonly preparedPipelineIds: WeakMap<object, string>;
  readonly preparedMaterialPipelineShaders: WeakMap<object, string>;
  readonly preparedGroup0Pipelines: WeakSet<object>;
  readonly preparedViewOnlyPipelines: WeakSet<object>;
  readonly preparedRenderMaterialPipelines: WeakSet<object>;
  /** Live material rows of every resolver, including frames still in flight. */
  readonly materialBindings: PreparedMaterialBindingsScope;
};

export function createPreparedResolverCaches(): PreparedResolverCaches {
  return {
    preparedPipelineIds: new WeakMap(),
    preparedMaterialPipelineShaders: new WeakMap(),
    preparedGroup0Pipelines: new WeakSet(),
    preparedViewOnlyPipelines: new WeakSet(),
    preparedRenderMaterialPipelines: new WeakSet(),
    materialBindings: [],
  };
}

// A number marks an owned UBO slot until a miss creates its physical buffer.
type MaterialBindingEntry = BindGroupEntry | number;
const MATERIAL_UBO_PLACEHOLDER = {} as Buffer;

interface PreparedMaterialBindingRow {
  readonly device: RenderSystemInternals['device'];
  readonly generation: number;
  readonly world: RenderResourceScope;
  readonly sourceWorld: RenderResourceScope;
  readonly sourceAssets: MaterialSourceSnapshot | undefined;
  readonly scopeLease: ResidencyLease | undefined;
  readonly textures: readonly ResidencyLease[];
  readonly layout: BindGroupLayout;
  readonly payload: Uint8Array | undefined;
  readonly entries: readonly MaterialBindingEntry[];
  readonly handle: BindGroup;
  readonly buffer: Buffer | undefined;
  references: number;
  current: boolean;
}

/**
 * Current accepted bindings and outstanding material leases share exact rows.
 * The next frame can reuse the bind group and immutable UBO only after resolving
 * every current value and physical resource.
 */
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
      --row.references;
      return retireMaterialBinding(scope, row);
    },
  };
}

function retireMaterialBinding(
  scope: PreparedMaterialBindingsScope,
  row: PreparedMaterialBindingRow,
) {
  if (row.references > 0 || row.current) return ok(undefined);
  const index = scope.indexOf(row);
  if (index < 0) return ok(undefined);
  scope.splice(index, 1);
  for (const texture of row.textures) void texture.release(false);
  void row.scopeLease?.release(true);
  return row.buffer === undefined ? ok(undefined) : row.device.destroyBuffer(row.buffer);
}

/** The accepted Feature plan owns one row while submitted resolvers retain their own references. */
export function adoptPreparedMaterialBindings(
  scope: PreparedMaterialBindingsScope,
  handles: ReadonlySet<BindGroup>,
): void {
  for (const row of [...scope]) {
    row.current = handles.has(row.handle);
    const retired = retireMaterialBinding(scope, row);
    if (!retired.ok) throw retired.error;
  }
}

export function clearPreparedMaterialBindings(scope: PreparedMaterialBindingsScope): void {
  for (const row of [...scope]) {
    row.current = false;
    const retired = retireMaterialBinding(scope, row);
    if (!retired.ok) throw retired.error;
  }
}

function preparedHandle<Brand extends string>(
  world: RenderResourceScope,
  reference: unknown,
  brand: Brand,
): AssetHandle<Brand> | undefined {
  if (typeof reference === 'number')
    return reference === 0 ? undefined : (reference as AssetHandle<Brand>);
  const guid = assetReferenceText(reference);
  if (guid === undefined) return undefined;
  return resolveRuntimeAssetReference(world, guid, brand);
}

function unavailablePreparedMaterial(reason: string, materialHandle: number) {
  return err(new Error(`prepared material ${reason} (handle=${String(materialHandle)})`));
}

export function preparedMaterialBindings(
  runtime: RenderSystemInternals,
  sourceScope: RenderResourceScope,
  materialShaderId: string,
  handle: number,
  layout: BindGroupLayout,
  skylightResources?: SkylightBindGroupResources,
  scope?: PreparedMaterialBindingsScope,
  revision?: number,
  sourceAssets?: MaterialSourceSnapshot,
  resolveVersion?: (
    handle: number,
    revision: number,
  ) => import('@forgeax/engine-types').Asset | undefined,
) {
  const device = runtime.device;
  const generation = recordContext(runtime).deviceScope?.generation ?? 0;
  const sourceWorld = sourceScope;
  const world =
    sourceWorld === undefined
      ? undefined
      : materialSourceScope(sourceWorld, sourceAssets, resolveVersion);
  const pipelineState = recordContext(runtime).getPipelineState();
  if (world === undefined) return unavailablePreparedMaterial('source-world-unavailable', handle);
  if (!Number.isSafeInteger(handle) || handle <= 0)
    return unavailablePreparedMaterial('asset-handle-invalid', handle);
  if (pipelineState === null)
    return unavailablePreparedMaterial('pipeline-state-unavailable', handle);
  const resolved = world.resolveAsset<MaterialAsset>(handle, revision);
  if (!resolved.ok) return resolved;
  const material = resolved.value;
  const kind = material.kind;
  if (kind !== 'material') {
    const label = typeof kind === 'string' ? (kind as string).slice(0, 24) : typeof kind;
    return unavailablePreparedMaterial(`asset-kind-mismatch:${label}`, handle);
  }
  const prepareMaterialParameterPayload = () => {
    const declaredSchema = runtime.getParamSchema?.(materialShaderId);
    const schema =
      declaredSchema ??
      materialParametersToParamSchema(material.parameters ?? [], materialShaderId);
    // Feature materials share the ordinary linear parameter domain and semantic texture defaults.
    const values = materialValuesToLinearRuntime(
      material.values,
      declaredSchema === undefined ? schema : [...schema, ...(material.parameters ?? [])],
      material.colorSpace,
    );
    const derived = derive(schema);
    const fields = [...derived.textureFieldNames];
    // Match the PBR layout's reserved dynamic UBO, including an empty schema.
    const emptyLit =
      schema.length === 0 && materialUsesLitSceneInputs(runtime.shaderRegistry, materialShaderId);
    const userRegion = emptyLit
      ? []
      : buildPbrMaterialUserRegionEntries(
          schema,
          [],
          [],
          materialUsesLitSceneInputs(runtime.shaderRegistry, materialShaderId),
        );
    const payload = new Uint8Array(Math.max(16, derived.uboLayout.totalBytes));
    writePreparedMaterialUbo(
      payload,
      schema,
      values as Readonly<Record<string, number | readonly number[]>>,
    );
    return { schema, values, userRegion, fields, payload: emptyLit ? undefined : payload };
  };
  const { schema, values, userRegion, fields, payload } = prepareMaterialParameterPayload();
  const resolvePreparedMaterialTextureResources = () => {
    const textureResources: Array<{
      sampler: import('@forgeax/engine-rhi').Sampler;
      view: import('@forgeax/engine-rhi').TextureView;
    }> = [];
    const textureHandles = new Set<AssetHandle<'texture' | 'gpu-texture'>>();
    const textureMask = materialStandardTextureMask(material.parameters, materialShaderId, values);
    for (const slot of fields) {
      const field = isStandardPbrMaterialShader(materialShaderId)
        ? standardInputField(slot, textureMask, values.displacementMode)
        : slot;
      const value = values[field];
      const textureValue = materialTextureValue(value);
      let sampler = pipelineState.defaultSampler;
      if (textureValue?.sampler !== undefined) {
        const handle = preparedHandle(world, textureValue.sampler, 'sampler');
        if (handle !== undefined) {
          const asset = world.resolveAsset<SamplerAsset>(handle);
          if (asset.ok) {
            const resident = runtime.gpuStore.ensureSamplerResident(handle, asset.value, world);
            if (resident.ok) {
              sampler = resident.value;
            }
          }
        }
      }
      let view = defaultViewForUserRegionField(field, pipelineState, schema);
      const texture = preparedTextureHandle(world, materialTextureRef(value));
      if (texture !== undefined) {
        view = residentTextureView(world, runtime.gpuStore, runtime, texture) ?? view;
        textureHandles.add(texture);
      }
      textureResources.push({ sampler, view });
    }
    return { textureResources, textureHandles };
  };
  const { textureResources, textureHandles } = resolvePreparedMaterialTextureResources();
  const entries: BindGroupEntry[] = [];
  let textureIndex = 0;
  const assemblePreparedMaterialSchemaEntries = () => {
    for (let index = 0; index < userRegion.length; index += 1) {
      const expected = userRegion[index];
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
        userRegion[index + 1]?.texture !== undefined &&
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
    return undefined;
  };
  const schemaEntryFailure = assemblePreparedMaterialSchemaEntries();
  if (schemaEntryFailure !== undefined) return schemaEntryFailure;
  const fallback = pipelineState.skylightFallback;
  if (fallback === null) {
    return err(new Error('prepared material skylight fallback is unavailable'));
  }
  const litMaterial = materialUsesLitSceneInputs(runtime.shaderRegistry, materialShaderId);
  const projectPreparedMaterialLayoutEntries = () => {
    if (litMaterial)
      return assembleLitMaterialEntries(
        entries,
        skylightResources ?? skylightBindGroupResources(fallback),
        derive(schema).userRegionBindingEnd,
      );
    const programBindings = sharedMaterialBindingDeclarations(
      runtime.shaderRegistry,
      materialShaderId,
    );
    const transmissionAvailable =
      transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage) ||
      programDeclaresTransmissionBackdrop(programBindings, 1 + fields.length * 2);
    const omitted = omittedStandardMaterialBindings(
      fields,
      transmissionAvailable,
      isStandardPbrMaterialShader(materialShaderId),
      isCanonicalStandardPbrMaterialShader(materialShaderId),
      programBindings,
    );
    const standardEntries = assembleMaterialWithSkylightEntries(
      entries,
      skylightResources ?? skylightBindGroupResources(fallback),
      transmissionAvailable ? undefined : null,
    );
    // The shared Standard BGL has a fixed complete resource ABI. Reflection can
    // project unused fields only when a shader has its own reduced layout; a
    // prepared Standard Surface pipeline falls back to the shared BGL and must
    // therefore keep its default texture/sampler entries and Skylight buffer.
    const completeEntries: MaterialBindingEntry[] =
      layout === pipelineState.materialBindGroupLayout
        ? standardEntries
        : standardEntries.filter((entry) => !omitted.has(entry.binding));
    return completeEntries;
  };
  let completeEntries = projectPreparedMaterialLayoutEntries();
  const appendPreparedMaterialOwnedEntries = () => {
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
    if (litMaterial) return undefined;
    if (
      materialUsesDirectDfgLut(schema) &&
      !isCanonicalStandardPbrMaterialShader(materialShaderId) &&
      sharedMaterialBindingDeclarations(runtime.shaderRegistry, materialShaderId)?.includes(
        STANDARD_DIRECT_DFG_LUT_BINDING,
      ) !== false
    ) {
      const lut = getOrCreateDirectDfgLut(device, recordContext(runtime).deviceScope);
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
    return undefined;
  };
  const ownedEntryFailure = appendPreparedMaterialOwnedEntries();
  if (ownedEntryFailure !== undefined) return ownedEntryFailure;
  completeEntries = projectMaterialLayoutEntries(layout, completeEntries);
  // Resolve all current values and physical resources before sharing. Neither
  // a material GUID nor an immutable-looking source is sufficient authority.
  const findPreparedMaterialBindingReuse = () => {
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
    return previous;
  };
  const previous = findPreparedMaterialBindingReuse();
  if (previous !== undefined && scope !== undefined)
    return ok(acquireMaterialBinding(scope, previous));
  let buffer: Buffer | undefined;
  if (payload !== undefined) {
    const created = device.createBuffer({
      label: `prepared-material:${handle}`,
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
  const resolvePreparedMaterialActualEntries = () => {
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
  };
  resolvePreparedMaterialActualEntries();
  const group = device.createBindGroup({ layout, entries: actualEntries });
  const completePreparedMaterialBinding = (buffer: Buffer | undefined) => {
    if (!group.ok) {
      if (buffer !== undefined) device.destroyBuffer(buffer);
      return group;
    }
    const retainScopedPreparedMaterialBinding = () => {
      if (scope !== undefined) {
        const row: PreparedMaterialBindingRow = {
          device,
          generation,
          world,
          sourceWorld,
          sourceAssets,
          scopeLease:
            sourceAssets === undefined ? undefined : runtime.gpuStore.retainMaterialScope(world),
          textures:
            sourceAssets === undefined
              ? []
              : [...textureHandles].flatMap((handle) => {
                  const lease = runtime.gpuStore.retainTextureResidency(handle, world);
                  return lease === undefined ? [] : [lease];
                }),
          layout,
          payload,
          entries: completeEntries,
          handle: group.value,
          buffer,
          references: 0,
          current: false,
        };
        scope.push(row);
        return ok(acquireMaterialBinding(scope, row));
      }
      return undefined;
    };
    const scopedBindingResult = retainScopedPreparedMaterialBinding();
    if (scopedBindingResult !== undefined) return scopedBindingResult;
    if (buffer === undefined) return group;
    return ok({
      handle: group.value,
      dynamicOffsets: [0],
      release: () => device.destroyBuffer(buffer),
    });
  };
  return completePreparedMaterialBinding(buffer);
}

function preparedTextureHandle(
  world: RenderResourceScope,
  reference: unknown,
): AssetHandle<'texture' | 'gpu-texture'> | undefined {
  if (typeof reference === 'number')
    return reference === 0 ? undefined : (reference as AssetHandle<'texture' | 'gpu-texture'>);
  return (
    preparedHandle(world, reference, 'texture') ?? preparedHandle(world, reference, 'gpu-texture')
  );
}
