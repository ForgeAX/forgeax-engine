import { decompressZstd } from '@forgeax/engine/codec';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { CHECKER_ZSTD_BASE64 } from './fixtures/encoded';
import { base64Bytes, checker, errorCode, guid, installMemoryPack } from './fixtures/memory-pack';
import { loadTexture, texturedQuad } from './fixtures/texture-quad';

const TEXTURE = guid(0x701);
const PACK_URL = 'https://feature-lab.invalid/asset-formats/zstd.pack.json';

export default defineFeature({
  title: 'Zstd runtime decode',
  catalog: 'Zstd runtime decode',
  kind: 'visual',
  summary:
    'A Pack v2 texture body stored with contentEncoding zstd is fetched and decompressed by the runtime artifact reader before the rgba8 codec builds the TextureAsset; decompressZstd is the same kernel exposed directly.',
  expect:
    'ON: the quad shows the red/blue 16x16 checker decoded from zstd bytes. OFF: the quad turns plain white. Checks: decompressZstd round-trips to the checker bytes, garbage bytes fail structurally, and the loaded texture is 16x16 rgba8unorm-srgb.',
  async setup({ app, world }) {
    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const compressed = base64Bytes(CHECKER_ZSTD_BASE64);
    const direct = await decompressZstd(compressed);
    checks.push({
      name: 'decompressZstd equals the checker bytes',
      ok:
        direct.ok &&
        direct.value.length === 1024 &&
        direct.value.every((value, i) => value === checker()[i]),
      ...(direct.ok
        ? { detail: `${compressed.length} -> ${direct.value.length} bytes` }
        : { detail: errorCode(direct.error) }),
    });
    const garbage = await decompressZstd(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    checks.push({
      name: 'garbage zstd fails structurally',
      ok: !garbage.ok,
      detail: garbage.ok ? 'ok' : errorCode(garbage.error),
    });

    let texture: Awaited<ReturnType<typeof loadTexture>>;
    const assets = app.assets;
    if (assets === undefined) checks.push({ name: 'app.assets present', ok: false });
    else {
      installMemoryPack(
        assets,
        [
          {
            guid: TEXTURE,
            kind: 'texture',
            payload: {
              kind: 'texture',
              colorSpace: 'srgb',
              shape: { viewDimension: '2d', extent: { width: 16, height: 16 } },
              format: 'rgba8unorm-srgb',
              mips: { kind: 'none' },
            },
            artifacts: {
              body: {
                path: 'zstd/checker.bin',
                mediaType: 'application/octet-stream',
                bytes: compressed,
                assetCodec: { name: 'rgba8' },
                contentEncoding: 'zstd',
                byteLength: 1024,
              },
            },
          },
        ],
        PACK_URL,
      );
      texture = await loadTexture(assets, TEXTURE, checks);
      if (texture !== undefined) {
        checks.push({
          name: 'texture is 16x16 rgba8unorm-srgb',
          ok:
            texture.shape.extent.width === 16 &&
            texture.format === 'rgba8unorm-srgb' &&
            texture.data.byteLength === 1024,
          detail: `${texture.shape.extent.width}x${texture.shape.extent.height} ${texture.format} ${texture.data.byteLength}B`,
        });
      }
    }
    const toggle = texturedQuad(world, texture);
    return { toggle, checks: () => checks };
  },
});
