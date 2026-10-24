import { createHash } from 'node:crypto';
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
import { compressZstd } from '@forgeax/engine-codec/encode';
import { type DistArtifact, type DistManifest, verifyDist } from './dist.js';
import { catalogRows, type PlayerBundleResult, planPlayerBundles } from './player-bundles.js';
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
  const manifest = await readFile(resolve(root, 'forgeax-dist.json'));
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
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
    const existing = await readFile(resolve(destination, 'forgeax-dist.json'));
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

export interface PlayerDistOptions {
  /** Keep preparation on the final player's filesystem for an atomic rename. */
  readonly outputParent?: string;
  /**
   * Store the catalog, shader manifest, pipeline library and Pack documents as
   * zstd frames that the runtime decodes itself, so any static host serves them
   * small. Defaults to true.
   */
  readonly compressDocuments?: boolean;
}

/** Prepare delivery bytes without changing the verified build's diagnostic evidence. */
export async function preparePlayerDist(
  sourceRoot: string,
  manifest: DistManifest,
  options: PlayerDistOptions = {},
): Promise<{
  readonly root: string;
  readonly manifest: DistManifest;
  readonly bundles: PlayerBundleResult['report'];
}> {
  const base = new URL(manifest.base, 'https://forgeax.package/');
  const catalogUrl = new URL(manifest.runtime.packIndexUrl, base);
  const paths = new Map(
    manifest.artifacts.map((artifact) => [new URL(artifact.path, base).href, artifact.path]),
  );
  const receipts = new Set<string>();
  let changed = false;
  const source = await readFile(resolve(sourceRoot, manifest.runtime.packIndexUrl), 'utf8');
  const parsed: unknown = JSON.parse(source, (key, value: unknown) => {
    if ((key === 'cookReceiptUrl' || key === 'receiptUrl') && typeof value === 'string') {
      const path = paths.get(new URL(value, catalogUrl).href);
      if (key === 'cookReceiptUrl' || path?.endsWith('.receipt.json')) {
        if (path !== undefined) receipts.add(path);
        changed = true;
        return undefined;
      }
    }
    return value;
  });
  for (const row of catalogRows(parsed))
    for (const field of AUTHORING_ROW_FIELDS)
      if (field in row) {
        delete row[field];
        changed = true;
      }
  const catalogBytes = Buffer.from(changed ? JSON.stringify(parsed) : source);
  const delivery: DevKitDeliveryOptions = manifest.artifacts.some(
    (artifact) => artifact.path === PLAYER_DELIVERY_FILE,
  )
    ? JSON.parse(await readFile(resolve(sourceRoot, PLAYER_DELIVERY_FILE), 'utf8'))
    : {};
  const candidates = new Map(
    manifest.artifacts
      .filter((artifact) => !receipts.has(artifact.path) && artifact.path !== PLAYER_DELIVERY_FILE)
      .map((artifact): [string, DistArtifact] => [
        artifact.path,
        artifact.path === manifest.runtime.packIndexUrl
          ? {
              ...artifact,
              bytes: catalogBytes.byteLength,
              sha256: createHash('sha256').update(catalogBytes).digest('hex'),
            }
          : artifact,
      ]),
  );
  const outputParent = options.outputParent ?? tmpdir();
  await mkdir(outputParent, { recursive: true });
  const root = await mkdtemp(resolve(outputParent, 'forgeax-player-dist-'));
  try {
    const bundled = await planPlayerBundles({
      sourceRoot,
      outputRoot: root,
      artifacts: candidates,
      catalog: JSON.parse(catalogBytes.toString('utf8')),
      pathOf: (url, from) => paths.get(new URL(url, new URL(from, base)).href),
      packIndexPath: manifest.runtime.packIndexUrl,
      delivery,
    });
    const written = new Map(bundled.written.map((artifact) => [artifact.path, artifact]));
    const copied = [...candidates.values()].filter(
      (artifact) => !bundled.removed.has(artifact.path) && !written.has(artifact.path),
    );
    const directories = new Set(copied.map((artifact) => dirname(resolve(root, artifact.path))));
    await Promise.all([...directories].map((directory) => mkdir(directory, { recursive: true })));
    for (let offset = 0; offset < copied.length; offset += 32) {
      await Promise.all(
        copied
          .slice(offset, offset + 32)
          .map((artifact) =>
            artifact.path === manifest.runtime.packIndexUrl
              ? writeFile(resolve(root, artifact.path), catalogBytes)
              : copyFile(
                  resolve(sourceRoot, artifact.path),
                  resolve(root, artifact.path),
                  constants.COPYFILE_FICLONE,
                ),
          ),
      );
    }
    let artifacts = [
      ...[...candidates.values()]
        .filter((artifact) => !bundled.removed.has(artifact.path))
        .map((artifact) => written.get(artifact.path) ?? artifact),
      ...[...written.values()].filter((artifact) => !candidates.has(artifact.path)),
    ];
    if (options.compressDocuments !== false) {
      const documents = new Set([
        manifest.runtime.packIndexUrl,
        manifest.runtime.shaderManifestUrl,
      ]);
      for (const row of catalogRows(parsed))
        if (typeof row.packageUrl === 'string') {
          const path = paths.get(new URL(row.packageUrl, catalogUrl).href);
          if (path !== undefined) documents.add(path);
        }
      artifacts = await compressPlayerDocuments(
        root,
        artifacts,
        (path) => documents.has(path) || PIPELINE_LIBRARY.test(path),
      );
    }
    const playerManifest: DistManifest = { ...manifest, artifacts };
    await writeFile(
      resolve(root, 'forgeax-dist.json'),
      `${JSON.stringify(playerManifest, null, 2)}\n`,
    );
    return { root, manifest: playerManifest, bundles: bundled.report };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

async function compressPlayerDocuments(
  root: string,
  artifacts: readonly DistArtifact[],
  selected: (path: string) => boolean,
): Promise<DistArtifact[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (!selected(artifact.path)) return artifact;
      const path = resolve(root, artifact.path);
      const compressed = await compressZstd(await readFile(path));
      if (!compressed.ok)
        throw new Error(`${artifact.path}: zstd compression failed: ${compressed.error.code}`);
      await writeFile(path, compressed.value);
      return {
        ...artifact,
        bytes: compressed.value.byteLength,
        sha256: createHash('sha256').update(compressed.value).digest('hex'),
      };
    }),
  );
}
