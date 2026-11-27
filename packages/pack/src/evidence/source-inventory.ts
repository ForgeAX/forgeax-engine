import { createHash } from 'node:crypto';
import type { PackIndexEntry, SourceDeclarationEvidence } from '@forgeax/engine-types';
import { parsePackSourceJson } from '../pack-authoring.js';
import { resolveAssetSource } from '../resolve-asset-source.js';
import {
  declaredPackAssets,
  enumeratePackSourcePaths,
  type MetaInventoryDocument,
  readAuthorJson,
  type ScanSourceDeclaration,
} from '../scanner.js';

/** Project root and GUID used to locate an authoritative source declaration. */
interface SourceInventoryRequest {
  readonly projectRoot: string;
  readonly guid: string;
}

/** Read author declarations even when a different source in the tree is damaged. */
export async function readSourceInventory(
  request: SourceInventoryRequest,
): Promise<SourceDeclarationEvidence | undefined> {
  const { paths } = await enumeratePackSourcePaths([request.projectRoot], { skipUnreadable: true });
  const guid = request.guid.toLowerCase();
  let authored: SourceDeclarationEvidence | undefined;
  for (const path of paths.sort()) {
    if (path.endsWith('.pack.ts')) continue;
    const isMeta = path.endsWith('.meta.json');
    const loaded = await readAuthorJson(
      path,
      isMeta ? 'pack-malformed-meta' : 'pack-malformed-pack',
    );
    if (!loaded.ok) continue;
    const { raw, parsed } = loaded.value;
    if (isMeta) {
      const meta = parsed as MetaInventoryDocument & { readonly inputFingerprint?: unknown };
      if (!meta.subAssets.some((asset) => asset.guid.toLowerCase() === guid)) continue;
      return {
        origin: 'sourceMeta',
        sourcePath: resolveAssetSource(path, meta.source),
        inputFingerprint:
          typeof meta.inputFingerprint === 'string'
            ? meta.inputFingerprint
            : createHash('sha256').update(raw).digest('base64'),
      };
    }
    const document = parsePackSourceJson(parsed);
    if (
      document.ok &&
      declaredPackAssets(document.value).some((asset) => asset.guid.toLowerCase() === guid)
    )
      authored = { origin: 'authoredPack', sourcePath: path };
  }
  return authored;
}

export interface AssetVerificationReport {
  readonly schemaVersion: 'asset-verification-v1';
  readonly root: string;
  /** The bounded source scope used for this read-only report. */
  readonly scope: {
    readonly sourceCount: number;
    readonly assetCount: number;
    readonly sourcePaths: readonly string[];
    readonly omittedSourceCount: number;
    readonly assetLimit: number;
    readonly truncated: boolean;
    readonly scriptablePackSourceCount: number;
    readonly scriptablePackSources: readonly {
      readonly sourcePath: string;
      readonly packageId: string;
      readonly output: 'unproduced';
      readonly reason: 'producer-not-run';
    }[];
    readonly omittedScriptablePackSourceCount: number;
  };
  readonly assets: readonly {
    readonly guid: string;
    readonly type: string;
    readonly source: {
      readonly path: string;
      readonly format: 'meta.json' | 'pack.json' | 'pack.ts';
      readonly revision?: string;
      readonly role: 'author';
    };
    readonly output: {
      readonly status: 'produced' | 'unproduced' | 'unknown';
      readonly availability: 'available' | 'missing' | 'unknown';
      readonly freshness: 'unknown';
      readonly packagePath?: string;
      readonly artifactPaths?: readonly string[];
    };
    readonly dependencies: readonly string[];
    readonly producer: { readonly state: 'not-run' | 'published' | 'unknown' };
    readonly name?: string;
    readonly sourceKey?: string;
    readonly sourceIndex?: number;
  }[];
  readonly summary: {
    readonly assetCount: number;
    readonly emittedAssetCount: number;
    readonly materialCount: number;
    readonly unproducedAssetCount: number;
    readonly unknownAssetCount: number;
    readonly unmaterializedScriptablePackCount: number;
  };
}

type VerificationAsset = AssetVerificationReport['assets'][number];

export function verificationSourceFacts(
  entry: Pick<
    PackIndexEntry,
    'guid' | 'kind' | 'sourcePath' | 'sourceKey' | 'sourceIndex' | 'name'
  > & {
    readonly sourceRevision?: string;
  },
  declaration: ScanSourceDeclaration | undefined,
  fallback: VerificationAsset['source']['format'],
): Omit<VerificationAsset, 'output' | 'producer'> {
  const asset =
    declaration?.format === 'pack.json' &&
    declaration.value.format === 'direct' &&
    entry.sourceKey !== undefined
      ? declaration.value.assets[entry.sourceKey]
      : undefined;
  const name = entry.name ?? asset?.name;
  return {
    guid: entry.guid,
    type: entry.kind,
    source: {
      path: entry.sourcePath,
      format: declaration?.format ?? fallback,
      role: 'author',
      ...(entry.sourceRevision === undefined ? {} : { revision: entry.sourceRevision }),
    },
    dependencies: asset?.refs ?? [],
    ...(name === undefined ? {} : { name }),
    ...(entry.sourceKey === undefined ? {} : { sourceKey: entry.sourceKey }),
    ...(entry.sourceIndex === undefined ? {} : { sourceIndex: entry.sourceIndex }),
  };
}

const VERIFY_PROVENANCE_LIMIT = 256;

/** Bound report projection without inspecting or loading omitted asset payloads. */
export function projectAssetVerificationReport<T>(
  root: string,
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  entries: readonly T[],
  projectEntry: (entry: T) => AssetVerificationReport['assets'][number],
  materialCount: number,
  publishedSources?: ReadonlySet<string>,
): AssetVerificationReport {
  const sourcePaths = [...declarations.keys()].sort();
  const scriptable = [...declarations.values()]
    .filter((declaration) => declaration.format === 'pack.ts')
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const unmaterialized = scriptable.filter(
    (source) =>
      !publishedSources?.has(source.sourcePath) &&
      !publishedSources?.has(source.value.packageId.toLowerCase()),
  );
  const assets = entries.slice(0, VERIFY_PROVENANCE_LIMIT).map(projectEntry);
  return {
    schemaVersion: 'asset-verification-v1',
    root,
    scope: {
      sourceCount: sourcePaths.length,
      assetCount: entries.length,
      sourcePaths: sourcePaths.slice(0, VERIFY_PROVENANCE_LIMIT),
      omittedSourceCount: Math.max(0, sourcePaths.length - VERIFY_PROVENANCE_LIMIT),
      assetLimit: VERIFY_PROVENANCE_LIMIT,
      truncated: entries.length > VERIFY_PROVENANCE_LIMIT,
      scriptablePackSourceCount: scriptable.length,
      scriptablePackSources: unmaterialized.slice(0, VERIFY_PROVENANCE_LIMIT).map((source) => ({
        sourcePath: source.sourcePath,
        packageId: source.value.packageId,
        output: 'unproduced',
        reason: 'producer-not-run',
      })),
      omittedScriptablePackSourceCount: Math.max(
        0,
        unmaterialized.length - VERIFY_PROVENANCE_LIMIT,
      ),
    },
    assets,
    summary: {
      assetCount: entries.length,
      emittedAssetCount: assets.length,
      materialCount,
      unproducedAssetCount: assets.filter((asset) => asset.output.status === 'unproduced').length,
      unknownAssetCount: assets.filter((asset) => asset.output.status === 'unknown').length,
      unmaterializedScriptablePackCount: unmaterialized.length,
    },
  };
}
