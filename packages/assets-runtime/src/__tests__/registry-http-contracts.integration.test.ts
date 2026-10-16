import { createServer } from 'node:http';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import type { PackLoaderInput } from '../loader-registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
async function fixture(
  initialPack: unknown,
  load: (input: PackLoaderInput) => unknown = (input) => input.payload,
) {
  let pack = initialPack;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/catalog.json'
          ? [A, B].map((guid) => ({ guid, kind: 'review-value', packageUrl: '/value.pack.json' }))
          : pack,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener unavailable');
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.configurePackIndex(`http://127.0.0.1:${address.port}/catalog.json`);
  const release = registry.loaders.registerPackLoader({ kind: 'review-value', load });
  return {
    registry,
    setPack(value: unknown) {
      pack = value;
    },
    async close() {
      release();
      registry.invalidateAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const cycle = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    { guid: A, kind: 'review-value', payload: { kind: 'review-value', value: 'a' }, refs: [B] },
    { guid: B, kind: 'review-value', payload: { kind: 'review-value', value: 'b' }, refs: [A] },
  ],
};
it('control: one-root cyclic asset loading completes', async () => {
  const f = await fixture(cycle);
  try {
    expect((await f.registry.loadByGuid(f.registry.parseGuid(A))).ok).toBe(true);
  } finally {
    await f.close();
  }
});
it('F06 public concurrent roots of the same asset cycle both complete', async () => {
  const f = await fixture(cycle);
  try {
    const result = await Promise.race([
      Promise.all([A, B].map((guid) => f.registry.loadByGuid(f.registry.parseGuid(guid)))),
      new Promise<'deadline'>((resolve) => setTimeout(() => resolve('deadline'), 500)),
    ]);
    expect(result).not.toBe('deadline');
    if (result !== 'deadline') expect(result.every((item) => item.ok)).toBe(true);
  } finally {
    await f.close();
  }
});
it('F07 malformed HTTP pack data returns structured failure instead of rejecting', async () => {
  const f = await fixture({ assets: [null] });
  try {
    let rejected: unknown;
    let result: Awaited<ReturnType<typeof f.registry.loadByGuid>> | undefined;
    try {
      result = await f.registry.loadByGuid(f.registry.parseGuid(A));
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeUndefined();
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
  } finally {
    await f.close();
  }
});

it.each([
  'one',
  'all',
] as const)('F08 %s invalidation preserves a newer publication after an older load completes', async (mode) => {
  let releaseOld!: (value: unknown) => void;
  let oldEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    oldEntered = resolve;
  });
  let calls = 0;
  const f = await fixture(
    {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{ guid: A, kind: 'review-value', payload: { kind: 'review-value' }, refs: [] }],
    },
    () => {
      calls++;
      if (calls === 1) {
        oldEntered();
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return { kind: 'review-value', revision: 2 };
    },
  );
  try {
    const old = f.registry.loadByGuid(f.registry.parseGuid(A));
    await entered;
    if (mode === 'all') f.registry.invalidateAll();
    else f.registry.invalidate(A);
    const fresh = await f.registry.loadByGuid(f.registry.parseGuid(A));
    expect(fresh.ok).toBe(true);
    expect(f.registry.lookup(A)).toMatchObject({ revision: 2 });
    releaseOld({ kind: 'review-value', revision: 1 });
    const superseded = await old;
    expect(superseded.ok).toBe(false);
    expect(f.registry.lookup(A)).toMatchObject({ revision: 2 });
  } finally {
    await f.close();
  }
});

