import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, ddcOutputDigest } from '@forgeax/engine-ddc';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePackWorklist } from '../scriptable-pack-build.js';
import { createScriptablePackProductCache } from '../scriptable-pack-product-cache.js';

const revision = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-publication-'));
  const parentId = definePackageId('01900000-0000-7000-8000-000000008122');
  const childId = definePackageId('01900000-0000-7000-8000-000000008123');
  const guid = AssetGuid.derive(parentId, 'scene');
  const childGuid = AssetGuid.format(AssetGuid.derive(childId, 'scene'));
  const parentSource = join(root, 'z-source.pack.ts');
  const childSource = join(root, 'a-dependent.pack.ts');
  await Promise.all([writeFile(parentSource, 'parent'), writeFile(childSource, 'child')]);
  const builds = { parent: 0, child: 0 };
  const visits = { parent: 0, child: 0 };
  const outputs = new AssetOutputProducerRegistry();
  outputs.register({
    kind: 'scene',
    version: 'fixture/1',
    produce: ({ asset }) => ok({ payload: asset as never, refs: [], artifacts: {} }),
  });
  const cacheRoot = join(root, 'ddc');
  const cache = await createScriptablePackProductCache({
    root: cacheRoot,
    outputVersions: { scene: 'fixture/1' },
    cookers: [],
  });
  const run = (maxConcurrency = 1, text = 'parent', missing = false, maxPasses?: number) =>
    buildScriptablePackWorklist({
      maxConcurrency,
      ...(maxPasses === undefined ? {} : { maxPasses }),
      onProgress: ({ phase, sourcePath }) => {
        if (phase === 'cache') visits[sourcePath === parentSource ? 'parent' : 'child']++;
      },
      outputs,
      cache,
      subjects: [
        {
          sourcePath: childSource,
          sourceClosure: [{ path: childSource, digest: revision('child') }],
          definition: definePack({
            schemaVersion: '2.0.0',
            packageId: childId,
            async build(context) {
              builds.child++;
              const source = await context.readByGuid(guid);
              return source.ok ? ok({ scene: source.value }) : source;
            },
          }),
        },
        {
          sourcePath: parentSource,
          sourceClosure: [{ path: parentSource, digest: revision(text) }],
          definition: definePack({
            schemaVersion: '2.0.0',
            packageId: parentId,
            build() {
              builds.parent++;
              return ok(
                missing
                  ? {}
                  : {
                      scene: {
                        kind: 'scene' as const,
                        entities: text === 'parent' ? {} : { changed: { components: {} } },
                      },
                    },
              );
            },
          }),
        },
      ],
    });
  const editHints = async (
    source: string,
    change: (payload: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const store = new DdcEntryStore(join(cacheRoot, 'scriptable-pack-product-kinds'));
    let changedCount = 0;
    for (const key of await store.listKeys()) {
      const entry = await store.read(key);
      if (entry === null || !(entry.payload as { sourcePath: string }).sourcePath.endsWith(source))
        continue;
      const changed = {
        ...entry,
        payload: change(entry.payload as Record<string, unknown>),
        receipt: { ...entry.receipt },
      };
      changed.receipt.outputDigest = ddcOutputDigest(changed);
      await store.remove(key);
      await store.write(changed);
      changedCount++;
    }
    expect(changedCount).toBe(1);
  };
  return { root, cache, cacheRoot, parentSource, guid, childGuid, builds, visits, run, editHints };
}

it.each([
  1, 2, 4,
])('validates a cached consumer after its producer is published with %i preparation lanes', async (concurrency) => {
  const f = await fixture();
  try {
    expect((await f.run(concurrency)).ok).toBe(true);
    f.builds.parent = 0;
    f.builds.child = 0;
    f.visits.parent = 0;
    f.visits.child = 0;
    const warm = await f.run(concurrency);
    expect(warm.ok).toBe(true);
    expect(f.builds).toEqual({ parent: 0, child: 0 });
    expect(f.visits).toEqual({ parent: 1, child: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('waits for a legacy producer without changing its immutable topology header', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints(
      'z-source.pack.ts',
      ({ outputs: _outputs, reads: _reads, ...legacy }) => legacy,
    );
    f.builds.parent = 0;
    f.builds.child = 0;
    expect((await f.run(2)).ok).toBe(true);
    expect(f.builds).toEqual({ parent: 0, child: 0 });
    await f.editHints('z-source.pack.ts', (payload) => {
      expect(payload.outputs).toBeUndefined();
      expect(payload.reads).toBeUndefined();
      return payload;
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('does not wait on a consumer own output recorded in advisory discovery', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints('a-dependent.pack.ts', (payload) => ({
      ...payload,
      reads: [...(payload.reads as string[]), f.childGuid],
    }));
    f.builds.parent = 0;
    f.builds.child = 0;
    expect((await f.run(2)).ok).toBe(true);
    expect(f.builds).toEqual({ parent: 0, child: 0 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('still rebuilds a cached consumer when the published producer digest changes', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    f.builds.parent = 0;
    f.builds.child = 0;
    await writeFile(f.parentSource, 'changed');
    expect((await f.run(2, 'changed')).ok).toBe(true);
    expect(f.builds).toEqual({ parent: 1, child: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('fails missing producer output within the ordinary bounded dependency worklist', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await writeFile(f.parentSource, 'missing');
    const missing = await f.run(2, 'missing', true);
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'pack-content-dependency-stalled' },
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('falls back from a stale cycle in real DDC dependency hints without deadlocking', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints('z-source.pack.ts', (payload) => ({ ...payload, reads: [f.childGuid] }));
    const result = await f.run(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.iterations).toBeLessThanOrEqual(3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('tries an advisory-skipped producer after a partially ready pass stalls within the same pass budget', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints('a-dependent.pack.ts', (payload) => ({ ...payload, reads: [] }));
    await f.editHints('z-source.pack.ts', (payload) => ({ ...payload, reads: [f.childGuid] }));
    f.builds.parent = 0;
    f.builds.child = 0;
    f.visits.parent = 0;
    f.visits.child = 0;
    const result = await f.run(1, 'parent', false, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.iterations).toBe(2);
    expect(f.builds).toEqual({ parent: 0, child: 1 });
    expect(f.visits).toEqual({ parent: 1, child: 2 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('does not retry the ready subset when skipped producers still cannot supply a real dependency', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints('a-dependent.pack.ts', (payload) => ({ ...payload, reads: [] }));
    await f.editHints('z-source.pack.ts', (payload) => ({ ...payload, reads: [f.childGuid] }));
    await writeFile(f.parentSource, 'missing');
    f.builds.parent = 0;
    f.builds.child = 0;
    f.visits.parent = 0;
    f.visits.child = 0;
    const result = await f.run(1, 'missing', true, 2);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'pack-content-dependency-stalled', detail: { iterations: 2 } },
    });
    expect(f.builds).toEqual({ parent: 1, child: 2 });
    expect(f.visits).toEqual({ parent: 1, child: 2 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('propagates a ready-subset cache failure without attempting advisory-skipped producers', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).ok).toBe(true);
    await f.editHints('a-dependent.pack.ts', (payload) => ({ ...payload, reads: [] }));
    await f.editHints('z-source.pack.ts', (payload) => ({ ...payload, reads: [f.childGuid] }));
    f.visits.parent = 0;
    f.visits.child = 0;
    const primary = new Error('ready cache read failed');
    f.cache.read = async () => {
      throw primary;
    };
    await expect(f.run(1, 'parent', false, 2)).rejects.toBe(primary);
    expect(f.visits).toEqual({ parent: 0, child: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
