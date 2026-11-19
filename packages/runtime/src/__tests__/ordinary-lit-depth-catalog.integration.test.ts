import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { materialContribution } from '@forgeax/engine-render';
import { expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { startOrdinaryLitDepthServer } from './ordinary-lit-depth.server';

it('admits the real ordinary ECS custom-lit Pack without a fixed user UBO', async () => {
  const server = await startOrdinaryLitDepthServer();
  try {
    const assets = new AssetRegistry({ importTransport: createDevImportTransport(server.binding) });
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    assets.configureRuntimeBinding(server.binding);
    const parsed = AssetGuid.parse(server.guid);
    if (!parsed.ok) throw parsed.error;
    const handle = (await assets.load(parsed.value, 'material')).unwrap();
    const material = assets.read(handle).unwrap();
    expect(material.parameters).toEqual([]);
    expect(material.passes?.[0]?.program.bindings).toBe('render-lit-material-and-scene-depth');
    expect(material.passes?.[0]?.program.sceneDepth).toBe('before-pass');
  } finally {
    await server.close();
  }
}, 90_000);
