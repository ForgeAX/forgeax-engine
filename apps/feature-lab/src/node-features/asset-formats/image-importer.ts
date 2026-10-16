import { checker } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import {
  CHECKER_PNG,
  EQUIRECT_SUB,
  importImage,
  TEXTURE_SUB,
  texturePayload,
  WARM_HDR,
} from './support/image-import';

export default defineFeature({
  title: 'Image importer',
  catalog: 'Image importer',
  kind: 'headless',
  summary:
    'imageImporter turns a PNG into a TextureAsset with a raw rgba8 body and a Radiance HDR into an f16 EquirectAsset, both from bytes generated in code.',
  expect:
    'The PNG yields a 16x16 texture whose body matches the source pixels byte for byte, srgb selects rgba8unorm-srgb, the HDR yields an rgba16float equirect, and corrupt bytes fail with a structured import error.',
  async run(checks) {
    const png = await importImage('hero.png', CHECKER_PNG, TEXTURE_SUB);
    checks.ok('PNG import ok', png.ok, png.ok ? undefined : png.code);
    if (png.ok) {
      const asset = png.assets[0];
      const texture = texturePayload(asset);
      checks.equal(
        'one texture output',
        png.assets.map((a) => a.kind),
        ['texture'],
      );
      checks.equal('texture shape', texture?.shape, {
        viewDimension: '2d',
        extent: { width: 16, height: 16 },
      });
      checks.equal('linear default format', texture?.format, 'rgba8unorm');
      checks.equal('raw rgba8 codec', asset?.artifacts?.body?.assetCodec?.name, 'rgba8');
      const body = asset?.artifacts?.body?.bytes;
      checks.ok(
        'body equals decoded pixels',
        body !== undefined && Buffer.from(body).equals(Buffer.from(checker())),
      );
    }

    const srgb = await importImage('hero.png', CHECKER_PNG, TEXTURE_SUB, { colorSpace: 'srgb' });
    checks.equal(
      'srgb setting selects the srgb format',
      srgb.ok ? texturePayload(srgb.assets[0])?.format : undefined,
      'rgba8unorm-srgb',
    );

    const hdr = await importImage('sky.hdr', WARM_HDR, EQUIRECT_SUB);
    checks.ok('HDR import ok', hdr.ok, hdr.ok ? undefined : hdr.code);
    if (hdr.ok) {
      const payload = hdr.assets[0]?.payload as
        | { kind?: string; format?: string; width?: number; height?: number }
        | undefined;
      checks.equal('HDR produces an equirect', payload?.kind, 'equirect');
      checks.equal(
        'equirect is rgba16float 16x8',
        [payload?.format, payload?.width, payload?.height],
        ['rgba16float', 16, 8],
      );
    }

    const corrupt = await importImage('broken.png', new Uint8Array([1, 2, 3, 4]), TEXTURE_SUB);
    checks.ok(
      'corrupt PNG fails without throwing',
      !corrupt.ok,
      corrupt.ok ? 'imported' : corrupt.code,
    );
  },
});
