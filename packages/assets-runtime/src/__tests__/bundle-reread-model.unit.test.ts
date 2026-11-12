import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BundleStore } from '../internal/bundle-store';
import { shareVerifiedArtifactBytes } from '../internal/shared-immutable';
import { liveGroupedArtifact } from '../registry/artifact-io';

/**
 * Counter model of the measured Tiangong load: grouped material programs are
 * read once per referencing material. Shape from the shipped package: 383
 * materials, 34 distinct program reads each, 1,219 programs in 217 groups.
 * Byte sizes are scaled down by SCALE so the "before" copies stay cheap; the
 * reported byte totals multiply back. A collection runs every GC_EVERY reads;
 * five collections over the load approximate the measured counters (12,519
 * reuses of a live decoded group, 1,107 Range rereads).
 */
const MATERIALS = 383;
const READS_PER_MATERIAL = 34;
const GROUPS = 217;
const PROGRAMS = 1219;
const SCALE = 64;
const GROUP_DECODED = Math.round(962_273 / SCALE);
const WINDOW_STORED = Math.round(68_000 / SCALE);
const GC_EVERY = 2600;

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

beforeEach(() => vi.stubGlobal('WeakRef', CollectableRef));
afterEach(() => vi.unstubAllGlobals());

/** Deterministic skew: a few programs are shared by most materials, as measured. */
function programsOf(material: number): number[] {
  const chosen = new Set<number>();
  let seed = material * 2654435761;
  while (chosen.size < READS_PER_MATERIAL) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const unit = seed / 2 ** 32;
    chosen.add(Math.floor(PROGRAMS * unit ** 3));
  }
  return [...chosen];
}

interface Counters {
  networkReads: number;
  bytesFetched: number;
  decodes: number;
  decodedBytes: number;
  groupCopies: number;
  groupCopyBytes: number;
  memberCopies: number;
  hashedBytes: number;
  realmViewCopies: number;
  realmViewCopyBytes: number;
}

async function replay(fixed: boolean): Promise<Counters> {
  const members = Math.ceil(PROGRAMS / GROUPS);
  const memberLength = Math.floor(GROUP_DECODED / members);
  const groups = Array.from({ length: GROUPS }, (_, group) =>
    new Uint8Array(WINDOW_STORED).fill(group % 251),
  );
  const packed = encodeAssetBundle(groups);
  const counters: Counters = {
    networkReads: 0,
    bytesFetched: 0,
    decodes: 0,
    decodedBytes: 0,
    groupCopies: 0,
    groupCopyBytes: 0,
    memberCopies: 0,
    hashedBytes: 0,
    realmViewCopies: 0,
    realmViewCopyBytes: 0,
  };
  const store = new BundleStore<string>();
  const heldByMaterials: Uint8Array[] = [];
  let reads = 0;
  const readProgram = async (program: number): Promise<Uint8Array> => {
    const group = Math.floor(program / members);
    const window = packed.windows[group];
    if (window === undefined) throw new Error('group outside the model');
    const offset = (program % members) * memberLength;
    const descriptor = {
      path: 'bundles/programs.bin',
      mediaType: 'text/wgsl',
      contentEncoding: 'zstd' as const,
      byteLength: memberLength,
      integrity: { algorithm: 'sha256' as const, digest: `sha256:program-${program}` },
      byteRange: { ...window, bundleDigest: 'sha256:bundle' },
      decodedRange: { offset, length: memberLength },
    };
    // The runtime read layer's realm lookup; before the fix it did not exist.
    const live = fixed ? liveGroupedArtifact(descriptor) : undefined;
    if (live !== undefined) {
      counters.realmViewCopies++;
      counters.realmViewCopyBytes += live.byteLength;
      return live;
    }
    if (++reads % GC_EVERY === 0) CollectableRef.collect();
    const result = await store.read({
      url: 'https://game.test/bundles/programs.bin',
      range: descriptor.byteRange,
      fetch: async (entry) => {
        const body = entry
          ? packed.bytes.slice(window.offset, window.offset + window.length)
          : packed.bytes.slice();
        counters.networkReads++;
        counters.bytesFetched += body.byteLength;
        return ok(body);
      },
      finish: async () => {
        counters.decodes++;
        counters.decodedBytes += GROUP_DECODED;
        return ok(new Uint8Array(GROUP_DECODED));
      },
      reuse: async (value) => {
        // Before the fix a reuse received a private copy of the whole group.
        if (!fixed) {
          counters.groupCopies++;
          counters.groupCopyBytes += value.byteLength;
        }
        return ok(value);
      },
      // Before the fix nothing marked a grouped window shared.
      shared: fixed,
      invalid: (reason) => reason,
    });
    const decoded = result.unwrap();
    counters.memberCopies++;
    counters.hashedBytes += memberLength;
    return decoded.slice(offset, offset + memberLength);
  };
  for (let material = 0; material < MATERIALS; material++) {
    for (const program of programsOf(material)) {
      const bytes = await readProgram(program);
      // The Material loader shares each verified program; loaded materials retain it.
      const view = shareVerifiedArtifactBytes(`sha256:program-${program}`, bytes);
      CollectableRef.held.add(view);
      heldByMaterials.push(view);
    }
  }
  expect(heldByMaterials).toHaveLength(MATERIALS * READS_PER_MATERIAL);
  return counters;
}

