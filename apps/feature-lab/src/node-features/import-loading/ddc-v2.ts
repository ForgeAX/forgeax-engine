import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DdcEntry,
  DdcEntryStore,
  ddcOutputDigest,
  defaultBuildCacheRoot,
  resolveRuntimeDdcRoot,
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
    'The Node-only derived-data cache: isolated runtime scopes under the project root, a semantic content key over importer inputs, and an immutable entry store where staged data is invisible until an atomic publish. It is disposable: deleting it only costs a recook.',
  expect:
    'Runtime scopes remain distinct under the injected project root; equal inputs give one key regardless of settings order and any byte change gives another; a staged entry is invisible until publish; a republish is "existing"; a tampered receipt reads as a miss; deleting the cache root is a clean miss.',
  async run(checks) {
    const root = await mkdtemp(join(tmpdir(), 'feature-lab-ddc-'));
    try {
      const projectRoot = join(root, '.forgeax/ddc/v2');
      const cache = defaultBuildCacheRoot(root);
      checks.equal(
        'default build root stays separate',
        cache,
        join(root, '.forgeax/ddc/build-cache'),
      );
      const binding = { scopeId: 'editor_main', generation: 1 };
      const scoped = resolveRuntimeDdcRoot(projectRoot, binding);
      checks.equal(
        'runtime root stays in the project scope',
        scoped,
        join(projectRoot, 'runtime/editor_main-1'),
      );
      checks.ok(
        'scope IDs do not alias',
        resolveRuntimeDdcRoot(projectRoot, { ...binding, scopeId: 'editor/main' }) !== scoped,
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

      await writeFile(join(cache, 'entries', key, 'entry.json'), '{}');
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
