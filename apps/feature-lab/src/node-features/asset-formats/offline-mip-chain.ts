import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { parseKtx2 } from '@forgeax/engine/codec';
import { deriveTextureLayout, type TextureAsset } from '@forgeax/engine/types';
import { errorCode, installMemoryPack } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import { CHECKER_PNG, importImage, TEXTURE_SUB, texturePayload } from './support/image-import';

export default defineFeature({
  title: 'Offline mip chain',
  catalog: 'Offline mip chain',
  kind: 'headless',
  summary:
    'A compressed PNG import with mipmap: true must bake the full mip chain into the KTX2 body, because block-compressed formats cannot be mip-generated on the GPU at runtime.',
  expect:
    'The uastc 16x16 import produces a KTX2 with 5 levels and a TextureAsset whose mips policy is an authored packed chain, never runtime generate; an uncompressed import keeps runtime generate.',
  async run(checks) {
    const compressed = await importImage('albedo.png', CHECKER_PNG, TEXTURE_SUB, {
      compressionMode: 'uastc',
      mipmap: true,
    });
    checks.ok(
      'compressed mipmapped import ok',
      compressed.ok,
      compressed.ok ? undefined : compressed.code,
    );
    const body = compressed.ok ? compressed.assets[0]?.artifacts?.body : undefined;
    const parsed = body === undefined ? undefined : await parseKtx2(body.bytes);
    checks.ok('body is KTX2', parsed?.ok === true);
    checks.equal(
      'KTX2 carries the full offline chain (16x16 -> 5 levels)',
      parsed?.ok ? parsed.value.header.levelCount : undefined,
      5,
    );
    const mips = texturePayload(compressed.ok ? compressed.assets[0] : undefined)?.mips;
    checks.ok(
      'compressed payload does not request runtime mip generation',
      mips?.kind !== 'generate',
      JSON.stringify(mips),
    );

    const asset = compressed.ok ? compressed.assets[0] : undefined;
    if (asset !== undefined && body !== undefined) {
      const registry = new AssetRegistry({} as never);
      registry.transcodeCaps = { bc: true, etc2: false, astc: false };
      installMemoryPack(registry, [
        {
          guid: asset.guid,
          kind: 'texture',
          payload: { ...(asset.payload as object), data: undefined },
          artifacts: {
            body: {
              path: 'albedo/body.ktx2',
              mediaType: body.mediaType,
              assetCodec: body.assetCodec ?? {},
              bytes: body.bytes,
            },
          },
        },
      ]);
      const loaded = await registry.loadByGuid<TextureAsset>(registry.parseGuid(asset.guid));
      checks.ok(
        'runtime loads the compressed texture',
        loaded.ok,
        loaded.ok ? loaded.value.format : errorCode(loaded.error),
      );
      if (loaded.ok) {
        const layout = deriveTextureLayout({
          shape: loaded.value.shape,
          format: loaded.value.format,
          mips: loaded.value.mips,
        });
        checks.equal(
          'loaded GPU texture keeps 5 mip levels',
          layout.ok ? layout.value.levels.length : undefined,
          5,
        );
      }
    }

    const raw = await importImage('albedo.png', CHECKER_PNG, TEXTURE_SUB, {
      compressionMode: 'none',
      mipmap: true,
    });
    checks.equal(
      'uncompressed import keeps runtime generate',
      raw.ok ? texturePayload(raw.assets[0])?.mips : undefined,
      {
        kind: 'generate',
      },
    );
  },
});
