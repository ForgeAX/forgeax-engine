import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { encodeAssetBundle, readAssetBundleTable } from '@forgeax/engine-pack/bundle';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { readDeliveryDocument } from './delivery-documents.js';
import type { DistArtifact } from './dist.js';
import type { DevKitDeliveryOptions } from './plugin-build.js';

/** Automatic Bundles stop splitting at this size; one Pack is never split. */
export const AUTO_BUNDLE_TARGET_BYTES = 8 * 1024 * 1024;

export interface AssetBundleInput {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  /** Player artifacts after receipt removal, keyed by dist-relative path. */
  readonly artifacts: ReadonlyMap<string, DistArtifact>;
  readonly catalog: unknown;
  /** Resolve a catalog or Pack URL to its dist-relative artifact path. */
  readonly pathOf: (url: string, from: string) => string | undefined;
  readonly packIndexPath: string;
  readonly delivery: DevKitDeliveryOptions;
  readonly targetBytes?: number;
  /** Native transports can compress the complete Bundle once instead. */
  readonly compressEntries?: boolean;
}

export interface AssetBundleResult {
  /** Bundled originals that the player package omits. */
  readonly removed: ReadonlySet<string>;
  /** Rewritten Pack documents and new Bundle files, already written to outputRoot. */
  readonly written: readonly DistArtifact[];
  readonly report: {
    readonly bundles: number;
    readonly entries: number;
    readonly storedBytes: number;
    /** Declared decoded entry bytes; stored length when no decoded length is declared. */
    readonly sourceBytes: number;
  };
}

interface Entry {
  /** First stored path; equal bytes under other paths share its window. */
  readonly path: string;
  readonly paths: Set<string>;
  readonly identity: string;
  readonly bytes: number;
  readonly decodedBytes: number;
  readonly owners: Set<string>;
}

interface Window {
  readonly bundlePath: string;
  readonly offset: number;
  readonly length: number;
  readonly bundleDigest: string;
  readonly contentEncoding: 'identity' | 'zstd';
}

type PackDocument = { assets?: unknown; pack?: { assets?: unknown } };

function packAssets(document: PackDocument): readonly { artifacts?: unknown }[] {
  const assets = Array.isArray(document.assets) ? document.assets : document.pack?.assets;
  return Array.isArray(assets) ? assets : [];
}

function bundleable(descriptor: ArtifactDescriptor): boolean {
  return (
    descriptor.delivery === undefined &&
    descriptor.byteRange === undefined &&
    descriptor.integrity !== undefined
  );
}

function* descriptors(
  document: PackDocument,
): Generator<[Record<string, ArtifactDescriptor>, string, ArtifactDescriptor]> {
  for (const asset of packAssets(document)) {
    const artifacts = asset.artifacts;
    if (artifacts === null || typeof artifacts !== 'object') continue;
    const table = artifacts as Record<string, ArtifactDescriptor>;
    for (const [key, descriptor] of Object.entries(table)) yield [table, key, descriptor];
  }
}

/** Deterministic split by key bits until each bucket fits; single items never split. */
function buckets<T>(
  items: readonly T[],
  key: (item: T) => string,
  weight: (item: T) => number,
  target: number,
  prefix = '',
): [string, T[]][] {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  if (items.length <= 1 || total <= target || prefix.length >= 64) return [[prefix, [...items]]];
  const bit = (item: T) => {
    const hex = Number.parseInt(key(item)[prefix.length >> 2] ?? '0', 16);
    return (hex >> (3 - (prefix.length & 3))) & 1;
  };
  return [0, 1].flatMap((value) =>
    buckets(
      items.filter((item) => bit(item) === value),
      key,
      weight,
      target,
      `${prefix}${value}`,
    ).filter(([, members]) => members.length > 0),
  );
}

