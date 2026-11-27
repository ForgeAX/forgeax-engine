import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import { type AssetBundleResult, planAssetBundles } from './delivery-bundles.js';
import { encodeDeliveryDocument, readDeliveryDocument } from './delivery-documents.js';
import {
  DIST_MANIFEST_FILE,
  type DistArtifact,
  type DistManifest,
  publishDistManifest,
  verifyDist,
  withDistBytes,
} from './dist.js';
import type { DevKitDeliveryOptions } from './plugin-build.js';
import type { CommandResult } from './types.js';

/** Publish the prepared player atomically; an existing identity must still verify. */
export async function retainPlayerDist(
  root: string,
  projectRoot: string,
): Promise<
  CommandResult<{
    readonly root: string;
    readonly manifestSha256: string;
  }>
> {
  const manifest = await readFile(resolve(root, DIST_MANIFEST_FILE));
  const manifestSha256 = sha256(manifest);
  const destination = resolve(projectRoot, '.forgeax/player', manifestSha256);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(root, destination);
  } catch (cause) {
    const exists = await access(destination).then(
      () => true,
      () => false,
    );
    if (!exists) throw cause;
    const verified = await verifyDist(destination);
    if (!verified.ok) return verified;
    const existing = await readFile(resolve(destination, DIST_MANIFEST_FILE));
    if (!manifest.equals(existing)) throw new Error('player directory identity mismatch');
  }
  return { ok: true, value: { root: destination, manifestSha256 } };
}

/** Build-root delivery declaration, consumed by player packaging and never shipped. */
export const PLAYER_DELIVERY_FILE = 'forgeax-delivery.json';

/**
 * Catalog row facts that serve authoring tools (conflict checks, graph navigation,
 * provider identity, source overrides) and are never read by the player runtime.
 * The build's dist catalog keeps them for `forgeax asset` queries.
 */
const AUTHORING_ROW_FIELDS = [
  'authoring',
  'diagnostics',
  'provenance',
  'relations',
  'revision',
  'sourceIndex',
  'sourceOverrideDescriptors',
  'sourceOverrides',
] as const;

/** Generated pipeline libraries carry one bundler-hashed JSON file per build. */
const PIPELINE_LIBRARY = /(^|\/)pipeline-library[^/]*\.json$/;

type DistPlacement =
  | { readonly distribution?: 'player'; readonly outputParent?: string }
  | { readonly distribution: 'build' }
  | { readonly distribution: 'payload'; readonly payloadRoot: string };

export type DistPreparationOptions = DistPlacement & {
  /**
   * Store the catalog, shader manifest, pipeline library and Pack documents as
   * zstd frames that the runtime decodes itself, so any static host serves them
   * small. Defaults to true.
   */
  readonly compressDocuments?: boolean;
  /** Disable per-entry zstd when the host compresses the whole Bundle. */
  readonly compressEntries?: boolean;
};

/** Every catalog transport keeps Pack location and source path on its rows. */
function catalogRows(catalog: unknown): readonly Record<string, unknown>[] {
  let rows = catalog;
  for (let depth = 0; depth < 2 && !Array.isArray(rows); depth++)
    rows = rows !== null && typeof rows === 'object' ? (rows as { entries?: unknown }).entries : [];
  return Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : [];
}

function projectDeliveryCatalog(
  source: string,
  build: boolean,
  catalogPathOf: (url: string) => string | undefined,
  documents: Set<string>,
) {
  const receipts = new Set<string>();
  let changed = false;
  const parsed: unknown = JSON.parse(source, (key, value: unknown) => {
    if (!build && (key === 'cookReceiptUrl' || key === 'receiptUrl') && typeof value === 'string') {
      const path = catalogPathOf(value);
      if (key === 'cookReceiptUrl' || path?.endsWith('.receipt.json')) {
        if (path !== undefined) receipts.add(path);
        changed = true;
        return undefined;
      }
    }
    return value;
  });
  const sources = new Map<string, string>();
  for (const row of catalogRows(parsed)) {
    if (!build)
      for (const field of AUTHORING_ROW_FIELDS)
        if (field in row) {
          delete row[field];
          changed = true;
        }
    if (typeof row.packageUrl !== 'string') continue;
    const path = catalogPathOf(row.packageUrl);
    if (path === undefined) continue;
    documents.add(path);
    if (typeof row.sourcePath === 'string') sources.set(path, row.sourcePath.replaceAll('\\', '/'));
  }
  return {
    sources,
    receipts,
    catalogBytes: Buffer.from(changed ? JSON.stringify(parsed) : source),
  };
}

