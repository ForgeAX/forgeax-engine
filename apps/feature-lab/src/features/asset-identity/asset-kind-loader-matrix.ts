import { defaultAssetDecoderContributions } from '@forgeax/engine';
import { videoContribution } from '@forgeax/engine/graphics-extras';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '@forgeax/engine/pack/source';
import type { VideoAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const CATALOG_KINDS = [
  'mesh',
  'material',
  'scene',
  'texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
] as const;

export default defineFeature({
  title: 'Asset kind/runtime decoder matrix',
  catalog: 'Asset kind/runtime decoder matrix',
  kind: 'headless',
  summary:
    'The runtime assembles one domain decoder per ordinary Asset kind; Video remains a URL descriptor.',
  expect:
    'Every catalog kind has a decoder and a ScriptablePack output kind; video loads from a URL payload without artifacts.',
  async run(checks) {
    const wired = new Set(defaultAssetDecoderContributions.map((value) => value.kind.kind));
    const missing = CATALOG_KINDS.filter((kind) => !wired.has(kind));
    checks.equal('every catalog kind has a runtime loader', missing, []);
    const authorable = new Set<string>(SCRIPTABLE_PACK_ASSET_KINDS);
    checks.equal(
      'every catalog kind is a ScriptablePack output kind',
      CATALOG_KINDS.filter((kind) => !authorable.has(kind)),
      [],
    );
    checks.ok(
      'extra wired kinds are reported',
      true,
      `beyond catalog: ${[...wired].filter((kind) => !CATALOG_KINDS.includes(kind as never)).join(', ')}`,
    );

    const decode = (payload: unknown) =>
      videoContribution.decoder.decode({
        envelope: {
          guid: 'fixture',
          kind: 'video',
          payload: payload as VideoAsset,
          refs: [],
          artifacts: {},
        },
        artifacts: {
          read: async () => {
            throw new Error('Video owns no artifact');
          },
        },
        signal: new AbortController().signal,
      });
    const loaded = await decode({ kind: 'video', url: 'https://feature-lab.invalid/clip.mp4' });
    checks.equal('video decoder returns a URL descriptor', loaded.unwrap(), {
      kind: 'video',
      url: 'https://feature-lab.invalid/clip.mp4',
    });
    checks.equal(
      'video decoder rejects a non-URL payload',
      (await decode({ kind: 'video', url: 42 })).ok,
      false,
    );
    checks.equal('unknown kinds are not silently installed', wired.has('lab-unknown-kind'), false);
  },
});