/** Every catalog transport keeps Pack location and source path on its rows. */
export function catalogRows(catalog: unknown): readonly Record<string, unknown>[] {
  let rows = catalog;
  for (let depth = 0; depth < 2 && !Array.isArray(rows); depth++)
    rows = rows !== null && typeof rows === 'object' ? (rows as { entries?: unknown }).entries : [];
  return Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : [];
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function compressBundleEntry(bytes: Uint8Array, enabled: boolean) {
  if (!enabled || bytes.byteLength < 256) return undefined;
  return compressZstd(bytes);
}

/** Group each Pack's non-stream artifacts into Bundles; shared bytes are stored once. */
export async function planAssetBundles(input: AssetBundleInput): Promise<AssetBundleResult> {
  const sources = new Map<string, string>();
  for (const row of catalogRows(input.catalog)) {
    if (typeof row.packageUrl !== 'string' || typeof row.sourcePath !== 'string') continue;
    const pack = input.pathOf(row.packageUrl, input.packIndexPath);
    if (pack !== undefined) sources.set(pack, row.sourcePath.replaceAll('\\', '/'));
  }
  const packs = [...sources.keys()].filter((path) => input.artifacts.has(path)).sort();

  const { entries, retained, existing } = await collectEntries(input, packs);
  const groups = groupEntries(input, sources, packs, entries);
  const windows = new Map<string, Window>();
  const written: DistArtifact[] = [];
  const report = await existingBundleReport(input, existing);
  for (const group of [...groups.keys()].sort()) {
    const output = await writeBundle(input, groups.get(group) ?? []);
    written.push(output.artifact);
    for (const [identity, window] of output.windows) windows.set(identity, window);
    report.storedBytes += output.artifact.bytes;
    report.sourceBytes += output.sourceBytes;
  }
  written.push(...(await rewritePacks(input, packs, windows)));
  return {
    removed: new Set(
      [...entries.values()]
        .flatMap((entry) => [...entry.paths])
        .filter((path) => !retained.has(path)),
    ),
    written,
    report: {
      ...report,
      bundles: groups.size + existing.size,
      entries: entries.size + report.entries,
    },
  };
}

async function collectEntries(input: AssetBundleInput, packs: readonly string[]) {
  const entries = new Map<string, Entry>();
  // Streaming and unverified descriptors keep their files, even when bytes are shared.
  const retained = new Set<string>();
  const existing = new Map<string, Map<string, number>>();
  for (const pack of packs) {
    const document = JSON.parse(await readDeliveryDocument(resolve(input.sourceRoot, pack)));
    for (const [, , descriptor] of descriptors(document)) {
      const path = input.pathOf(descriptor.path, pack);
      const artifact = path === undefined ? undefined : input.artifacts.get(path);
      if (path === undefined || artifact === undefined) continue;
      if (!bundleable(descriptor)) {
        retained.add(path);
        const range = descriptor.byteRange;
        if (range !== undefined && path.startsWith('assets/bundles/')) {
          if (range.bundleDigest !== `sha256:${artifact.sha256}`)
            throw new Error(`${pack}: Bundle digest does not match ${path}`);
          const windows = existing.get(path) ?? new Map<string, number>();
          windows.set(`${range.offset}:${range.length}`, descriptor.byteLength ?? range.length);
          existing.set(path, windows);
        }
        continue;
      }
      const identity = `${artifact.sha256}:${descriptor.contentEncoding ?? 'identity'}`;
      const entry = entries.get(identity) ?? {
        path,
        paths: new Set<string>(),
        identity,
        bytes: artifact.bytes,
        decodedBytes: descriptor.byteLength ?? artifact.bytes,
        owners: new Set<string>(),
      };
      entry.paths.add(path);
      entry.owners.add(pack);
      entries.set(identity, entry);
    }
  }

  return { entries, retained, existing };
}

function namedGroups(
  input: AssetBundleInput,
  sources: ReadonlyMap<string, string>,
  packs: readonly string[],
) {
  const named = new Map<string, string>();
  for (const pack of packs) {
    const source = sources.get(pack) ?? '';
    const matches = Object.entries(input.delivery.bundles ?? {}).filter(([, prefixes]) =>
      prefixes.some((prefix) => source.startsWith(prefix)),
    );
    if (matches.length > 1)
      throw new Error(
        `Pack ${source} matches Bundles ${matches.map(([name]) => name).join(', ')}; a Pack belongs to one Bundle`,
      );
    if (matches[0] !== undefined) named.set(pack, `named-${matches[0][0]}`);
  }
  for (const [name, prefixes] of Object.entries(input.delivery.bundles ?? {}))
    for (const prefix of prefixes)
      if (![...sources.values()].some((source) => source.startsWith(prefix)))
        throw new Error(`Bundle ${name} prefix ${prefix} matches no published Pack`);

  return named;
}

function groupEntries(
  input: AssetBundleInput,
  sources: ReadonlyMap<string, string>,
  packs: readonly string[],
  entries: ReadonlyMap<string, Entry>,
) {
  const named = namedGroups(input, sources, packs);
  const target = input.targetBytes ?? AUTO_BUNDLE_TARGET_BYTES;
  const exclusive = new Map<string, number>();
  for (const entry of entries.values()) {
    const [owner] = entry.owners;
    if (entry.owners.size === 1 && owner !== undefined)
      exclusive.set(owner, (exclusive.get(owner) ?? 0) + entry.bytes);
  }
  const groupOf = new Map(named);
  for (const [prefix, members] of buckets(
    packs.filter((pack) => !named.has(pack) && (exclusive.get(pack) ?? 0) > 0),
    sha256,
    (pack) => exclusive.get(pack) ?? 0,
    target,
  ))
    for (const pack of members) groupOf.set(pack, `auto-${prefix}`);

  const groups = new Map<string, Entry[]>();
  const shared: Entry[] = [];
  for (const entry of entries.values()) {
    const owners = new Set([...entry.owners].map((pack) => groupOf.get(pack)));
    const [group] = owners;
    if (owners.size === 1 && group !== undefined)
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    else shared.push(entry);
  }
  for (const [prefix, members] of buckets(
    shared,
    (entry) => entry.identity,
    (entry) => entry.bytes,
    target,
  ))
    if (members.length > 0) groups.set(`shared-${prefix}`, members);

  return groups;
}

async function existingBundleReport(
  input: AssetBundleInput,
  existing: ReadonlyMap<string, ReadonlyMap<string, number>>,
) {
  let storedBytes = 0,
    sourceBytes = 0,
    entries = 0;
  for (const [path, windows] of existing) {
    const bytes = await readFile(resolve(input.sourceRoot, path));
    const table = readAssetBundleTable(bytes);
    if (!table.ok) throw new Error(`${path}: invalid Bundle: ${table.error}`);
    const available = new Set(table.value.map((window) => `${window.offset}:${window.length}`));
    for (const window of windows.keys())
      if (!available.has(window)) throw new Error(`${path}: descriptor is not a Bundle entry`);
    storedBytes += bytes.byteLength;
    entries += windows.size;
    sourceBytes += [...windows.values()].reduce((sum, length) => sum + length, 0);
  }
  return { storedBytes, sourceBytes, entries };
}

async function writeBundle(input: AssetBundleInput, entries: readonly Entry[]) {
  let sourceBytes = 0;
  const windows = new Map<string, Window>();
  const members = [...entries].sort((a, b) => a.identity.localeCompare(b.identity));
  const stored: Uint8Array[] = [];
  const encodings: ('identity' | 'zstd')[] = [];
  for (const entry of members) {
    const bytes = new Uint8Array(await readFile(resolve(input.sourceRoot, entry.path)));
    sourceBytes += entry.decodedBytes;
    const identity = entry.identity.endsWith(':identity');
    const compressed = identity
      ? await compressBundleEntry(bytes, input.compressEntries !== false)
      : undefined;
    if (compressed?.ok === true && compressed.value.byteLength < bytes.byteLength * 0.9) {
      stored.push(compressed.value);
      encodings.push('zstd');
    } else {
      stored.push(bytes);
      encodings.push(identity ? 'identity' : 'zstd');
    }
  }
  const bundle = encodeAssetBundle(stored);
  const digest = sha256(bundle.bytes);
  const bundlePath = `assets/bundles/${digest}.bin`;
  await mkdir(dirname(resolve(input.outputRoot, bundlePath)), { recursive: true });
  await writeFile(resolve(input.outputRoot, bundlePath), bundle.bytes);
  const artifact: DistArtifact = {
    path: bundlePath,
    mediaType: 'application/octet-stream',
    bytes: bundle.bytes.byteLength,
    sha256: digest,
  };
  members.forEach((entry, index) => {
    const window = bundle.windows[index];
    const contentEncoding = encodings[index];
    if (window === undefined || contentEncoding === undefined) return;
    windows.set(entry.identity, {
      bundlePath,
      ...window,
      bundleDigest: `sha256:${digest}`,
      contentEncoding,
    });
  });
  return { artifact, windows, sourceBytes };
}

async function rewritePacks(
  input: AssetBundleInput,
  packs: readonly string[],
  windows: ReadonlyMap<string, Window>,
) {
  const written: DistArtifact[] = [];
  for (const pack of packs) {
    const document = JSON.parse(await readDeliveryDocument(resolve(input.sourceRoot, pack)));
    let changed = false;
    for (const [table, key, descriptor] of descriptors(document)) {
      const path = input.pathOf(descriptor.path, pack);
      const artifact = path === undefined ? undefined : input.artifacts.get(path);
      if (artifact === undefined || !bundleable(descriptor)) continue;
      const window = windows.get(`${artifact.sha256}:${descriptor.contentEncoding ?? 'identity'}`);
      if (window === undefined) continue;
      changed = true;
      table[key] = {
        ...descriptor,
        path: posix.relative(posix.dirname(pack), window.bundlePath),
        contentEncoding: window.contentEncoding,
        byteRange: {
          offset: window.offset,
          length: window.length,
          bundleDigest: window.bundleDigest,
        },
      };
    }
    if (!changed) continue;
    const bytes = Buffer.from(JSON.stringify(document));
    await mkdir(dirname(resolve(input.outputRoot, pack)), { recursive: true });
    await writeFile(resolve(input.outputRoot, pack), bytes);
    const original = input.artifacts.get(pack);
    if (original !== undefined)
      written.push({ ...original, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }

  return written;
}
