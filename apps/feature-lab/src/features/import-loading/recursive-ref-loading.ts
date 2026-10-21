import { AssetRegistry, defineAssetKind } from '@forgeax/engine/assets-runtime';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { installMemoryPack } from '../asset-formats/fixtures/memory-pack';

const ROOT = '019f1a00-0000-7000-8000-0000000000c1';
const MIDDLE = '019f1a00-0000-7000-8000-0000000000c2';
const LEAF = '019f1a00-0000-7000-8000-0000000000c3';
const PACKAGE_URL = 'https://feature-lab.invalid/refs/pack.json';

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    { guid: ROOT, kind: 'lab-root', payload: { name: 'root' }, refs: [MIDDLE], artifacts: {} },
    { guid: MIDDLE, kind: 'lab-middle', payload: { name: 'middle' }, refs: [LEAF], artifacts: {} },
    { guid: LEAF, kind: 'lab-leaf', payload: { name: 'leaf' }, refs: [], artifacts: {} },
  ],
};

export default defineFeature({
  title: 'Recursive ref loading',
  catalog: 'Recursive ref loading',
  kind: 'headless',
  summary:
    'assets.load(root, kind) walks the AssetEnvelope refs root -> middle -> leaf. The three GUIDs use three unrelated custom kinds, so traversal cannot depend on a specific asset kind.',
  expect:
    'Loading only the root prepares all three assets, decoders run owner-first (register-before-recurse), the whole closure is ready when the root promise resolves, and the Pack body is fetched once.',
  async run(checks) {
    const order: string[] = [];
    const registry = new AssetRegistry();
    const kinds = ['lab-root', 'lab-middle', 'lab-leaf'].map((name) =>
      defineAssetKind<{ kind: string; name: string }>(name),
    );
    for (const kind of kinds)
      registry.installDecoder(kind, {
        async decode({ envelope }) {
          order.push(envelope.payload.name);
          return ok(envelope.payload);
        },
      });
    const { fetched } = await installMemoryPack(registry, PACK.assets, PACKAGE_URL);
    const rootKind = kinds[0];
    if (rootKind === undefined) throw new Error('Root kind is unavailable');
    const root = await registry.load(ROOT, rootKind);
    checks.ok(
      'root loads',
      root.ok,
      root.ok ? undefined : String((root.error as { code?: unknown }).code),
    );
    if (root.ok) checks.equal('root payload', registry.read(root.value).unwrap().name, 'root');
    checks.equal('owner registers before its refs recurse', order, ['root', 'middle', 'leaf']);
    for (const [index, guid] of [ROOT, MIDDLE, LEAF].entries()) {
      const kind = kinds[index];
      if (kind === undefined) throw new Error('Asset kind is unavailable');
      const held = await registry.load(guid, kind);
      checks.ok(`closure member is already prepared: ${guid}`, held.ok);
      if (held.ok) registry.release(held.value).unwrap();
    }
    checks.equal('reading the prepared closure does not decode again', order, [
      'root',
      'middle',
      'leaf',
    ]);
    checks.equal('one Pack fetch for the closure', fetched.length, 1);
    registry.dispose();
  },
});
