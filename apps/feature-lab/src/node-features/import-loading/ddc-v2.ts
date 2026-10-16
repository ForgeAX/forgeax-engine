import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DDC_LAYOUT_VERSION,
  type DdcEntry,
  DdcEntryStore,
  ddcOutputDigest,
  resolveDdcLayout,
  semanticDdcKey,
} from '@forgeax/engine/ddc';
import { defineFeature } from '../../lab/feature';

const GUID = '019f1a00-0000-7000-8000-0000000001d1';

function entryFor(key: string): DdcEntry {
  const base = {
    key,
    guid: GUID,
    payload: { kind: 'texture', width: 1, height: 1 },
    refs: [],
    artifacts: {
      payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
    },
    receipt: {
      guid: GUID,
      key,
      producer: 'feature-lab@1',
      inputFingerprint: 'lab',
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...base, receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) } };
}

const semantic = (settings: unknown, bytes: Uint8Array) =>
  semanticDdcKey({
    schemaVersion: '2',
    importer: 'image',
    codec: 'none',
    settings,
    sourceBytes: [bytes],
    declaredGuids: [GUID],
    targetProfile: 'webgpu',
    producer: 'feature-lab@1',
  });

export default defineFeature({
  title: 'DDC v2',
  catalog: 'DDC v2',
  kind: 'headless',
  summary:
    'The Node-only derived-data cache: an absolute injected layout, a semantic content key over importer inputs, and an immutable entry store where staged data is invisible until an atomic publish. It is disposable: deleting it only costs a recook.',
  expect:
    'Layout v2 needs absolute roots and an explicit projectDdcRoot; equal inputs give one key regardless of settings order and any byte change gives another; a staged entry is invisible until publish; a republish is "existing"; a tampered receipt reads as a miss; deleting the cache root is a clean miss.',
  async run(checks) {
    const root = await mkdtemp(join(tmpdir(), 'feature-lab-ddc-'));
    try {
      const layout = resolveDdcLayout({
        buildCacheRoot: join(root, 'build'),
        projectDdcRoot: join(root, 'project'),
      });
      checks.ok(
        'layout resolves with absolute roots',
        layout.ok && layout.value.version === DDC_LAYOUT_VERSION,
      );
      const relative = resolveDdcLayout({
        buildCacheRoot: 'relative/build',
        projectDdcRoot: join(root, 'project'),
      });
      checks.equal(
        'relative root code',
        relative.ok ? 'ok' : relative.error.code,
        'ddc-root-absolute-required',
      );
      const unscoped = resolveDdcLayout({ buildCacheRoot: join(root, 'build') });
      checks.equal(
        'missing projectDdcRoot code',
        unscoped.ok ? 'ok' : unscoped.error.code,
        'ddc-project-root-required',
      );

      const bytes = new Uint8Array([7, 7, 7]);
      const key = semantic({ a: 1, b: 2 }, bytes);
      checks.ok('semantic key is a sha256 hex digest', /^[0-9a-f]{64}$/.test(key));
      checks.equal(
        'settings key order does not change the key',
        semantic({ b: 2, a: 1 }, bytes),
        key,
      );
      checks.ok(
        'a source byte change changes the key',
        semantic({ a: 1, b: 2 }, new Uint8Array([7, 7, 8])) !== key,
      );

      const cache = join(root, 'entries-root');
      const store = new DdcEntryStore(cache);
      const staged = await store.stage(entryFor(key));
      checks.ok('staged entry is invisible', (await store.read(key)) === null);
      checks.equal('publish is atomic', await store.publish(staged), { result: 'published', key });
      checks.equal(
        'published entry reads back',
        (await store.read(key))?.receipt.outputDigest,
        entryFor(key).receipt.outputDigest,
      );
      checks.equal('republish keeps the immutable entry', await store.write(entryFor(key)), {
        result: 'existing',
        key,
      });

      await writeFile(
        join(cache, 'entries', key, 'receipt.json'),
        JSON.stringify({ ...entryFor(key).receipt, key: 'f'.repeat(64) }),
      );
      checks.ok('tampered receipt reads as a miss', (await store.read(key)) === null);

      await rm(cache, { recursive: true, force: true });
      checks.ok(
        'deleted cache is a clean miss',
        (await new DdcEntryStore(cache).read(key)) === null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});
