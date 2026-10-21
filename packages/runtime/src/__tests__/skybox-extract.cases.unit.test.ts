import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { equirectContribution } from '@forgeax/engine-image';
import { SkyboxBackground } from '@forgeax/engine-render';
import { expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

it('extracts the first bound environment and the real skybox count', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const world = new World({ assets });
  const extract = () => extractFrame(world, prepareExtractContext(world));
  expect(extract()).toMatchObject({ skybox: undefined, skyboxCount: 0 });
  const equirect = () =>
    assets
      .create({
        kind: 'equirect',
        width: 4,
        height: 2,
        format: 'rgba16float',
        colorSpace: 'linear',
        data: new Uint8Array(4 * 2 * 8),
      })
      .unwrap();
  const first = equirect();
  world.spawn({ component: SkyboxBackground, data: { equirect: first, mode: 0 } }).unwrap();
  expect(extract()).toMatchObject({ skybox: { equirectHandle: first, mode: 0 }, skyboxCount: 1 });
  world.spawn({ component: SkyboxBackground, data: { equirect: equirect(), mode: 1 } }).unwrap();
  expect(extract()).toMatchObject({ skybox: { equirectHandle: first, mode: 0 }, skyboxCount: 2 });
  assets.dispose();
});
