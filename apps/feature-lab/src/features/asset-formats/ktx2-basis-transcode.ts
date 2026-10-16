import { selectTranscodeTarget } from '@forgeax/engine/codec';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { CHECKER_KTX2_BASE64 } from './fixtures/encoded';
import { base64Bytes, guid, installMemoryPack } from './fixtures/memory-pack';
import { loadTexture, texturedQuad } from './fixtures/texture-quad';

const TEXTURE = guid(0x711);
const PACK_URL = 'https://feature-lab.invalid/asset-formats/ktx2.pack.json';
const NONE = { bc: false, etc2: false, astc: false };

export default defineFeature({
  title: 'KTX2/Basis transcode',
  catalog: 'KTX2/Basis transcode',
  kind: 'visual',
  summary:
    'A UASTC-LDR KTX2 texture body is transcoded at load time by the Basis WASM transcoder to the best format the registry transcode caps allow (BC7, ASTC, ETC2, else RGBA8), then sampled by a Standard material.',
  expect:
    'ON: the quad shows the red/blue checker transcoded from KTX2. OFF: plain white. Checks: selectTranscodeTarget picks bc7 with BC caps, astc with ASTC only, rgba8 with none, and the loaded texture is 16x16 in a format matching registry.transcodeCaps.',
  async setup({ app, world }) {
    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const source = { model: 'uastc-ldr', srgb: true, channels: 'rgba' } as const;
    const table = [
      selectTranscodeTarget(source, { ...NONE, bc: true }),
      selectTranscodeTarget(source, { ...NONE, astc: true }),
      selectTranscodeTarget(source, NONE),
    ];
    checks.push({
      name: 'target selection BC7 > ASTC > RGBA8',
      ok: table.join() === 'bc7-rgba-unorm-srgb,astc-4x4-unorm-srgb,rgba8unorm-srgb',
      detail: table.join(),
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
              mips: { kind: 'none' },
            },
            artifacts: {
              body: {
                path: 'ktx2/checker.ktx2',
                mediaType: 'image/ktx2',
                bytes: base64Bytes(CHECKER_KTX2_BASE64),
                assetCodec: { name: 'basis', container: 'ktx2', profile: 'uastc-ldr' },
              },
            },
          },
        ],
        PACK_URL,
      );
      texture = await loadTexture(assets, TEXTURE, checks);
      if (texture !== undefined) {
        const expected = selectTranscodeTarget(source, assets.transcodeCaps);
        checks.push({
          name: 'transcoded to the caps-selected format',
          ok: texture.shape.extent.width === 16 && texture.format === expected,
          detail: `${texture.shape.extent.width}x${texture.shape.extent.height} ${texture.format} (caps ${JSON.stringify(assets.transcodeCaps)})`,
        });
      }
    }
    const toggle = texturedQuad(world, texture);
    return { toggle, checks: () => checks };
  },
});
