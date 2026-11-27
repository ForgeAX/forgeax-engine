import type { MaterialGBufferLayout, MaterialProgram } from '@forgeax/engine-types';

/** Certification belongs to the source producer, never to a runtime name guess. */
export function engineMaterialGBuffer(file: {
  readonly reservedIdentifier?: string | undefined;
  readonly program?: Pick<MaterialProgram, 'gbuffer'> | undefined;
}): MaterialGBufferLayout | undefined {
  if (file.program?.gbuffer !== undefined) return file.program.gbuffer;
  switch (file.reservedIdentifier) {
    case 'forgeax::default-standard-pbr':
    case 'forgeax::pbr-skin':
    case 'forgeax::default-standard-pbr-skin':
    case 'forgeax::standard-terrain-detail':
    case 'forgeax::standard-terrain':
    case 'forgeax::standard-terrain-ids':
      return 'standard-gbuffer/2';
    default:
      return undefined;
  }
}
