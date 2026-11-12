import { createHash } from 'node:crypto';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { err, ok, type Result } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { BundleStore, type BundleWindowRead } from '../internal/bundle-store';
import { shareVerifiedArtifactBytes } from '../internal/shared-immutable';
import { ArtifactReadCache, readArtifact } from '../registry/artifact-io';
import { defined } from './assert-defined';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * A WeakRef whose targets are collected on demand unless the test still holds
 * them, as a real collector may do at any allocation once no owner remains.
 */
class CollectableRef<T extends object> {
  static readonly refs = new Set<CollectableRef<object>>();
  static readonly held = new WeakSet<object>();
  private target: T | undefined;
  constructor(target: T) {
    this.target = target;
    CollectableRef.refs.add(this as CollectableRef<object>);
  }
  deref(): T | undefined {
    return this.target;
  }
  static collect(): void {
    for (const ref of CollectableRef.refs)
      if (ref.target !== undefined && !CollectableRef.held.has(ref.target)) ref.target = undefined;
  }
}

beforeEach(() => {
  CollectableRef.refs.clear();
  vi.stubGlobal('WeakRef', CollectableRef);
});
afterEach(() => vi.unstubAllGlobals());

const groups = [new Uint8Array(64).fill(1), new Uint8Array(48).fill(2), new Uint8Array(32).fill(3)];
const packed = encodeAssetBundle(groups);

interface Network {
  wholeReads: number;
  rangeReads: number;
  bytes: number;
  decodes: number;
  fail?: boolean;
}

/** One reader of a grouped member: decode the group, then select a private member. */
function member(
  store: BundleStore<string>,
  net: Network,
  group: number,
  shared: boolean,
  bundle = packed,
  url = 'https://game.test/bundles/programs.bin',
): Promise<Result<Uint8Array, string>> {
  const window = defined(bundle.windows[group]);
  const request: BundleWindowRead<string> = {
    url,
    range: { ...window, bundleDigest: hash(bundle.bytes) },
    fetch: async (entry) => {
      if (net.fail) return err('offline');
      const body = entry
        ? bundle.bytes.slice(window.offset, window.offset + window.length)
        : bundle.bytes.slice();
      if (entry) net.rangeReads++;
      else net.wholeReads++;
      net.bytes += body.byteLength;
      return ok(body);
    },
    finish: async (stored) => {
      net.decodes++;
      return ok(stored.slice());
    },
    reuse: async (value) => ok(value),
    shared,
    invalid: (reason) => reason,
  };
  return store.read(request).then((group) => (group.ok ? ok(group.value.slice(0, 16)) : group));
}

const network = (): Network => ({ wholeReads: 0, rangeReads: 0, bytes: 0, decodes: 0 });
const reads = (net: Network) => net.wholeReads + net.rangeReads;

