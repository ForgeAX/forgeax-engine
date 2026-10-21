import { createServer } from 'node:http';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type AssetDecoderInput, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { type CatalogListener, createCatalogSource } from '../catalog-source';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
interface Value {
  value: string;
  revision: number;
}
const kind = defineAssetKind<Value>('http-review-value');
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  dependencies: boolean | 'cycle' = false,
  decode: (input: AssetDecoderInput<Value>) => Promise<Value> = async ({ envelope }) =>
    envelope.payload,
) {
  let pack: unknown;
  let rows: CatalogEntry[] = [];
  let listener: CatalogListener = () => {};
  let requests = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/catalog.json') res.end(JSON.stringify(rows));
    else {
      requests++;
      res.end(JSON.stringify(pack));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry();
  registry.installDecoder(kind, {
    decode: async (input) => ok(await decode(input)),
    prepare: (value) => ok(value),
  });
  const source = () =>
    createCatalogSource({
      url: `${origin}/catalog.json`,
      subscribe(next) {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
    });
  const publish = (revision: number, replaceSource = false) => {
    const packageUrl = `${origin}/value.pack.json`;
    const produced = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: 'http-values.pack',
      sourceRevision: String(revision),
      packageUrl,
      pack: {
        assets: (dependencies ? [A, B] : [A]).map((guid) => ({
          guid,
          kind: kind.kind,
          payload: { value: guid, revision },
          refs: dependencies && guid === A ? [B] : dependencies === 'cycle' ? [A] : [],
          artifacts: {},
        })),
      },
    });
    pack = produced.pack;
    rows = produced.pack.assets.map(({ guid }) => ({
      guid,
      kind: kind.kind,
      packageUrl,
      sourcePath: 'http-values.pack',
      publication: produced.publication,
    }));
    if (replaceSource) registry.setCatalogSource(source());
    else listener({ added: [], changed: rows, removed: [] });
  };
  publish(1, true);
  return {
    registry,
    publish,
    requests: () => requests,
    setBody(body: unknown) {
      pack = body;
    },
    body: () => pack,
    async close() {
      registry.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it('completes concurrent roots of a real HTTP closure with one shared package read', async () => {
  const waiting = gate();
  const entered = gate();
  const decoded = vi.fn(async (input: AssetDecoderInput<Value>) => {
    if (input.envelope.guid === B) {
      entered.release();
      await waiting.promise;
    }
    return input.envelope.payload;
  });
  const f = await fixture(true, decoded);
  try {
    const first = f.registry.load(A, kind);
    const second = f.registry.load(B, kind);
    await entered.promise;
    expect(f.registry.inspectSource()?.ready).toEqual([]);
    let complete = false;
    void first.then(() => {
      complete = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(complete).toBe(false);
    waiting.release();
    const [a, b] = await Promise.all([first, second]);
    expect(f.registry.read(a.unwrap()).unwrap()).toMatchObject({ value: A, revision: 1 });
    expect(f.registry.read(b.unwrap()).unwrap()).toMatchObject({ value: B, revision: 1 });
    expect(f.requests()).toBe(1);
    expect(decoded).toHaveBeenCalledTimes(2);
  } finally {
    waiting.release();
    await f.close();
  }
});

it.each([
  null,
  42,
  'bad',
  { guid: 42, kind: kind.kind, payload: {} },
  { guid: A, kind: 42, payload: {} },
  { guid: A, kind: kind.kind },
  { guid: A, kind: kind.kind, payload: {}, refs: [null] },
  { guid: A, kind: kind.kind, payload: {}, artifacts: { data: null } },
  { guid: A, kind: kind.kind, payload: {}, artifacts: { data: { path: 'file' } } },
])('returns a structured error for malformed HTTP envelope %j and admits repaired content', async (envelope) => {
  const decoded = vi.fn(async ({ envelope }: AssetDecoderInput<Value>) => envelope.payload);
  const f = await fixture(false, decoded);
  try {
    const original = f.body() as Record<string, unknown>;
    f.setBody({ ...original, assets: [envelope] });
    const result = await f.registry.load(A, kind);
    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.any(String), hint: expect.any(String) },
    });
    expect(decoded).not.toHaveBeenCalled();
    expect(f.registry.inspectSource()?.ready).toEqual([]);
    f.setBody(original);
    const handle = (await f.registry.load(A, kind)).unwrap();
    expect(f.registry.read(handle).unwrap()).toMatchObject({ value: A, revision: 1 });
  } finally {
    await f.close();
  }
});

it.each([
  ['publication', false, false],
  ['publication', false, true],
  ['publication', true, false],
  ['publication', true, true],
  ['source', false, false],
  ['source', false, true],
  ['source', true, false],
  ['source', true, true],
] as const)('%s replacement with dependency=%s and old-first=%s fences delayed decode', async (mode, dependency, oldFirst) => {
  const oldEntered = gate(),
    freshEntered = gate(),
    oldWait = gate(),
    freshWait = gate();
  const controlled = dependency ? B : A;
  const f = await fixture(dependency, async (input) => {
    if (input.envelope.guid === controlled) {
      if (input.envelope.payload.revision === 1) {
        oldEntered.release();
        await oldWait.promise;
      } else {
        freshEntered.release();
        await freshWait.promise;
      }
    }
    return input.envelope.payload;
  });
  try {
    const old = f.registry.load(A, kind);
    await oldEntered.promise;
    f.publish(2, mode === 'source');
    const fresh = f.registry.load(A, kind);
    await freshEntered.promise;
    if (oldFirst) {
      oldWait.release();
      expect((await old).ok).toBe(false);
      expect(f.registry.inspectSource()?.ready).not.toContain(A);
    }
    freshWait.release();
    const handle = (await fresh).unwrap();
    expect(f.registry.read(handle).unwrap()).toMatchObject({ value: A, revision: 2 });
    if (!oldFirst) {
      oldWait.release();
      expect((await old).ok).toBe(false);
    }
    const again = (await f.registry.load(A, kind)).unwrap();
    expect(again).toBe(handle);
    expect(f.registry.read(again).unwrap()).toMatchObject({ value: A, revision: 2 });
  } finally {
    oldWait.release();
    freshWait.release();
    await f.close();
  }
});

it('keeps a valid newer HTTP publication after an old dependency rejects', async () => {
  const entered = gate(),
    waiting = gate();
  const f = await fixture(true, async (input) => {
    if (input.envelope.guid === B && input.envelope.payload.revision === 1) {
      entered.release();
      await waiting.promise;
      throw new Error('old dependency failed');
    }
    return input.envelope.payload;
  });
  try {
    const old = f.registry.load(A, kind);
    await entered.promise;
    f.publish(2);
    const handle = (await f.registry.load(A, kind)).unwrap();
    waiting.release();
    expect((await old).ok).toBe(false);
    expect(f.registry.read(handle).unwrap().revision).toBe(2);
    expect((await f.registry.load(A, kind)).unwrap()).toBe(handle);
  } finally {
    waiting.release();
    await f.close();
  }
});

it('rejects eager dependency cycles atomically without deadlocking concurrent roots', async () => {
  const f = await fixture('cycle');
  try {
    const results = await Promise.all([f.registry.load(A, kind), f.registry.load(B, kind)]);
    for (const result of results)
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
    expect(f.registry.inspect().assets).toEqual([]);
  } finally {
    await f.close();
  }
});
