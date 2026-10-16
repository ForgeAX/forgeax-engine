import {
  err,
  isMaterialTextureParameterType,
  type MaterialAsset,
  type MaterialPass,
  ok,
  type ParamSchemaEntry,
  type Result,
} from '@forgeax/engine-types';

/** Build-produced opaque or masked Surface program; there is no runtime compiler or registry. */
export interface RaySurfaceProgram {
  readonly context: 'ray-hit' | 'raster-probe' | 'card-capture';
  readonly wgsl: string;
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly contract: string;
  readonly sourceClosureDigest: string;
}
export interface RayMaterialError {
  readonly code: 'ray-material-unsupported';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly material: string;
    readonly source: string;
    readonly requirement: string;
  };
}
export function rayMaterialFailure(
  material: string,
  source: string,
  requirement: string,
): Result<never, RayMaterialError> {
  return err({
    code: 'ray-material-unsupported',
    expected:
      'opaque or masked Standard Surface with explicit filtering and a qualified normal frame',
    hint: 'Repair the named material source or use a qualified profile; recook before tracing.',
    detail: { material, source, requirement },
  });
}
export function rayMaterialContract(asset: MaterialAsset): string {
  return JSON.stringify([asset.parameters, asset.passes, asset.surface, asset.colorSpace]);
}
/** Custom Surface coverage remains conservative even when alphaCutoff is zero. */
export function rayMaterialNeedsCoverage(asset: {
  readonly passes?: readonly MaterialPass[] | undefined;
  readonly surface?: MaterialAsset['surface'];
  readonly parameters?: MaterialAsset['parameters'];
  readonly values?: MaterialAsset['values'];
}): boolean {
  const forward = asset.passes?.find((pass) => pass.name.toLowerCase() === 'forward');
  const surface = forward?.program.moduleSlots?.surface ?? asset.surface?.module;
  const cutoff =
    asset.values?.alphaCutoff ??
    asset.parameters?.find((parameter) => parameter.name === 'alphaCutoff')?.default;
  return (
    (typeof cutoff === 'number' && cutoff > 0) ||
    (surface !== undefined && surface !== 'forgeax_material::default_standard_surface')
  );
}
/** Shared build/runtime admission: value edits cannot silently enable unsupported coverage/layers. */
export function admitRayMaterial(
  asset: MaterialAsset,
  material: string,
  context: RaySurfaceProgram['context'] = 'ray-hit',
): Result<void, RayMaterialError> {
  const pass = asset.passes?.find((p) => p.name.toLowerCase() === 'forward');
  const module = pass?.program.module ?? '<missing-forward>';
  if (
    pass === undefined ||
    !['forgeax_material::standard', 'forgeax::default-standard-pbr'].includes(module)
  )
    return rayMaterialFailure(material, module, 'Standard rigid Surface root');
  const surface =
    pass.program.moduleSlots?.surface ??
    asset.surface?.module ??
    'forgeax_material::default_standard_surface';
  if (context === 'card-capture' && surface !== 'forgeax_material::default_standard_surface')
    return rayMaterialFailure(
      material,
      surface,
      'canonical Standard card capture; custom/view-dependent capture is not qualified',
    );
  if (pass.renderState?.blend !== undefined || asset.surface?.model === 'single-layer-medium')
    return rayMaterialFailure(material, module, 'opaque coverage');
  for (const p of asset.parameters ?? []) {
    if (p.type !== 'texture' && isMaterialTextureParameterType(p.type))
      return rayMaterialFailure(material, module, '2D textures');
    if (
      /^(clearcoat|anisotropy|sheen|iridescence|diffuseTransmission|transmission|thickness|attenuation|bumpTexture|specularTexture|specularColorTexture|clipping)/.test(
        p.name,
      )
    )
      return rayMaterialFailure(material, module, `unsupported parameter ${p.name}`);
  }
  const values = {
    ...Object.fromEntries((asset.parameters ?? []).map((p) => [p.name, p.default])),
    ...asset.values,
  };
  return admitRayMaterialValues(values, material, module);
}

/** Value edits are checked again against the accepted program's supported profile. */
export function admitRayMaterialValues(
  values: Readonly<Record<string, unknown>>,
  material: string,
  source: string,
): Result<void, RayMaterialError> {
  // Projection selectors specialize raster pipelines only; the ray entry is
  // unspecialized and would silently sample by UV with a tangent frame.
  for (const name of ['alphaHash', 'triplanarSpace', 'normalMapSpace'])
    if (typeof values[name] === 'number' && values[name] !== 0)
      return rayMaterialFailure(material, source, name);
  for (const value of Object.values(values)) {
    if (
      (typeof value === 'number' && !Number.isFinite(Math.fround(value))) ||
      (Array.isArray(value) &&
        !value.every((v) => typeof v === 'number' && Number.isFinite(Math.fround(v))))
    )
      return rayMaterialFailure(material, source, 'finite numeric values');
  }
  const radius = values.subsurfaceRadius;
  if (
    typeof values.subsurfaceWeight === 'number' &&
    values.subsurfaceWeight > 0 &&
    Array.isArray(radius) &&
    radius.some((channel) => typeof channel === 'number' && channel > 0)
  )
    return rayMaterialFailure(material, source, 'screen-space subsurface diffusion');
  const color = values.baseColor;
  if (
    Array.isArray(color) &&
    color.length > 3 &&
    color[3] !== 1 &&
    !(Number(values.alphaCutoff) > 0)
  )
    return rayMaterialFailure(material, source, 'baseColor opacity');
  return ok(undefined);
}
