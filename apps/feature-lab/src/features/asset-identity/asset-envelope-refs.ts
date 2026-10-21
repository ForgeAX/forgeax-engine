import { AssetRegistry, defineAssetKind } from '@forgeax/engine/assets-runtime';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { installMemoryPack } from '../asset-formats/fixtures/memory-pack';

const ROOT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const MID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02';
const LEAF = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03';
const BROKEN = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b09';
const MISSING = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4bff';
const PACK_URL = 'https://feature-lab.invalid/refs.pack.json';

const node = (guid: string, name: string, refs: readonly string[]) => ({
  guid,
  kind: 'lab-node',
  payload: { name, ...(refs.length > 0 ? { child: 0 } : {}) },
  refs,
  artifacts: {},
});

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    node(ROOT, 'root', [MID]),
    node(MID, 'mid', [LEAF]),
    node(LEAF, 'leaf', []),
    node(BROKEN, 'broken', [MISSING]),
  ],
};

export default defineFeature({
  title: 'AssetEnvelope refs',
  catalog: 'AssetEnvelope refs',
  kind: 'headless',
  summary:
    'Each envelope lists its dependencies in `refs`; payload fields point at refs by index and assets.load admits the complete graph.',
  expect:
    'Loading the root resolves mid and leaf transitively; a dangling ref fails with a structured error naming its referrer.',
  async run(checks) {
    const assets = new AssetRegistry();
    const nodeKind = defineAssetKind<{ name: string; child?: number }>('lab-node');
    const seen: string[] = [];
    assets.installDecoder(nodeKind, {
      decode: async ({ envelope }) => {
        seen.push(String(envelope.payload.name));
        return ok(envelope.payload);
      },
    });
    await installMemoryPack(assets, PACK.assets, PACK_URL);

    const root = await assets.load(ROOT, nodeKind);
    checks.ok('root loads', root.ok, root.ok ? undefined : root.error.code);
    checks.ok('root is decoded', seen.includes('root'));
    checks.ok('mid is loaded through refs', seen.includes('mid'));
    checks.ok('leaf is loaded recursively', seen.includes('leaf'));

    const broken = await assets.load(BROKEN, nodeKind);
    checks.equal(
      'dangling ref is a structured failure',
      broken.ok ? 'ok' : broken.error.code,
      'asset-not-found',
    );
    checks.ok(
      'failure names the missing ref',
      !broken.ok && JSON.stringify(broken.error).includes(MISSING),
    );
    assets.dispose();
  },
});
