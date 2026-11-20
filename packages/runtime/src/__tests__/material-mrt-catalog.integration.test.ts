import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { materialContribution } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { startMaterialMrtServer } from './material-mrt.server';

it('admits the actual temporary MRT Pack and preserves all four authored outputs', async () => {
  const server = await startMaterialMrtServer();
  try {
    const assets = new AssetRegistry({
      importTransport: createDevImportTransport(server.binding),
      shaderRegistry: new ShaderRegistry({ prepareProgramCompiler: prepareShaderProgramCompiler }),
    });
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    assets.configureRuntimeBinding(server.binding);
    const parsed = AssetGuid.parse(server.guid);
    if (!parsed.ok) throw parsed.error;
    const handle = (await assets.load(parsed.value, 'material')).unwrap();
    const material = assets.read(handle).unwrap();
    expect(material.passes?.[0]?.outputs?.map((output) => [output.name, output.format])).toEqual([
      ['color', 'rgba16float'],
      ['objectId', 'r32uint'],
      ['mask', 'rgba8unorm'],
      ['data', 'rgba16float'],
    ]);
    expect(material.values?.objectId).toBe(123456789);
    expect(material.passes?.[0]?.outputs?.[2]?.writeMask).toBe(1);
  } finally {
    await server.close();
  }
}, 90_000);
