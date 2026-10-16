import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  RhiError,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import type { RaySurfaceProgram } from '@forgeax/engine-shader';
import {
  derive,
  type MaterialAsset,
  type MaterialTextureValue,
  materialValuesToLinearRuntime,
  ok,
  type ParamSchemaEntry,
  type Result,
} from '@forgeax/engine-types';
import { packMaterialProgramRow } from '../material-row';
import {
  collectMaterialTextureCoordinates,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  materialTextureValue,
} from '../render-system-extract';
import { type RayReferenceError, rayReferenceFailure } from './scene';
export type ResolveSurfaceTexture = (
  value: MaterialTextureValue,
) => Result<{ view: TextureView; sampler: Sampler }, RayReferenceError>;
/** Offline reference/capture sources lower into the submitted-material binding path. */
export function createReferenceSurfaceMaterialBindings(
  device: RhiDevice,
  material: { readonly program: RaySurfaceProgram; readonly asset: MaterialAsset },
  visibility: number,
  resolveTexture?: ResolveSurfaceTexture,
): ReturnType<typeof createSurfaceMaterialBindings> {
  return createSurfaceMaterialBindings(
    device,
    material.program.paramSchema,
    referenceSurfaceMaterialSnapshot(material),
    visibility,
    (parameter) => {
      const value = materialTextureValue(material.asset.values?.[parameter]);
      return value && resolveTexture
        ? resolveTexture(value)
        : rayReferenceFailure(`missing texture binding ${parameter}`);
    },
  );
}

/** The reference caller crosses the same linear snapshot boundary once. */
export function referenceSurfaceMaterialSnapshot(material: {
  readonly program: RaySurfaceProgram;
  readonly asset: MaterialAsset;
}): MaterialSnapshot {
  const values = materialValuesToLinearRuntime(
    material.asset.values,
    material.program.paramSchema,
    material.asset.colorSpace,
  );
  return {
    ...defaultMaterialSnapshot(),
    renderState: material.asset.passes?.find((pass) => pass.name.toLowerCase() === 'forward')
      ?.renderState,
    paramSnapshot: Object.fromEntries(
      Object.entries(values).filter(
        ([, v]) => typeof v === 'number' || typeof v === 'string' || Array.isArray(v),
      ),
    ) as Record<string, number | number[] | string>,
    textureCoordinates: collectMaterialTextureCoordinates(values),
  };
}

/** Consume an accepted snapshot; no author walk, color conversion or GUID readiness lookup here. */
export function createSurfaceMaterialBindings(
  device: RhiDevice,
  paramSchema: readonly ParamSchemaEntry[],
  snapshot: MaterialSnapshot,
  visibility: number,
  resolveTexture?: (parameter: string) => ReturnType<ResolveSurfaceTexture>,
): Result<
  {
    uniform: Buffer;
    bytes: number;
    layout: BindGroupLayout;
    group: BindGroup;
    textureViews: readonly TextureView[];
  },
  RayReferenceError | RhiError
> {
  const derived = derive(paramSchema);
  const row = packMaterialProgramRow(paramSchema, snapshot, Math.max(16, derived.totalBytes));
  if (!row) return rayReferenceFailure('material uniform layout exceeds its allocation');
  const uniform = device.createBuffer({
    label: 'surface.material',
    size: row.byteLength,
    usage: 72,
  });
  if (!uniform.ok) return uniform;
  const failed = <E>(result: Result<never, E>) => {
    device.destroyBuffer(uniform.value);
    return result;
  };
  const wrote = device.queue.writeBuffer(uniform.value, 0, row);
  if (!wrote.ok) return failed(wrote);
  const layout = device.createBindGroupLayout({
    entries: derived.bglEntries.map((e) => ({
      binding: e.binding,
      visibility,
      ...(e.buffer ? { buffer: e.buffer } : {}),
      ...(e.texture ? { texture: e.texture } : {}),
      ...(e.sampler ? { sampler: e.sampler } : {}),
      ...(e.storageTexture ? { storageTexture: e.storageTexture } : {}),
    })),
  });
  if (!layout.ok) return failed(layout);
  const entries: BindGroupEntry[] = [];
  const binding = derived.bglEntries.find((e) => e.buffer?.type === 'uniform')?.binding;
  if (binding !== undefined)
    entries.push({ binding, resource: { kind: 'buffer', value: { buffer: uniform.value } } });
  const textures = new Map<string, { view: TextureView; sampler: Sampler }>();
  for (const r of derived.resourceBindings) {
    const parameter = r.parameter ?? r.name;
    let texture = textures.get(parameter);
    if (!texture) {
      if (!resolveTexture)
        return failed(rayReferenceFailure(`missing texture binding ${parameter}`));
      const result = resolveTexture(parameter);
      if (!result.ok) return failed(result);
      texture = result.value;
      textures.set(parameter, texture);
    }
    entries.push(
      r.kind === 'sampler'
        ? { binding: r.binding, resource: { kind: 'sampler', value: texture.sampler } }
        : { binding: r.binding, resource: { kind: 'textureView', value: texture.view } },
    );
  }
  const group = device.createBindGroup({ layout: layout.value, entries });
  if (!group.ok) return failed(group);
  return ok({
    uniform: uniform.value,
    bytes: row.byteLength,
    layout: layout.value,
    group: group.value,
    textureViews: [...new Set([...textures.values()].map((texture) => texture.view))],
  });
}