describe('shared Bundle windows', () => {
  it('reproduces the miss: an unowned decoded group is collected and refetched', async () => {
    const store = new BundleStore<string>();
    const net = network();
    for (let wave = 0; wave < 4; wave++) {
      expect((await member(store, net, 0, false)).ok).toBe(true);
      CollectableRef.collect();
    }
    // The consumer keeps only its member, so every later read is a Range reread.
    expect(net).toMatchObject({ wholeReads: 1, rangeReads: 3, decodes: 4 });
  });

  it('reads a shared window at most once while it stays resident', async () => {
    const store = new BundleStore<string>();
    const net = network();
    for (let wave = 0; wave < 4; wave++) {
      expect((await member(store, net, 0, true)).unwrap()).toEqual(new Uint8Array(16).fill(1));
      CollectableRef.collect();
    }
    expect(net).toMatchObject({ wholeReads: 1, rangeReads: 0 });
    expect(store.snapshot().bytes).toBe(64 + 48 + 32);
  });

  it('borrows a live decoded group instead of decoding it again', async () => {
    const store = new BundleStore<string>();
    const net = network();
    await member(store, net, 1, true);
    await member(store, net, 1, true);
    expect(net.decodes).toBe(1);
    CollectableRef.collect();
    await member(store, net, 1, true);
    expect(net).toMatchObject({ decodes: 2, wholeReads: 1, rangeReads: 0 });
  });

  it('coalesces concurrent readers into one network read and one decode', async () => {
    const store = new BundleStore<string>();
    const net = network();
    const results = await Promise.all(Array.from({ length: 6 }, () => member(store, net, 2, true)));
    expect(results.map((result) => result.unwrap())).toEqual(
      Array.from({ length: 6 }, () => new Uint8Array(16).fill(3)),
    );
    expect(net).toMatchObject({ wholeReads: 1, rangeReads: 0, decodes: 1 });
  });

  it('keeps a consumer that transfers its bytes from affecting the next reader', async () => {
    const store = new BundleStore<string>();
    const net = network();
    const first = (await member(store, net, 0, true)).unwrap();
    structuredClone(first.buffer, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    expect((await member(store, net, 0, true)).unwrap()).toEqual(new Uint8Array(16).fill(1));
    CollectableRef.collect();
    expect((await member(store, net, 0, true)).unwrap()).toEqual(new Uint8Array(16).fill(1));
    expect(reads(net)).toBe(1);
  });

  it('refetches after trim() and keeps the ranged window resident again', async () => {
    const store = new BundleStore<string>();
    const net = network();
    await member(store, net, 0, true);
    expect(store.trim()).toBe(1);
    expect(store.snapshot()).toEqual({ bundles: 0, bytes: 0 });
    CollectableRef.collect();
    await member(store, net, 0, true);
    expect(net).toMatchObject({ wholeReads: 1, rangeReads: 1 });
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 64 });
    CollectableRef.collect();
    await member(store, net, 0, true);
    expect(net).toMatchObject({ wholeReads: 1, rangeReads: 1 });
  });

  it('respects the residency limit by evicting the least recently used Bundle', async () => {
    const other = encodeAssetBundle([new Uint8Array(100).fill(9)]);
    const store = new BundleStore<string>(160);
    const net = network();
    await member(store, net, 0, true);
    expect(store.snapshot().bytes).toBe(144);
    await member(store, net, 0, true, other, 'https://game.test/bundles/other.bin');
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 100 });
    expect(store.transfers.snapshot().totals.evictions).toBe(1);
    CollectableRef.collect();
    await member(store, net, 0, true);
    // The evicted window costs one Range read and stays resident within the limit.
    expect(net).toMatchObject({ wholeReads: 2, rangeReads: 1 });
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 64 });
  });

  it('propagates a failed read to every reader and retains nothing', async () => {
    const store = new BundleStore<string>();
    const net = { ...network(), fail: true };
    const failed = await Promise.all([member(store, net, 0, true), member(store, net, 0, true)]);
    expect(failed).toEqual([err('offline'), err('offline')]);
    expect(store.snapshot()).toEqual({ bundles: 0, bytes: 0 });
    net.fail = false;
    expect((await member(store, net, 0, true)).ok).toBe(true);
    expect(net.wholeReads).toBe(1);
  });
});

