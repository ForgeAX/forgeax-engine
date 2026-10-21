import {
  AssetError,
  isMaterialTextureParameterType,
  type MaterialAsset,
  type MaterialParameter,
  validateMaterialValues,
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
  const declarations = new Map<string, MaterialParameter>();
  for (const entry of asset.parameters ?? []) {
    if (declarations.has(entry.name)) continue;
    declarations.set(entry.name, entry);
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
  }

  const supplied = validateMaterialValues(
    '<material>',
    asset.values ?? {},
    asset.parameters === undefined ? undefined : declarations,
  );
  if (!supplied.ok) {
    const error = supplied.error;
    return new AssetError({
      code: 'asset-invalid-value',
      expected: supplied.error.expected,
      hint: supplied.error.hint,
      ...(error.code === 'material-value-type-mismatch'
        ? {
            detail: {
              paramName: error.detail.parameter,
              expectedType: error.detail.expectedType,
              got: typeof values[error.detail.parameter],
            },
          }
        : {}),
    });
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
