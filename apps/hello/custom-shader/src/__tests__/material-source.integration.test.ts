import { readFileSync } from 'node:fs';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

it('loads the authored Material and Texture closure through its ordinary Catalog source',async()=>{
  const packageUrl='https://custom.invalid/pulse.pack.json';
  const source=JSON.parse(readFileSync(new URL('../../assets/pulse-material.pack.json',import.meta.url),'utf8'));
  const {pack,publication}=createRuntimePackPublication({scopeId:'custom-material',sourcePath:'pulse.pack.json',sourceRevision:'1',packageUrl,pack:source});
  const assets=new AssetRegistry({scopeId:'custom-material'});
  assets.installDecoder(textureContribution.kind,textureContribution.decoder);
  assets.installDecoder(materialContribution.kind,materialContribution.decoder);
  assets.setCatalogSource(createCatalogSource({entries:pack.assets.map(({guid,kind})=>({guid,kind,packageUrl,sourcePath:'pulse.pack.json',publication}))}),async()=>new Response(JSON.stringify(pack)));
  try {
    const root=(await assets.load('01935b00-7d8c-7c4e-9f12-345678abcd02','material')).unwrap();
    const child=(await assets.load('01935b00-7d8c-7c4e-9f12-345678abcd03','material')).unwrap();
    const value=assets.read(root).unwrap();
    const base=value.values?.baseColorTexture;
    const normal=value.values?.normalTexture;
    const texture=(input:unknown)=>{
      const reference=typeof input==='number'?input:(input as {texture:number}).texture;
      return assets.read(reference as AssetHandle<'texture'>).unwrap();
    };
    expect(texture(base).data.subarray(0,4)).toEqual(Uint8Array.of(255,96,32,255));
    expect(texture(normal).data.subarray(0,4)).toEqual(Uint8Array.of(32,224,32,255));
    const inherited=assets.read(child).unwrap();
    expect(inherited.values?.baseColorTexture).toEqual(value.values?.baseColorTexture);
    expect(inherited.values?.time).toBe(value.values?.time);
    expect(inherited.values?.baseColor).toEqual([0.2,0.55,0.95,1]);
  } finally {assets.dispose();}
});
