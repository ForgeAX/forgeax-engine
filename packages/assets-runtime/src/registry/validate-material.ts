import {
  AssetError,
  isMaterialTextureParameterType,
  type MaterialAsset,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';

/** Validate the asset-owned parameter schema and pass module identifiers. */
export function validateMaterialPasses(asset: MaterialAsset): AssetError | null {
  const passes = asset.passes;
  // undefined passes is valid (material inherits from parent at resolve time);
  // only explicit empty passes[] is an error.
  if (passes === undefined || passes.length === 0) {
    if (passes !== undefined && passes.length === 0) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: 'MaterialAsset with at least one pass',
        hint: 'add at least one pass descriptor to passes[] before register',
        detail: { passCount: 0 },
      });
    }
    // passes undefined: skip validation (inherits from parent later)
    return null;
  }

  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const pass = passes[passIndex];
    if (pass === undefined) continue;
    if (pass.program.module.length === 0) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: 'pass.program.module to be a non-empty module identifier',
        hint: `pass[${passIndex}] has an empty program.module`,
      });
    }
  }

  const values: Record<string, unknown> = (asset.values as Record<string, unknown>) ?? {};

  // The first declaration of each asset parameter owns its value contract.
  const missingParams: string[] = [];
  const seen = new Set<string>();
  for (const entry of asset.parameters ?? []) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const value = values[entry.name];
    if (value === undefined) {
      if (
        entry.default !== undefined ||
        entry.optional ||
        isMaterialTextureParameterType(entry.type)
      ) {
        continue;
      }
      missingParams.push(entry.name);
      continue;
    }
    if (value === null && entry.optional) continue;
    // Type-check supplied values
    const typeOk = validateParamType(entry.type, value);
    if (!typeOk) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `values.${entry.name} to be of type ${entry.type}`,
        hint: `values['${entry.name}'] has type ${typeof value} but paramSchema declares ${entry.type}`,
        detail: { paramName: entry.name, expectedType: entry.type, got: typeof value },
      });
    }
  }

  if (missingParams.length > 0) {
    return new AssetError({
      code: 'asset-invalid-value',
      expected: `values to contain keys: ${missingParams.join(', ')}`,
      hint: `missing required params: ${missingParams.join(', ')}`,
      detail: { missingParams },
    });
  }

  return null;
}

/**
 * Sprite 9-slice values fail-fast validation
 * (feat-20260527-sprite-nineslice M2 / w8, plan-strategy §D-1 + AC-08).
 *
 * Fires when:
 *  - asset.kind === 'material'
 *  - first pass shader === 'forgeax::sprite'
 *  - values.slices is present
 *
 * Six fail-fast branches (1:1 with w4 test):
 *   (1) any component is negative
 *   (2) slices.x + slices.z >= region.zw[0]   (X-axis overlap)
 *   (3) slices.y + slices.w >= region.zw[1]   (Y-axis overlap)
 *   (4) any component is NaN
 *   (5) any component is Infinity
 *   (6) length !== 4
 *
 * Reuses the existing 'asset-invalid-value' member of the closed
 * `AssetErrorCode` 13-member union (no new code added per
 * AGENTS.md §Error model). The `.expected` literal mirrors the AI-User
 * Charter §3 string; `.hint` inlines the offending sum + the relevant
 * `region.zw` numeral so AI users can copy-paste the prompt straight
 * back into the IDE for self-recovery (plan-strategy §R-4).
 *
 * @returns AssetError on failure, null on success.
 */
export function validateSpriteSlices(asset: MaterialAsset): AssetError | null {
  const passes = asset.passes;
  if (passes === undefined || passes.length === 0) return null;
  const firstPass = passes[0];
  if (firstPass === undefined || firstPass.program.module !== 'forgeax_material::sprite')
    return null;
  const pv = (asset.values ?? {}) as Record<string, unknown>;
  const slicesRaw = pv.slices;
  // Field absent — caller relies on paramSchema default [0, 0, 0, 0]; nothing to check.
  if (slicesRaw === undefined) return null;
  const expected =
    'values.slices: [number, number, number, number] with 0 ≤ left + right < region.zw[0] and 0 ≤ top + bottom < region.zw[1]';
  if (!Array.isArray(slicesRaw)) {
    return new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: `values.slices is not an array (got ${typeof slicesRaw}); must be a 4-tuple [left, top, right, bottom]`,
      detail: { paramName: 'slices', got: typeof slicesRaw },
    });
  }
  // (6) length check
  if (slicesRaw.length !== 4) {
    return new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: `values.slices length is ${slicesRaw.length}; must be 4 ([left, top, right, bottom])`,
      detail: { paramName: 'slices', got: slicesRaw.length },
    });
  }
  const slices = slicesRaw as readonly unknown[];
  // Type check each component first.
  for (let i = 0; i < 4; i++) {
    if (typeof slices[i] !== 'number') {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `values.slices[${i}] is not a number (got ${typeof slices[i]})`,
        detail: { paramName: 'slices', got: typeof slices[i] },
      });
    }
  }
  const left = slices[0] as number;
  const top = slices[1] as number;
  const right = slices[2] as number;
  const bottom = slices[3] as number;
  // (4) NaN
  for (let i = 0; i < 4; i++) {
    if (Number.isNaN(slices[i] as number)) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `values.slices[${i}] is NaN; all four components must be finite non-negative numbers`,
        detail: { paramName: 'slices', got: 'NaN' },
      });
    }
  }
  // (5) Infinity
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(slices[i] as number)) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `values.slices[${i}] is Infinity; all four components must be finite non-negative numbers`,
        detail: { paramName: 'slices', got: 'Infinity' },
      });
    }
  }
  // (1) negative — D-3 sentinel uses negative .w for tile mode but only
  // after extract; at register-time the user-supplied tuple must be all
  // non-negative (the engine encodes the sign downstream).
  for (let i = 0; i < 4; i++) {
    if ((slices[i] as number) < 0) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `values.slices[${i}] = ${slices[i]}; all four components must be non-negative`,
        detail: { paramName: 'slices', got: slices[i] as number },
      });
    }
  }
  // (2)/(3) overlap with region. region default is [0, 0, 1, 1];
  // user override comes via values.region (vec4).
  const regionRaw = pv.region;
  let regionZ = 1;
  let regionW = 1;
  if (Array.isArray(regionRaw) && regionRaw.length >= 4) {
    const rz = regionRaw[2];
    const rw = regionRaw[3];
    if (typeof rz === 'number') regionZ = rz;
    if (typeof rw === 'number') regionW = rw;
  }
  const sumX = left + right;
  if (sumX >= regionZ) {
    return new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; left + right = ${sumX} ≥ ${regionZ} (region.z)`,
      detail: { paramName: 'slices', got: sumX },
    });
  }
  const sumY = top + bottom;
  if (sumY >= regionW) {
    return new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; top + bottom = ${sumY} ≥ ${regionW} (region.w)`,
      detail: { paramName: 'slices', got: sumY },
    });
  }
  return null;
}

