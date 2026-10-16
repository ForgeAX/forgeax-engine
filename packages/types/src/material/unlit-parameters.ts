import type { MaterialParameter } from './asset';
import type { MaterialColorSpace } from './color-space';
/** Shared authored contract for engine factories and format producers. */
export function unlitMaterialParameters(
  colorSpace: MaterialColorSpace,
): readonly MaterialParameter[] {
  return [
    { name: 'baseColor', type: 'color', colorSpace },
    { name: 'alphaCutoff', type: 'f32', optional: true },
    { name: 'alphaHash', type: 'f32', optional: true },
    { name: 'shading', type: 'f32', optional: true },
    { name: 'baseColorTexture', type: 'texture', optional: true },
  ];
}
