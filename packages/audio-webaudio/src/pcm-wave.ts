import type { AudioStreamManifest } from '@forgeax/engine-types';

/** Build-time only: no decoder or filesystem ownership. PCM WAV is the first stream codec. */
export async function indexPcmWave(bytes: Uint8Array): Promise<AudioStreamManifest> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (
    bytes.length < 44 ||
    tag(0) !== 'RIFF' ||
    tag(8) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    throw new Error('streaming requires a complete RIFF/WAVE PCM16 file');
  let channels = 0,
    sampleRate = 0,
    dataOffset = 0,
    dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true),
      start = offset + 8;
    if (start + size > bytes.length) throw new Error('truncated WAV chunk');
    if (tag(offset) === 'fmt ') {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16)
        throw new Error(
          'streaming supports PCM16 WAV only; compressions and float WAV are unsupported',
        );
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      if (
        (channels !== 1 && channels !== 2) ||
        sampleRate < 8000 ||
        sampleRate > 96000 ||
        view.getUint16(start + 12, true) !== channels * 2 ||
        view.getUint32(start + 8, true) !== sampleRate * channels * 2
      )
        throw new Error('unsupported PCM channel/rate/block layout');
    }
    if (tag(offset) === 'data') {
      if (dataOffset) throw new Error('multiple WAV data chunks');
      dataOffset = start;
      dataBytes = size;
    }
    offset = start + size + (size & 1);
  }
  if (
    !channels ||
    !dataOffset ||
    dataOffset > 1048576 ||
    dataBytes === 0 ||
    dataBytes % (channels * 2)
  )
    throw new Error('invalid PCM data layout');
  const frames = dataBytes / (channels * 2),
    chunkFrames = sampleRate;
  if (Math.ceil(frames / chunkFrames) > 16384)
    throw new Error('stream index exceeds 16384 windows');
  const hashes: string[] = [];
  const chunkBytes = chunkFrames * channels * 2;
  for (let offset = dataOffset; offset < dataOffset + dataBytes; offset += chunkBytes) {
    const buffer = bytes.slice(offset, Math.min(offset + chunkBytes, dataOffset + dataBytes));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer.buffer);
    hashes.push(
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  }
  return {
    format: 'wav-pcm16/1',
    sampleRate,
    channels: channels as 1 | 2,
    frames,
    dataOffset,
    chunkFrames,
    hashes,
  };
}