async function createDistRoot(sourceRoot: string, options: DistPlacement): Promise<string> {
  if (options.distribution === 'build') return sourceRoot;
  if (options.distribution === 'payload') {
    await mkdir(options.payloadRoot);
    return options.payloadRoot;
  }
  const parent = options.outputParent ?? tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(resolve(parent, 'forgeax-player-dist-'));
}

/** One asset transport for diagnostic builds and independently retained Players. */
export async function prepareDist(
  sourceRoot: string,
  manifest: DistManifest,
  options: DistPreparationOptions = {},
): Promise<{
  readonly root: string;
  readonly manifest: DistManifest;
  readonly bundles: AssetBundleResult['report'];
}> {
  const build = options.distribution === 'build';
  const base = new URL(manifest.base, 'https://forgeax.package/');
  const { packIndexUrl, shaderManifestUrl } = manifest.runtime;
  const paths = new Map(
    manifest.artifacts.map((artifact) => [new URL(artifact.path, base).href, artifact.path]),
  );
  const pathOf = (url: string, from: string) => paths.get(new URL(url, new URL(from, base)).href);
  const source = await readDeliveryDocument(resolve(sourceRoot, packIndexUrl));
  const documents = new Set([packIndexUrl, shaderManifestUrl]);
  const { sources, receipts, catalogBytes } = projectDeliveryCatalog(
    source,
    build,
    (url) => pathOf(url, packIndexUrl),
    documents,
  );
  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const delivery: DevKitDeliveryOptions = artifacts.has(PLAYER_DELIVERY_FILE)
    ? JSON.parse(await readFile(resolve(sourceRoot, PLAYER_DELIVERY_FILE), 'utf8'))
    : {};
  if (!build) {
    artifacts.delete(PLAYER_DELIVERY_FILE);
    for (const path of receipts) artifacts.delete(path);
  }
  const catalog = artifacts.get(packIndexUrl);
  if (catalog !== undefined) artifacts.set(packIndexUrl, withDistBytes(catalog, catalogBytes));
  const root = await createDistRoot(sourceRoot, options);
  try {
    const bundled = await planAssetBundles({
      sourceRoot,
      outputRoot: root,
      artifacts,
      sources,
      pathOf,
      delivery,
      compressEntries: options.compressEntries ?? true,
    });
    const rewritten = new Set<string>();
    for (const artifact of bundled.written) {
      if (bundled.removed.has(artifact.path)) continue;
      rewritten.add(artifact.path);
      artifacts.set(artifact.path, artifact);
    }
    for (const path of bundled.removed) {
      artifacts.delete(path);
      if (build) await rm(resolve(root, path));
    }
    const output: DistArtifact[] = [];
    const directories = new Map<string, Promise<string | undefined>>();
    const selected = [...artifacts.values()];
    for (let offset = 0; offset < selected.length; offset += 32) {
      const batch = selected.slice(offset, offset + 32);
      const completed = await Promise.allSettled(
        batch.map(async (artifact) => {
          const { path } = artifact;
          const delivered = resolve(root, path);
          const present = build || rewritten.has(path);
          const document = documents.has(path) || PIPELINE_LIBRARY.test(path);
          if (present && !document) return artifact;
          const original = present ? delivered : resolve(sourceRoot, path);
          if (!present) {
            const directory = dirname(delivered);
            const ready = directories.get(directory) ?? mkdir(directory, { recursive: true });
            directories.set(directory, ready);
            await ready;
          }
          if (!document) {
            await copyFile(original, delivered, constants.COPYFILE_FICLONE);
            return artifact;
          }
          const plain =
            path === packIndexUrl && !rewritten.has(path)
              ? catalogBytes
              : Buffer.from(await readDeliveryDocument(original));
          const bytes =
            options.compressDocuments === false ? plain : await encodeDeliveryDocument(path, plain);
          await writeFile(delivered, bytes);
          return withDistBytes(artifact, bytes);
        }),
      );
      for (const artifact of completed) {
        if (artifact.status === 'rejected') throw artifact.reason;
        output.push(artifact.value);
      }
    }
    const playerManifest: DistManifest = { ...manifest, artifacts: output };
    if (options.distribution !== 'payload') await publishDistManifest(root, playerManifest);
    return { root, manifest: playerManifest, bundles: bundled.report };
  } catch (cause) {
    if (!build) await rm(root, { recursive: true, force: true });
    throw cause;
  }
}
