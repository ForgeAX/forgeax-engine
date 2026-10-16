import type { ArtifactDescriptor, AudioStreamManifest } from '@forgeax/engine-types';

/** Admission is independent of duration; the index itself has a fixed maximum. */
export function validAudioStream(value: unknown): value is AudioStreamManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as AudioStreamManifest;
  return (
    Object.keys(value).every((key) =>
      [
        'format',
        'sampleRate',
        'channels',
        'frames',
        'dataOffset',
        'chunkFrames',
        'hashes',
        'url',
      ].includes(key),
    ) &&
    (!('url' in value) ||
      (typeof value.url === 'string' &&
        value.url.length <= 8192 &&
        /^https?:\/\//.test(value.url))) &&
    m.format === 'wav-pcm16/1' &&
    Number.isSafeInteger(m.sampleRate) &&
    m.sampleRate >= 8000 &&
    m.sampleRate <= 96000 &&
    (m.channels === 1 || m.channels === 2) &&
    Number.isSafeInteger(m.frames) &&
    m.frames > 0 &&
    Number.isSafeInteger(m.dataOffset) &&
    m.dataOffset >= 44 &&
    m.dataOffset <= 1048576 &&
    m.chunkFrames === m.sampleRate &&
    Array.isArray(m.hashes) &&
    m.hashes.length === Math.ceil(m.frames / m.chunkFrames) &&
    m.hashes.length <= 16384 &&
    m.hashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  );
}

export function admitAudioStream(
  manifest: unknown,
  descriptor: ArtifactDescriptor,
  url: string,
): (AudioStreamManifest & { readonly url: string }) | undefined {
  if (
    !validAudioStream(manifest) ||
    descriptor.delivery !== 'stream' ||
    descriptor.mediaType !== 'audio/wav' ||
    descriptor.contentEncoding !== 'identity' ||
    descriptor.assetCodec?.name !== 'forgeax-pcm16-stream' ||
    descriptor.assetCodec.version !== '1' ||
    descriptor.byteLength === undefined ||
    !descriptor.integrity ||
    descriptor.byteLength < manifest.dataOffset + manifest.frames * manifest.channels * 2 ||
    !url ||
    !/^https?:\/\//.test(url)
  )
    return undefined;
  return { ...manifest, hashes: [...manifest.hashes], url };
}