describe('grouped program artifacts', () => {
  it('reads one compressed group once for every later member read', async () => {
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const programs = [new Uint8Array(4096).fill(17), new Uint8Array(2048).fill(29)];
    const combined = new Uint8Array(6144);
    combined.set(defined(programs[0]));
    combined.set(defined(programs[1]), 4096);
    const encoded = await compressZstd(combined);
    if (!encoded.ok) throw new Error(encoded.error.code);
    const compressed = encoded.value;
    const group = encodeAssetBundle([compressed]);
    const ranges: (string | undefined)[] = [];
    const fetch = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      ranges.push(init?.headers?.range);
      return new Response(group.bytes.slice());
    });
    const request = (index: number, guid: string) => {
      const bytes = defined(programs[index]);
      return {
        guid,
        packageUrl: 'https://game.test/group.pack.json',
        artifactKey: 'program',
        descriptor: {
          path: 'bundles/group.bin',
          mediaType: 'text/wgsl',
          contentEncoding: 'zstd' as const,
          byteLength: bytes.length,
          integrity: { algorithm: 'sha256' as const, digest: hash(bytes) },
          byteRange: { ...defined(group.windows[0]), bundleDigest: hash(group.bytes) },
          decodedRange: { offset: index === 0 ? 0 : 4096, length: bytes.length },
        },
      };
    };
    const cache = new ArtifactReadCache();
    for (let material = 0; material < 6; material++) {
      // Each material is a distinct GUID; the Material decoder keeps only its member.
      const member = (
        await cache.readArtifact(request(material % 2, `m${material}`), fetch)
      ).unwrap();
      expect(member).toEqual(programs[material % 2]);
      structuredClone(member.buffer, { transfer: [member.buffer] });
      CollectableRef.collect();
    }
    expect(ranges).toEqual([undefined]);
    expect(cache.inspectTransfers().totals).toMatchObject({ fullReads: 1, rangeReads: 0 });
  });

  it('copies a member another asset retains instead of reading its group', async () => {
    const program = new Uint8Array(4096).fill(41);
    const digest = hash(program);
    const descriptor = {
      path: 'bundles/group.bin',
      mediaType: 'text/wgsl',
      contentEncoding: 'zstd' as const,
      byteLength: program.byteLength,
      integrity: { algorithm: 'sha256' as const, digest },
      byteRange: { offset: 0, length: 64, bundleDigest: `sha256:${'0'.repeat(64)}` },
      decodedRange: { offset: 0, length: program.byteLength },
    };
    const request = (guid: string, overrides = {}) => ({
      guid,
      packageUrl: 'https://game.test/group.pack.json',
      artifactKey: 'program',
      descriptor: { ...descriptor, ...overrides },
    });
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    const retained = shareVerifiedArtifactBytes(digest, program);
    CollectableRef.held.add(retained);
    const cache = new ArtifactReadCache();
    const live = (await cache.readArtifact(request('m0'), fetch)).unwrap();
    expect(live).toEqual(program);
    // A private copy: a consumer that transfers it cannot detach the realm view.
    expect(live).not.toBe(retained);
    structuredClone(live.buffer, { transfer: [live.buffer] });
    expect(retained).toEqual(program);
    expect(fetch).not.toHaveBeenCalled();
    // Another length is other content: the read goes to the network and fails there.
    const other = await cache.readArtifact(request('m1', { byteLength: 4095 }), fetch);
    expect(other.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Publication validation reads the artifact itself and reports it missing.
    expect((await readArtifact(request('m2'), fetch)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

async function sourceGroup() {
  const { compressZstd } = await import('@forgeax/engine-codec/encode');
  const bodies = [new Uint8Array(512).fill(5), new Uint8Array(256).fill(6)];
  const combined = new Uint8Array(768);
  combined.set(defined(bodies[0]));
  combined.set(defined(bodies[1]), 512);
  const encoded = await compressZstd(combined);
  if (!encoded.ok) throw new Error(encoded.error.code);
  const { bytes: stored, windows } = encodeAssetBundle([encoded.value]);
  const kind = defineAssetKind<Uint8Array>('shared-group-binary');
  const ids = ['00000000-0000-7000-8000-000000000981', '00000000-0000-7000-8000-000000000982'];
  const packageUrl = 'https://source.invalid/group.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'group.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: ids.map((guid, index) => ({
        guid,
        kind: kind.kind,
        payload: {},
        refs: [],
        artifacts: {
          body: {
            path: 'group.bin',
            contentEncoding: 'zstd',
            mediaType: 'application/octet-stream',
            byteLength: defined(bodies[index]).byteLength,
            integrity: { algorithm: 'sha256', digest: hash(defined(bodies[index])) },
            byteRange: { ...defined(windows[0]), bundleDigest: hash(stored) },
            decodedRange: { offset: index * 512, length: defined(bodies[index]).byteLength },
          },
        },
      })),
    },
  });
  const rows = ids.map((guid) => ({
    guid,
    kind: kind.kind,
    packageUrl,
    sourcePath: 'group.pack',
    publication: produced.publication,
  }));
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === packageUrl ? Response.json(produced.pack) : new Response(stored.slice()),
  );
  const assets = new AssetRegistry({
    catalog: createCatalogSource({ entries: rows, fetch: fetcher }),
  });
  assets.installDecoder(kind, {
    decode: ({ artifacts, envelope }) => artifacts.read(defined(envelope.artifacts.body)),
  });
  return { ids, kind, bodies, fetcher, assets };
}

it('keeps a source group resident across sequential member loads', async () => {
  const { ids, kind, bodies, fetcher, assets } = await sourceGroup();
  try {
    for (const [index, guid] of ids.entries()) {
      const handle = (await assets.load(guid, kind)).unwrap();
      expect(assets.read(handle).unwrap()).toEqual(bodies[index]);
      CollectableRef.collect();
    }
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('group.bin'))).toHaveLength(1);
    expect(defined(assets.inspectSource()).bundleTransfers.totals).toMatchObject({
      fullReads: 1,
      rangeReads: 0,
      rereads: 0,
    });
  } finally {
    assets.dispose();
  }
});

it('loads a source member another asset retains without reading its group', async () => {
  const { ids, kind, bodies, fetcher, assets } = await sourceGroup();
  const body = defined(bodies[1]);
  const retained = shareVerifiedArtifactBytes(hash(body), body);
  CollectableRef.held.add(retained);
  try {
    const handle = (await assets.load(defined(ids[1]), kind)).unwrap();
    const loaded = assets.read(handle).unwrap();
    expect(loaded).toEqual(body);
    expect(loaded).not.toBe(retained);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('group.bin'))).toHaveLength(0);
  } finally {
    assets.dispose();
  }
});
