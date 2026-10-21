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
    'A UASTC-LDR KTX2 texture keeps its encoded source in the asset registry; each renderer derives the best format its device allows (BC7, ASTC, ETC2, else RGBA8) and samples it through a Standard material.',
  expect:
    'ON: the quad shows the red/blue checker transcoded from KTX2. OFF: plain white. Checks: selectTranscodeTarget picks bc7 with BC caps, astc with ASTC only, rgba8 with none, and the loaded asset preserves the 16x16 KTX2 source bytes while the rendered checker differs from the white control.',
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
      await installMemoryPack(
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
        const payload = assets.read(texture).unwrap();
        const encoded = base64Bytes(CHECKER_KTX2_BASE64);
        checks.push({
          name: 'asset preserves the encoded texture source',
          ok:
            payload.shape.extent.width === 16 &&
            payload.encoding === 'ktx2' &&
            payload.data.length === encoded.length &&
            payload.data.every((byte, index) => byte === encoded[index]),
          detail: `${payload.shape.extent.width}x${payload.shape.extent.height} ${payload.encoding} ${payload.data.length}B`,
        });
      }
    }
    const toggle = texturedQuad(world, texture);
    return { toggle, checks: () => checks };
  },
});
