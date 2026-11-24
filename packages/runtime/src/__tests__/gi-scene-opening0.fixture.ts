import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Lossless metadata bytes from actual historical opening0/frame115.
 * This is not the absent original averaged window or current GPU acceptance. */
const provenance = {
  sourceHead: 'dec5c69db325e81cdafa13e869f16c87fac67032',
  ciRun: '42856479668',
  frameId: 115,
  width: 96,
  height: 64,
  backend: 'webgpu',
  adapter: 'Historical Mesa llvmpipe; not current Native/GPU acceptance',
  sources: [
    {
      path: 'C:/w/gi-pr4980-ci-20261109/dec5c69-physical-artifacts-v1/gi-scene-failure-images-dawn-4-1/gi-scenes/rooms-field-yaw-roll/opening-0-signal.f32',
      bytes: 98304,
      sha256: 'b7ff88b2d28a6e26c6480ba69157d72e9b5a068a09a05c5262003a4356e2b3fa',
    },
    {
      path: 'C:/w/gi-pr4980-ci-20261109/dec5c69-physical-artifacts-v1/gi-scene-failure-images-dawn-4-1/gi-scenes/rooms-field-yaw-roll/opening-0-visible.u8',
      bytes: 6144,
      sha256: 'f8cfd35f9e1becca1c3d61a2dc7c72f9ffc2ddbe2db5292d1f4ed97d0901f51d',
    },
    {
      path: 'C:/w/gi-pr4980-ci-20261109/dec5c69-physical-artifacts-v1/gi-scene-failure-images-dawn-4-1/gi-scenes/rooms-field-yaw-roll/opening-0-observation.json',
      bytes: 704,
      sha256: '90beced03e21990ba97f92ddc5dba14ae685eaffc2785163e72c867ca7fca932',
    },
  ],
  projection:
    'Exact visible.u8 and fourth little-endian f32 word of each signal RGBA record; RGB is not included',
  coveredSHA256: 'f8cfd35f9e1becca1c3d61a2dc7c72f9ffc2ddbe2db5292d1f4ed97d0901f51d',
  supportSHA256: 'a0f8a72a048d5f8a7d2eb5fdc3b1600ddbe8995b907fda5af200aed92a2193bf',
} as const;
const coveredGzip =
  'H4sIAAAAAAAACu3MQQ0AAAgEoLN/aTc7OH1AAJLUmgy/3+/3+/1+v9/v9/v9fv/hv5cD8FkDAZ84egAYAAA=';
const supportGzip =
  'H4sIAAAAAAAACu3QMQrDQBAEQf3MX/PTHQkcOJIFp72ugcqHPo7vvV+zTPx8/v611b/0R//96a9/mf76//t/9Ydy/+km95/yU//nmtx/B1P7T/i4c/9d6K//lc+rP5T770R//cv0179Mf/3L9Ne/TH/9y/TXv0x//cv0179Mf/3L9Ne/TH/9y/TXv0x//cv0179Mf/3L9H9O/9VfAAAAAACAu30AHUxz9QBgAAA=';

export function opening0SupportWitness() {
  const covered = Uint8Array.from(gunzipSync(Buffer.from(coveredGzip, 'base64')));
  const bytes = gunzipSync(Buffer.from(supportGzip, 'base64'));
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  if (
    covered.length !== 6144 ||
    bytes.length !== 24576 ||
    hash(covered) !== provenance.coveredSHA256 ||
    hash(bytes) !== provenance.supportSHA256
  )
    throw Error('Historical opening0 metadata fixture bytes changed');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const support = Float32Array.from({ length: 6144 }, (_, pixel) =>
    data.getFloat32(pixel * 4, true),
  );
  return { provenance, image: { covered, support } };
}