it.each([
  null,
  42,
  'bad',
  { guid: 42, kind: 'review-value', payload: {} },
  { guid: A, kind: 42, payload: {} },
  { guid: A, kind: 'review-value' },
  { guid: A, kind: 'review-value', payload: null },
  { guid: A, kind: 'review-value', payload: {}, refs: [null] },
  { guid: A, kind: 'review-value', payload: {}, artifacts: { data: null } },
  { guid: A, kind: 'review-value', payload: {}, artifacts: { data: { path: 'file' } } },
])('rejects malformed envelope %j and retries repaired HTTP content', async (envelope) => {
  const f = await fixture({ schemaVersion: '2.0.0', assets: [envelope] });
  try {
    const result = await f.registry.loadByGuid(f.registry.parseGuid(A));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-parse-failed',
        detail: {
          field: expect.stringContaining('assets[0]'),
          value: expect.stringContaining('/value.pack.json'),
        },
      },
    });
    f.setPack({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: A, kind: 'review-value', payload: { kind: 'review-value', revision: 2 }, refs: [] },
      ],
    });
    expect(await f.registry.loadByGuid(f.registry.parseGuid(A))).toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
  } finally {
    await f.close();
  }
});

it.each([
  'one',
  'all',
] as const)('late dependency failure after %s invalidation cannot purge the fresh root', async (mode) => {
  let failOld!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const f = await fixture(cycle, (input) => {
    if (input.guid === B && ++calls === 1) {
      entered();
      return new Promise((_resolve, reject) => {
        failOld = () => reject(new Error('old dependency failed'));
      });
    }
    return { ...input.payload, revision: 2 };
  });
  try {
    const old = f.registry.loadByGuid(f.registry.parseGuid(A));
    await waiting;
    if (mode === 'all') f.registry.invalidateAll();
    else {
      f.registry.invalidate(A);
      f.registry.invalidate(B);
    }
    expect(await f.registry.loadByGuid(f.registry.parseGuid(A))).toMatchObject({ ok: true });
    failOld();
    expect(await old).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
    expect(f.registry.lookup(A)).toMatchObject({ revision: 2 });
    expect(await f.registry.loadByGuid(f.registry.parseGuid(A))).toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
  } finally {
    await f.close();
  }
});

it.each([
  ['one', false, true],
  ['all', false, true],
  ['one', true, true],
  ['all', true, true],
  ['one', false, false],
  ['all', false, false],
  ['one', true, false],
  ['all', true, false],
] as const)('%s invalidation with dependency=%s and old-first=%s keeps publication ownership', async (mode, dependency, oldFirst) => {
  let releaseOld!: (value: unknown) => void;
  let releaseFresh!: (value: unknown) => void;
  let enteredOld!: () => void;
  let enteredFresh!: () => void;
  const oldEntered = new Promise<void>((resolve) => {
    enteredOld = resolve;
  });
  const freshEntered = new Promise<void>((resolve) => {
    enteredFresh = resolve;
  });
  let calls = 0;
  let rootCalls = 0;
  const controlled = dependency ? B : A;
  const f = await fixture(
    {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: A,
          kind: 'review-value',
          payload: { kind: 'review-value' },
          refs: dependency ? [B] : [],
        },
        { guid: B, kind: 'review-value', payload: { kind: 'review-value' }, refs: [] },
      ],
    },
    (input) => {
      if (input.guid !== controlled) return { kind: 'review-value', revision: ++rootCalls };
      if (++calls === 1) {
        enteredOld();
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      enteredFresh();
      return new Promise((resolve) => {
        releaseFresh = resolve;
      });
    },
  );
  try {
    const old = f.registry.loadByGuid(f.registry.parseGuid(A));
    await oldEntered;
    if (mode === 'all') f.registry.invalidateAll();
    else {
      f.registry.invalidate(A);
      if (dependency) f.registry.invalidate(B);
    }
    const fresh = f.registry.loadByGuid(f.registry.parseGuid(A));
    await freshEntered;
    if (oldFirst) {
      releaseOld({ kind: 'review-value', revision: 1 });
      expect(await old).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
      expect(f.registry.lookup(A)).toBeUndefined();
    }
    releaseFresh({ kind: 'review-value', revision: 2 });
    expect(await fresh).toMatchObject({ ok: true, value: { revision: 2 } });
    if (!oldFirst) {
      releaseOld({ kind: 'review-value', revision: 1 });
      expect(await old).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
    }
    expect(f.registry.lookup(A)).toMatchObject({ revision: 2 });
    expect(await f.registry.loadByGuid(f.registry.parseGuid(A))).toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
  } finally {
    await f.close();
  }
});
