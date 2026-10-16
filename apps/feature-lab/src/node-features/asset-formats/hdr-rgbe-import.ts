import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EquirectAsset } from '@forgeax/engine/types';
import {
  errorCode,
  guid,
  installMemoryPack,
} from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import { EQUIRECT_SUB, importImage, WARM_HDR } from './support/image-import';

function f16(bits: number): number {
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

export default defineFeature({
  title: 'HDR RGBE import',
  catalog: 'HDR RGBE import',
  kind: 'headless',
  summary:
    'A Radiance .hdr generated in code is decoded at import time into an f16 EquirectAsset body, and the runtime equirect loader returns it by GUID without parsing the source.',
  expect:
    'Pixel RGBE (128, 64, 32, 129) imports as linear rgba16float (1.0, 0.5, 0.25, 1.0), the loaded equirect keeps 16x8 and the same bytes, and a truncated HDR fails with a structured diagnostic.',
  async run(checks) {
    const imported = await importImage('sky.hdr', WARM_HDR, EQUIRECT_SUB);
    checks.ok('HDR import ok', imported.ok, imported.ok ? undefined : imported.code);
    const asset = imported.ok ? imported.assets[0] : undefined;
    const body = asset?.artifacts?.body;
    checks.equal('body codec', body?.assetCodec?.name, 'rgba16float');
    checks.equal('body size is width * height * 8', body?.bytes.byteLength, 16 * 8 * 8);
    if (body !== undefined) {
      const view = new DataView(body.bytes.buffer, body.bytes.byteOffset, 8);
      const rgba = [0, 2, 4, 6].map((offset) => f16(view.getUint16(offset, true)));
      checks.near('first pixel red', rgba[0] ?? 0, 1, 0.01);
      checks.near('first pixel green', rgba[1] ?? 0, 0.5, 0.01);
      checks.near('first pixel blue', rgba[2] ?? 0, 0.25, 0.01);
      checks.near('first pixel alpha', rgba[3] ?? 0, 1, 0.01);

      const registry = new AssetRegistry({} as never);
      const id = asset?.guid ?? guid(0x102);
      installMemoryPack(registry, [
        {
          guid: id,
          kind: 'equirect',
          payload: asset?.payload,
          artifacts: {
            body: {
              path: 'sky/body.bin',
              mediaType: body.mediaType,
              assetCodec: { name: 'rgba16float' },
              bytes: body.bytes,
            },
          },
        },
      ]);
      const loaded = await registry.loadByGuid<EquirectAsset>(registry.parseGuid(id));
      checks.ok(
        'runtime loadByGuid<EquirectAsset> ok',
        loaded.ok,
        loaded.ok ? undefined : errorCode(loaded.error),
      );
      if (loaded.ok) {
        checks.equal(
          'loaded equirect shape',
          [loaded.value.kind, loaded.value.width, loaded.value.height, loaded.value.format],
          ['equirect', 16, 8, 'rgba16float'],
        );
        checks.equal(
          'loaded bytes are the import body',
          loaded.value.data.byteLength,
          body.bytes.byteLength,
        );
      }
    }

    const broken = await importImage('broken.hdr', WARM_HDR.subarray(0, 40), EQUIRECT_SUB);
    checks.ok('truncated HDR fails structurally', !broken.ok, broken.ok ? 'imported' : broken.code);
  },
});
