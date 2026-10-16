import { err, type GltfError, gltfErr, ok, type Result } from '../errors.js';
import { type DecodeAccessorInput, decodeAccessor } from './decode-accessor.js';
export type DecodeColorAccessorInput = Omit<DecodeAccessorInput, 'role'> & {
  readonly semantic: 'COLOR_0';
};
/** COLOR_0 validation wraps the shared sparse/stride decoder; output is linear RGBA. */
export function decodeColorAccessor(
  input: DecodeColorAccessorInput,
  flags: { readonly morph?: boolean } = {},
): Result<Float32Array, GltfError> {
  const { accessor, accessorIndex, semantic } = input;
  const unsupported = (reason: 'component' | 'type' | 'normalized' | 'morph') =>
    err(
      gltfErr('gltf-color-accessor-unsupported', {
        semantic,
        accessorIndex,
        reason,
        expectedType: 'VEC3 or VEC4',
        expectedComponent: 'FLOAT or normalized UNSIGNED_BYTE/UNSIGNED_SHORT',
        ...(reason === 'normalized' ? { expectedNormalized: true } : {}),
      }),
    );
  const malformed = (reason: 'count' | 'bounds' | 'finite' | 'range' | 'reference') =>
    err(
      gltfErr('gltf-color-accessor-malformed', {
        semantic,
        accessorIndex,
        reason,
        ...(reason === 'count'
          ? { expectedCount: 'matches POSITION vertex count and is greater than zero' }
          : {}),
        ...(reason === 'range' || reason === 'finite'
          ? { expectedRange: '[0,1] finite linear values' }
          : {}),
      }),
    );
  if (flags.morph === true) return unsupported('morph');
  if (accessor.type !== 'VEC3' && accessor.type !== 'VEC4') return unsupported('type');
  if (!Number.isSafeInteger(accessor.count) || accessor.count <= 0) return malformed('count');
  if (![5126, 5121, 5123].includes(accessor.componentType)) return unsupported('component');
  if (
    accessor.componentType === 5126
      ? accessor.normalized !== undefined
      : accessor.normalized !== true
  )
    return unsupported('normalized');
  if (
    accessor.bufferView !== undefined &&
    (input.bufferViews[accessor.bufferView] === undefined ||
      input.buffers[input.bufferViews[accessor.bufferView]?.buffer ?? -1] === undefined)
  )
    return malformed('reference');
  const decoded = decodeAccessor({ ...input, role: 'attribute' });
  if (!decoded.ok)
    return decoded.error.code === 'gltf-buffer-out-of-bounds'
      ? malformed('bounds')
      : malformed('finite');
  const components = accessor.type === 'VEC3' ? 3 : 4;
  const output = new Float32Array(accessor.count * 4);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      const value = decoded.value.data[i * components + c] ?? NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1) return malformed('range');
      output[i * 4 + c] = value;
    }
    if (components === 3) output[i * 4 + 3] = 1;
  }
  return ok(output);
}