export function validateParamType(type: string, value: unknown): boolean {
  switch (type) {
    case 'f32':
    case 'i32':
    case 'u32':
      return typeof value === 'number';
    case 'vec2':
      return Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === 'number');
    case 'vec3':
      return Array.isArray(value) && value.length >= 3 && value.every((v) => typeof v === 'number');
    case 'vec4':
      return Array.isArray(value) && value.length >= 4 && value.every((v) => typeof v === 'number');
    case 'color':
      return (
        Array.isArray(value) &&
        (value.length === 3 || value.length === 4) &&
        value.every((v) => typeof v === 'number')
      );
    case 'texture':
    case 'texture_2d_array':
    case 'texture_3d':
    case 'texture_cube':
    case 'texture_external':
      // A cooked pack may keep an asset GUID as the compact texture
      // shorthand. The render material resolver expands that reference at
      // the resource boundary; rejecting it here makes authored packs fail
      // before the same value can reach the resolver.
      return (
        typeof value === 'string' ||
        (typeof value === 'object' && value !== null && !Array.isArray(value))
      );
    case 'bool':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * feat-20260527-sprite-nineslice M4 / w18 (D-9): register-time soft-warn
 * for sliceMode=1 (tile) bound to a sampler whose addressMode is not
 * 'repeat'. Bumps `nineslice.tile-needs-repeat-sampler` once per offending
 * catalogue call. Never throws -- the counter is the sole AI-user-facing
 * signal (charter P3 machine-readable; AC-08 closed, never extends
 * AssetErrorCode).
 *
 * feat-20260614 M8 (D-19): `values.sampler` is now an embedded GUID
 * string (dash-form), resolved against the catalogue rather than a handle.
 */
export function detectTileNeedsRepeatSampler(registry: AssetRegistry, asset: MaterialAsset): void {
  if (registry.metrics === null) return;
  const passes = asset.passes;
  if (passes === undefined || passes.length === 0) return;
  const firstPass = passes[0];
  if (
    firstPass === undefined ||
    (firstPass.program.module !== 'forgeax_material::sprite' &&
      firstPass.program.module !== 'forgeax::sprite')
  )
    return;
  const pv = (asset.values ?? {}) as Record<string, unknown>;
  const slicesAndMode = pv.slicesAndMode;
  const encodedTile =
    Array.isArray(slicesAndMode) && typeof slicesAndMode[3] === 'number'
      ? slicesAndMode[3] < 0
      : false;
  const legacyTile = typeof pv.sliceMode === 'number' && pv.sliceMode === 1;
  if (!encodedTile && !legacyTile) return;
  const samplerGuid = typeof pv.sampler === 'string' ? pv.sampler : undefined;
  if (samplerGuid === undefined) return;
  const samplerEnvelope = registry.assetCatalog.get(samplerGuid.toLowerCase());
  if (samplerEnvelope === undefined || samplerEnvelope.kind !== 'sampler') return;
  const samplerAsset = samplerEnvelope.payload;
  if (samplerAsset.kind !== 'sampler') return;
  const u = samplerAsset.addressModeU;
  const v = samplerAsset.addressModeV;
  if (u !== 'repeat' || v !== 'repeat') {
    registry.metrics.increment('nineslice.tile-needs-repeat-sampler');
  }
}

/**
 * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
 * Return the texture-field name set for the given material-shader id,
 * derived from the registered shader's paramSchema via `derive(paramSchema)
 * .textureFieldNames`. Returns `undefined` when the shader is not yet
 * registered (cross-worktree shader-late-register, plan R-4).
 *
 * Used by `extractFrame` to know which values fields the shader
 * declares as texture handles; the extract layer validates handle-vs-
 * scalar typing and drops misclassified slots so the record stage's
 * MISSING_TEXTURE_HANDLE fallback can take over (white default texture)
 * rather than letting a stray handle reach `device.createBindGroup`.
 */
export function materialShaderTextureFieldNames(
  registry: AssetRegistry,
  shaderId: string,
): ReadonlySet<string> | undefined {
  const lookup = registry.shaderRegistry.findMaterialArtifact(shaderId);
  if (!lookup.ok) return undefined;
  return lookup.value.paramSchemaProjection.derivedInterface.textureFieldNames;
}
