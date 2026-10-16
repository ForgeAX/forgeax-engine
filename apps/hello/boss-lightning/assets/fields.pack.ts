import { definePack } from '@forgeax/engine-pack/source';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok, type Asset } from '@forgeax/engine-types';
import { createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { FIELD_PACKAGE } from '../src/field-guids.ts';
export default definePack({
  schemaVersion: '2.0.0', packageId: FIELD_PACKAGE, name: 'Saved particle vector fields',
  build() {
    const assets: Record<string, Asset> = { 'material/particle': createBuiltinMaterialAsset('unlit') };
    const zero = createVfxVectorFieldTexture({resolution:[8,8,8],field:{kind:'constant',value:[0,0,0]}});
    if(!zero.ok)return zero;
    assets['field/zero/8']=zero.value;
    for (const resolution of [8, 16, 32]) for (const kind of ['constant', 'radial', 'vortex'] as const) {
      const texture = createVfxVectorFieldTexture({resolution:[resolution,resolution,resolution], field:kind==='constant'?{kind,value:[0.5,0.25,-0.125]}:{kind,magnitude:1}});
      if (!texture.ok) return texture;
      assets[`field/${kind}/${resolution}`] = texture.value;
    }
    return ok(assets);
  },
});
