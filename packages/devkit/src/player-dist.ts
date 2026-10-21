import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { DistArtifact, DistManifest } from './dist.js';
import { type PlayerBundleResult, planPlayerBundles } from './player-bundles.js';
import type { DevKitDeliveryOptions } from './plugin-build.js';

/** Build-root delivery declaration, consumed by player packaging and never shipped. */
export const PLAYER_DELIVERY_FILE = 'forgeax-delivery.json';

/** Prepare delivery bytes without changing the verified build's diagnostic evidence. */
export async function preparePlayerDist(
  sourceRoot: string,
  manifest: DistManifest,
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
  const catalog = JSON.stringify(JSON.parse(source), (key, value: unknown) => {
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
  const catalogBytes = Buffer.from(changed ? catalog : source);
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
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-dist-'));
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
    const artifacts = [
      ...[...candidates.values()]
        .filter((artifact) => !bundled.removed.has(artifact.path))
        .map((artifact) => written.get(artifact.path) ?? artifact),
      ...[...written.values()].filter((artifact) => !candidates.has(artifact.path)),
    ];
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
