import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuildDdcInput,
  DdcEntryStore,
  DdcLifecycle,
  ddcOutputDigest,
  semanticBuildKey,
} from '@forgeax/engine-ddc';
import { afterEach, describe, expect, it } from 'vitest';

const GUID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

function semantic(sourceOverrides?: Record<string, unknown>): BuildDdcInput {
  return {
    schemaVersion: '2.0.0',
    importerVersion: 'fixture@1',
    codecVersion: 'fixture-codec@1',
    sourceDependencies: [{ path: 'model.source', digest: 'source-digest' }],
    settings: { profile: 'dev' },
    declaredGuids: [GUID],
    cookProfile: 'dev',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
  } as BuildDdcInput;
}

async function publish(root: string, key: string, payload: unknown) {
  const store = new DdcEntryStore(root);
  const entry = {
    key,
    guid: GUID,
    payload,
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'source-overrides-fixture',
      inputFingerprint: key,
      outputDigest: '',
    },
  };
  const complete = {
    ...entry,
    receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) },
  };
  await store.write(complete);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('source override DDC lifecycle', () => {
  it('makes a non-empty source override part of desired semantic identity', () => {
    const legacy = semanticBuildKey(semantic());
    const override = semanticBuildKey(semantic({ 'mesh/main': { lod: 2 } }));
    expect(override).not.toBe(legacy);
  });

  it('keeps the old current as LKG after validation failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-overrides-ddc-'));
    roots.push(root);
    const oldKey = semanticBuildKey(semantic());
    const desiredKey = semanticBuildKey(semantic({ 'mesh/main': { lod: 2 } }));
    await publish(root, oldKey, { version: 'old' });

    const lifecycle = new DdcLifecycle(root);
    const oldLease = await lifecycle.begin(GUID, oldKey);
    expect((await lifecycle.commit(oldLease, oldKey)).result).toBe('current');
    const newLease = await lifecycle.begin(GUID, desiredKey);
    await lifecycle.fail(newLease, { code: 'validation-failed', detail: 'fixture rejection' });

    await expect(new DdcEntryStore(root).read(oldKey)).resolves.toMatchObject({ guid: GUID });
    await expect(lifecycle.inspect(GUID, desiredKey)).resolves.toMatchObject({
      state: 'failed',
      currentKey: oldKey,
      lastKnownGoodKey: oldKey,
      failure: { code: 'validation-failed' },
    });
  });

  it('publishes current only after a validated entry is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-overrides-ddc-'));
    roots.push(root);
    const key = semanticBuildKey(semantic({ 'mesh/main': { lod: 1 } }));
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, key);
    expect((await lifecycle.commit(lease, key)).result).toBe('invalid');
    expect((await lifecycle.inspect(GUID, key)).state).toBe('failed');

    await publish(root, key, { version: 'validated' });
    const retry = await lifecycle.begin(GUID, key);
    expect((await lifecycle.commit(retry, key)).result).toBe('current');
    expect((await lifecycle.inspect(GUID, key)).state).toBe('current');
  });
});
