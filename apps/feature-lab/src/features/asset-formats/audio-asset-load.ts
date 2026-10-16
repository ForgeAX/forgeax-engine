import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { AudioClipAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { errorCode, guid, installMemoryPack } from './fixtures/memory-pack';

const CLIP = guid(0x751);

/** 8 mono 16-bit samples of silence in a canonical RIFF/WAVE container. */
function tinyWav(): Uint8Array {
  const bytes = new Uint8Array(44 + 16);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + 16, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, 16, true);
  return bytes;
}

export default defineFeature({
  title: 'Audio asset load',
  catalog: 'Audio asset load',
  kind: 'probe',
  summary:
    'A Pack v2 audio row with a browser-audio source artifact loads through loadByGuid into an AudioClipAsset POD (sourceKey, mediaType, bytes); decoding is deferred to the Host Web Audio consumer, so the Engine realm never creates an AudioContext.',
  expect:
    'The clip loads through app.assets with sourceKey equal to its GUID, mediaType audio/wav and the 60 RIFF bytes intact; a second load returns the same cached object; an unknown GUID fails structurally.',
  async setup({ app, world }) {
    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const assets = app.assets;
    const parsed = AssetGuid.parse(CLIP);
    const unknown = AssetGuid.parse(guid(0x7ff));
    if (assets === undefined || !parsed.ok || !unknown.ok)
      return { checks: () => [{ name: 'app.assets and GUIDs present', ok: false }] };
    const wav = tinyWav();
    installMemoryPack(
      assets,
      [
        {
          guid: CLIP,
          kind: 'audio',
          payload: { kind: 'audio', mediaType: 'audio/wav' },
          artifacts: {
            source: {
              path: 'audio/tiny.wav',
              mediaType: 'audio/wav',
              bytes: wav,
              assetCodec: { name: 'browser-audio' },
            },
          },
        },
      ],
      'https://feature-lab.invalid/asset-formats/audio.pack.json',
    );
    const first = await assets.loadByGuid<AudioClipAsset>(parsed.value);
    checks.push({
      name: 'audio row loads',
      ok: first.ok,
      ...(first.ok ? {} : { detail: errorCode(first.error) }),
    });
    if (first.ok) {
      const clip = first.value;
      checks.push({
        name: 'sourceKey is the GUID',
        ok: clip.sourceKey === CLIP,
        detail: String(clip.sourceKey),
      });
      checks.push({ name: 'mediaType audio/wav', ok: clip.mediaType === 'audio/wav' });
      checks.push({
        name: 'RIFF bytes intact',
        ok: !clip.stream && clip.bytes.byteLength === wav.byteLength && clip.bytes[0] === 0x52,
        detail: clip.stream ? 'unexpected streaming clip' : `${clip.bytes.byteLength}B`,
      });
      const second = await assets.loadByGuid<AudioClipAsset>(parsed.value);
      checks.push({ name: 'second load is cached', ok: second.ok && second.value === clip });
    }
    const missing = await assets.loadByGuid<AudioClipAsset>(unknown.value);
    checks.push({
      name: 'unknown GUID fails',
      ok: !missing.ok,
      detail: missing.ok ? 'loaded' : errorCode(missing.error),
    });
    return { checks: () => checks };
  },
});
