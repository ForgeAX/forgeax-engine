import { equirectContribution } from '@forgeax/engine-image';
import type { AssetDecoderInput, EquirectAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';

it.each([
  undefined,
  new Uint8Array(31),
])('rejects missing or truncated equirect pixels before runtime admission', async (bytes) => {
  const read = vi.fn(async () => ok(bytes ?? new Uint8Array()));
  const input: AssetDecoderInput<EquirectAsset> = {
    envelope: {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'equirect',
      payload: {
        kind: 'equirect',
        width: 2,
        height: 2,
        format: 'rgba16float',
        colorSpace: 'linear',
      } as EquirectAsset,
      refs: [],
      artifacts:
        bytes === undefined
          ? {}
          : {
              body: {
                path: 'environment.bin',
                mediaType: 'application/x-forgeax-rgba16f',
                contentEncoding: 'identity',
                byteLength: bytes.byteLength,
                integrity: {
                  algorithm: 'sha256',
                  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                },
              },
            },
    },
    artifacts: { read },
    signal: new AbortController().signal,
  };
  const result = await equirectContribution.decoder.decode(input);
  expect(result).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
  expect(read).toHaveBeenCalledTimes(bytes === undefined ? 0 : 1);
});

import { createHash } from 'node:crypto';
