import { createDefaultLoaderRegistry } from '@forgeax/engine/assets-runtime';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '@forgeax/engine/pack/source';
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
  title: 'Asset kind/runtime loader matrix',
  catalog: 'Asset kind/runtime loader matrix',
  kind: 'headless',
  summary:
    'createDefaultLoaderRegistry() wires one runtime loader per ordinary Asset kind; video is a URL descriptor.',
  expect:
    'Every catalog kind has a loader and a ScriptablePack output kind; video loads from a URL payload without artifacts.',
  run(checks) {
    const loaders = createDefaultLoaderRegistry();
    const wired = new Set(loaders.registeredKinds());
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

    const video = loaders.get('video') as { load(payload: unknown): unknown } | undefined;
    const loaded = video?.load({ url: 'https://feature-lab.invalid/clip.mp4' }) as
      | { kind?: string; url?: string }
      | undefined;
    checks.equal('video loader returns a URL descriptor', loaded, {
      kind: 'video',
      url: 'https://feature-lab.invalid/clip.mp4',
    });
    checks.equal('video loader rejects a non-URL payload', video?.load({ url: 42 }), undefined);
    checks.equal(
      'unknown kinds are not silently wired',
      loaders.get('lab-unknown-kind'),
      undefined,
    );
  },
});
