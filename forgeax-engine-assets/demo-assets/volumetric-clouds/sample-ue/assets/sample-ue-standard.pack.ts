import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok, type TextureAsset } from '@forgeax/engine/types';
import material from './cloud-material.ts';
import pattern from './textures/T_CloudPattern.raw?bytes';
import mask from './textures/T_CloudMask.raw?bytes';
import profile from './textures/T_Profile_08.raw?bytes';
import body from './textures/VT_PerlinWorley_Balanced.raw?bytes';

export { standardUeCloudRef } from './identity.ts';
const packageId = definePackageId('019a50a5-0000-7000-8000-000000000006');

export default definePack({
  schemaVersion: '2.0.0', name: 'sample-ue-standard', packageId,
  build() {
    return ok({
      'texture/layout-pattern': {
        kind: 'texture', format: 'rgba16float', colorSpace: 'linear', data: pattern,
        shape: { viewDimension: '2d', extent: { width: 1024, height: 1024 } },
        mips: { kind: 'none' },
      } satisfies TextureAsset,
      'texture/layout-mask': {
        kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear', data: mask,
        shape: { viewDimension: '2d', extent: { width: 1024, height: 1024 } },
        mips: { kind: 'none' },
      } satisfies TextureAsset,
      'texture/height-profile': {
        kind: 'texture', format: 'rgba16float', colorSpace: 'linear', data: profile,
        shape: { viewDimension: '2d', extent: { width: 256, height: 256 } },
        mips: { kind: 'none' },
      } satisfies TextureAsset,
      'texture/body-noise': {
        kind: 'texture', format: 'rgba16float', colorSpace: 'linear', data: body,
        shape: { viewDimension: '3d', extent: { width: 128, height: 128, depth: 128 } },
        mips: { kind: 'none' },
      } satisfies TextureAsset,
      'material/sample-ue': {
        kind: 'cloud-material', execution: 'cooked', source: material,
      },
    });
  },
});
