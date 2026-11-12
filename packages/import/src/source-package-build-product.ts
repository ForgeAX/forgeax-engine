import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { ScriptablePackSourceClosureEntry } from '@forgeax/engine-pack/source';
import type { TerminalImportProduct } from './import-product.js';
import type { ImportRunnerFs, RunImportMeta } from './import-runner.js';
import type {
  PackBuildCacheSubject,
  ScriptablePackBuildProductCache,
} from './scriptable-pack-build-core.js';
import { createPackBuildProductCache } from './scriptable-pack-product-cache.js';

/** Meta uses the ordinary Pack product DDC, with the host's sealed producer identity. */
export interface SourcePackageBuildDdc {
  readonly products: ScriptablePackBuildProductCache;
  readonly producerIdentity: string;
  readonly identityRoot: string;
  readonly isCurrent?: () => Promise<boolean>;
}

/** Build and live dev use the same producer identity and Pack product store. */
export async function createSourcePackageBuildDdc(options: {
  readonly root: string | undefined;
  readonly identityRoot: string;
  readonly producerIdentity: string | undefined;
  readonly cookers: readonly NativeCooker[] | undefined;
}): Promise<SourcePackageBuildDdc | undefined> {
  if (options.root === undefined || options.producerIdentity === undefined) return undefined;
  const cacheOptions = {
    root: options.root,
    identityRoot: options.identityRoot,
    outputVersions: { 'meta-source-package': '1' },
    cookers: options.cookers ?? [],
  };
  const products = await createPackBuildProductCache(cacheOptions);
  return {
    products,
    identityRoot: options.identityRoot,
    producerIdentity: `${options.producerIdentity}:${products.producerIdentity}`,
    isCurrent: async () =>
      (await createPackBuildProductCache(cacheOptions)).producerIdentity ===
      products.producerIdentity,
  };
}

export async function prepareSourcePackageBuildProduct(
  meta: RunImportMeta,
  fs: ImportRunnerFs,
  ddc: SourcePackageBuildDdc,
) {
  const reads = new Map<string, ScriptablePackSourceClosureEntry>();
  const sourceBytes = new Map<string, Uint8Array>();
  const sourceFailures = new Map<string, unknown>();
  const readSibling = fs.readSibling;
  const sourceIdentityFor = fs.sourceIdentityFor?.bind(fs);
  const decodeImage = fs.decodeImage?.bind(fs);
  const pathOf = (path: string) =>
    isAbsolute(path) ? resolve(path) : resolve(ddc.identityRoot, path);
  const remember = (path: string, bytes: Uint8Array) => {
    const owned = new Uint8Array(bytes);
    sourceBytes.set(path, owned);
    reads.set(path, { path, digest: `sha256:${createHash('sha256').update(owned).digest('hex')}` });
    return owned;
  };
  const snapshotFs: ImportRunnerFs = {
    ...fs,
    ...(sourceIdentityFor === undefined ? {} : { sourceIdentityFor }),
    ...(decodeImage === undefined ? {} : { decodeImage }),
    async readSource(path) {
      const key = pathOf(path),
        captured = sourceBytes.get(key);
      if (captured !== undefined) return { ok: true, value: new Uint8Array(captured) };
      if (sourceFailures.has(key)) return { ok: false, error: sourceFailures.get(key) };
      const result = await fs
        .readSource(path)
        .catch((error: unknown) => ({ ok: false as const, error }));
      if (!result.ok) sourceFailures.set(key, result.error);
      return result.ok ? { ok: true, value: new Uint8Array(remember(key, result.value)) } : result;
    },
    ...(readSibling === undefined
      ? {}
      : {
          async readSibling(source: string, uri: string) {
            const key = resolve(dirname(pathOf(source)), uri),
              captured = sourceBytes.get(key);
            if (captured !== undefined)
              return { ok: true as const, value: new Uint8Array(captured) };
            const result = await readSibling.call(fs, source, uri);
            return result.ok
              ? { ok: true as const, value: new Uint8Array(remember(key, result.value)) }
              : result;
          },
        }),
  };
  await snapshotFs.readSource(meta.source);
  const anchor = [...meta.subAssets.map((row) => row.guid)].sort()[0];
  const packageId = anchor === undefined ? undefined : PackageId.parse(anchor);
  if (packageId === undefined || !packageId.ok) return undefined;
  const discoverySourceClosure = [...reads.values()];
  const { buildPack: _buildPack, ...authorMeta } = structuredClone(meta);
  const subject: PackBuildCacheSubject = {
    definition: { packageId: packageId.value },
    sourcePath: pathOf(meta.source),
    values: {
      producer: ddc.producerIdentity,
      meta: {
        ...authorMeta,
        source:
          fs.sourceIdentityFor?.(meta.source) ??
          relative(ddc.identityRoot, pathOf(meta.source)).replaceAll('\\', '/'),
      },
    },
    sourceClosure: discoverySourceClosure,
    discoverySourceClosure,
  };
  return {
    meta: structuredClone(meta),
    fs: snapshotFs,
    subject,
    complete(): PackBuildCacheSubject {
      // Import reads are captured above. Cookers own their complete source
      // identity; terminal dependency labels may include builtin shader IDs
      // and are not filesystem paths to reopen here.
      return { ...subject, sourceClosure: [...reads.values()] };
    },
  };
}

/** Publish through the existing Pack DDC only after the full source closure is known. */
export async function persistSourcePackageBuildProduct(
  ddc: SourcePackageBuildDdc | undefined,
  prepared: Awaited<ReturnType<typeof prepareSourcePackageBuildProduct>>,
  product: TerminalImportProduct,
): Promise<void> {
  if (ddc === undefined || prepared === undefined) return;
  try {
    if ((await ddc.isCurrent?.()) === false) return;
    const subject = prepared.complete();
    await ddc.products.write(subject, {
      product,
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: product.sourceRevision,
    });
  } catch {
    // Optional DDC evidence cannot turn valid producer output into a failed publication.
  }
}
