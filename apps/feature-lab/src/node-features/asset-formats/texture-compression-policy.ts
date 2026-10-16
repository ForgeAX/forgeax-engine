import { parseKtx2 } from '@forgeax/engine/codec';
import { basisEncodeParamsFor, resolveEncodeMode } from '@forgeax/engine/image/ktx2-encode';
import { defineFeature } from '../../lab/feature';
import { CHECKER_PNG, importImage, TEXTURE_SUB } from './support/image-import';

const LDR_SRGB = { colorSpace: 'srgb', isHdr: false, mipmap: false } as const;
const LDR_LINEAR = { colorSpace: 'linear', isHdr: false } as const;
const HDR = { colorSpace: 'linear', isHdr: true } as const;

export default defineFeature({
  title: 'Texture compression policy',
  catalog: 'Texture compression policy',
  kind: 'headless',
  summary:
    'compressionMode auto/etc1s/uastc/none resolves once from color space and HDR-ness, and the image importer emits either a raw rgba8 body or a Basis KTX2 body accordingly.',
  expect:
    'auto picks etc1s for srgb, uastc for linear and uastc-hdr for HDR; an explicit uastc on a PNG yields a parseable image/ktx2 body with codec basis, none keeps rgba8, and two runs are byte-identical.',
  async run(checks) {
    checks.equal('auto + srgb', resolveEncodeMode('auto', LDR_SRGB), 'etc1s');
    checks.equal('auto + linear', resolveEncodeMode('auto', LDR_LINEAR), 'uastc');
    checks.equal('auto + HDR', resolveEncodeMode('auto', HDR), 'uastc-hdr');
    checks.equal('uastc + HDR upgrades', resolveEncodeMode('uastc', HDR), 'uastc-hdr');
    checks.equal('none never encodes', basisEncodeParamsFor('none', LDR_SRGB), null);
    checks.equal('etc1s srgb encoder params', basisEncodeParamsFor('etc1s', LDR_SRGB)?.srgb, true);

    const uastc = await importImage('albedo.png', CHECKER_PNG, TEXTURE_SUB, {
      compressionMode: 'uastc',
    });
    checks.ok('uastc import ok', uastc.ok, uastc.ok ? undefined : uastc.code);
    const body = uastc.ok ? uastc.assets[0]?.artifacts?.body : undefined;
    checks.equal('uastc body media type', body?.mediaType, 'image/ktx2');
    checks.equal(
      'uastc body codec',
      [body?.assetCodec?.name, body?.assetCodec?.profile],
      ['basis', 'uastc'],
    );
    const parsed = body === undefined ? undefined : await parseKtx2(body.bytes);
    checks.ok('uastc body parses as KTX2', parsed?.ok === true);

    const again = await importImage('albedo.png', CHECKER_PNG, TEXTURE_SUB, {
      compressionMode: 'uastc',
    });
    const againBytes = again.ok ? again.assets[0]?.artifacts?.body?.bytes : undefined;
    checks.ok(
      'encoding is deterministic',
      body !== undefined &&
        againBytes !== undefined &&
        Buffer.from(body.bytes).equals(Buffer.from(againBytes)),
    );

    const none = await importImage('albedo.png', CHECKER_PNG, TEXTURE_SUB, {
      compressionMode: 'none',
    });
    checks.equal(
      'none keeps raw rgba8',
      none.ok ? none.assets[0]?.artifacts?.body?.assetCodec?.name : undefined,
      'rgba8',
    );
  },
});