it('models the measured grouped program reads before and after the fix', async () => {
  const before = await replay(false);
  CollectableRef.refs.clear();
  const realm = globalThis as unknown as Record<symbol, { bytes: Map<string, unknown> }>;
  realm[Symbol.for('forgeax.assets.shared-immutable-data')]?.bytes.clear();
  const after = await replay(true);
  const megabytes = (bytes: number) => `${((bytes * SCALE) / 1e6).toFixed(1)} MB`;
  const rows = (Object.keys(before) as (keyof Counters)[]).map((key) => ({
    counter: key,
    before: key.endsWith('Bytes') || key === 'bytesFetched' ? megabytes(before[key]) : before[key],
    after: key.endsWith('Bytes') || key === 'bytesFetched' ? megabytes(after[key]) : after[key],
  }));
  // Model output, before and after (bytes scaled back to package sizes).
  expect(rows).toMatchInlineSnapshot(`
    [
      {
        "after": 1,
        "before": 832,
        "counter": "networkReads",
      },
      {
        "after": "14.8 MB",
        "before": "71.4 MB",
        "counter": "bytesFetched",
      },
      {
        "after": 204,
        "before": 1035,
        "counter": "decodes",
      },
      {
        "after": "196.3 MB",
        "before": "996.0 MB",
        "counter": "decodedBytes",
      },
      {
        "after": 0,
        "before": 11987,
        "counter": "groupCopies",
      },
      {
        "after": "0.0 MB",
        "before": "11535.1 MB",
        "counter": "groupCopyBytes",
      },
      {
        "after": 1214,
        "before": 13022,
        "counter": "memberCopies",
      },
      {
        "after": "194.7 MB",
        "before": "2088.5 MB",
        "counter": "hashedBytes",
      },
      {
        "after": 11808,
        "before": 0,
        "counter": "realmViewCopies",
      },
      {
        "after": "1893.8 MB",
        "before": "0.0 MB",
        "counter": "realmViewCopyBytes",
      },
    ]
  `);
  expect(before.networkReads).toBeGreaterThan(500);
  // After: one whole-Bundle read; every later read is resident or a live realm view.
  expect(after.networkReads).toBe(1);
  // A collected decoded group is decoded again from its resident stored window.
  const collections = Math.floor((MATERIALS * READS_PER_MATERIAL) / GC_EVERY);
  expect(after.decodes).toBeLessThanOrEqual(GROUPS * (collections + 1));
  expect(after.groupCopies).toBe(0);
  // Each distinct program is selected and verified once.
  const distinct = new Set(
    Array.from({ length: MATERIALS }, (_, material) => programsOf(material)).flat(),
  );
  expect(after.memberCopies).toBe(distinct.size);
});
