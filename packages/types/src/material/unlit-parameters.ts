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
    { name: 'shadowAlphaMode', type: 'f32', optional: true },
    { name: 'alphaMode', type: 'f32', optional: true },
    { name: 'alphaToCoverage', type: 'f32', optional: true },
    { name: 'shading', type: 'f32', optional: true },
    { name: 'alphaChannel', type: 'f32', optional: true, default: 1 },
    { name: 'baseColorTexture', type: 'texture', optional: true },
    { name: 'alphaTexture', type: 'texture', optional: true },
  ];
}
