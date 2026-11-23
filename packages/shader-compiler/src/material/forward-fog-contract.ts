import type { MaterialProgram } from '@forgeax/engine-types';

/** Engine source ownership certifies stock writers; raw programs declare their own contract. */
export function engineMaterialForwardFog(file: {
  readonly reservedIdentifier?: string | undefined;
  readonly program?: Pick<MaterialProgram, 'forwardFog'> | undefined;
}): 'height-vertex/1' | undefined {
  if (file.program?.forwardFog !== undefined) return file.program.forwardFog;
  switch (file.reservedIdentifier) {
    case 'forgeax::default-standard-pbr':
    case 'forgeax::pbr-skin':
    case 'forgeax::default-standard-pbr-skin':
    case 'forgeax::default-unlit':
    case 'forgeax::sprite':
    case 'forgeax::sprite-lit':
    case 'forgeax::msdf-text':
    case 'forgeax::points-lines':
    case 'forgeax::single-layer-medium':
    case 'forgeax::single-layer-water':
    case 'forgeax::standard-terrain-detail':
    case 'forgeax::standard-terrain':
    case 'forgeax::standard-terrain-ids':
      return 'height-vertex/1';
    default:
      return undefined;
  }
}
