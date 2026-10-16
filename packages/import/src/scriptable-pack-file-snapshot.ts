import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isScriptablePackAssetKind, validatePack } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Asset, AssetGuid as AssetGuidType, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type {
  ScriptablePackAssetSnapshot,
  ScriptablePackAssetSnapshotSource,
} from './scriptable-pack.js';
import { scriptablePackFingerprint as digest } from './scriptable-pack-fingerprint.js';

export interface ScriptablePackFileAssetSnapshotSourceOptions {
  readonly assetRoots: readonly string[];
}

export type ScriptablePackFileAssetSnapshotError =
  | {
      readonly code: 'scriptable-pack-file-root-unreadable';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly root: string; readonly reason: string };
    }
  | {
      readonly code: 'scriptable-pack-file-unreadable';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly path: string; readonly reason: string };
    }
  | {
      readonly code: 'scriptable-pack-file-json-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly path: string; readonly reason: string };
    }
  | {
      readonly code: 'scriptable-pack-file-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly path: string;
        readonly ajvErrors: readonly { readonly instancePath: string; readonly message: string }[];
      };
    }
  | {
      readonly code: 'scriptable-pack-file-guid-collision';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly guid: string; readonly paths: readonly [string, string] };
    }
  | {
      readonly code: 'scriptable-pack-file-asset-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly path: string; readonly guid: string; readonly reason: string };
    }
  | {
      readonly code: 'asset-not-found';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly guid: string };
    };

interface PackAssetRow {
  readonly guid: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly refs: readonly string[];
  readonly [key: string]: unknown;
}

interface PackDocument {
  readonly assets: readonly PackAssetRow[];
  readonly [key: string]: unknown;
}

interface IndexedAsset {
  readonly asset: Asset;
  readonly digest: string;
}

interface SnapshotIndex {
  readonly generation: number;
  readonly assets: ReadonlyMap<string, IndexedAsset>;
}

type SnapshotResult<T> = Result<T, ScriptablePackFileAssetSnapshotError>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function generationFromDigest(value: string): number {
  const parsed = Number.parseInt(value.slice('sha256:'.length, 'sha256:'.length + 8), 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectPackFiles(
  assetRoots: readonly string[],
): Promise<SnapshotResult<readonly string[]>> {
  const files = new Set<string>();

  async function visit(directory: string): Promise<SnapshotResult<void>> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(directory, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch (error) {
      return err({
        code: 'scriptable-pack-file-root-unreadable',
        expected: 'every configured ScriptablePack asset root to be readable',
        hint: 'restore the asset root or configure a readable directory, then retry the ScriptablePack build',
        detail: { root: directory, reason: reasonOf(error) },
      });
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(child);
        if (!nested.ok) return nested;
      } else if (entry.isFile() && entry.name.endsWith('.pack.json')) {
        files.add(child);
      }
    }
    return ok(undefined);
  }

  for (const rawRoot of [...new Set(assetRoots.map((root) => resolve(root)))].sort((a, b) =>
    a.localeCompare(b),
  )) {
    let info: import('node:fs').Stats;
    try {
      info = await stat(rawRoot);
    } catch (error) {
      return err({
        code: 'scriptable-pack-file-root-unreadable',
        expected: 'every configured ScriptablePack asset root to exist and be readable',
        hint: 'restore the asset root or configure a readable directory, then retry the ScriptablePack build',
        detail: { root: rawRoot, reason: reasonOf(error) },
      });
    }
    if (info.isFile()) {
      if (rawRoot.endsWith('.pack.json')) files.add(rawRoot);
      continue;
    }
    if (!info.isDirectory()) {
      return err({
        code: 'scriptable-pack-file-root-unreadable',
        expected: 'every configured ScriptablePack asset root to be a file or directory',
        hint: 'configure an asset root containing ordinary .pack.json files, then retry the ScriptablePack build',
        detail: { root: rawRoot, reason: 'root is neither a file nor a directory' },
      });
    }
    const visited = await visit(rawRoot);
    if (!visited.ok) return visited;
  }

  return ok([...files].sort((left, right) => left.localeCompare(right)));
}

function invalidPack(
  path: string,
  errors: readonly { readonly instancePath: string; readonly message: string }[],
): ScriptablePackFileAssetSnapshotError {
  return {
    code: 'scriptable-pack-file-invalid',
    expected: 'a schema-valid ordinary .pack.json package',
    hint: 'repair the Pack JSON against the package schema, then retry the ScriptablePack build',
    detail: { path, ajvErrors: errors },
  };
}

function assetFromRow(
  path: string,
  row: PackAssetRow,
): SnapshotResult<{ readonly asset: Asset; readonly digest: string }> {
  if (!isScriptablePackAssetKind(row.kind)) {
    return err({
      code: 'scriptable-pack-file-asset-invalid',
      expected: 'an ordinary ScriptablePack Asset kind from SCRIPTABLE_PACK_ASSET_KINDS',
      hint: 'use an ordinary engine Asset kind or keep the custom payload outside this Asset snapshot source',
      detail: { path, guid: row.guid, reason: `unsupported kind ${JSON.stringify(row.kind)}` },
    });
  }
  if (!isRecord(row.payload)) {
    return err({
      code: 'scriptable-pack-file-asset-invalid',
      expected: 'the Pack row payload to be a JSON object',
      hint: 'write a complete ordinary Asset payload in the .pack.json row, then retry the ScriptablePack build',
      detail: { path, guid: row.guid, reason: 'payload is not an object' },
    });
  }
  const payloadKind = row.payload.kind;
  if (payloadKind !== undefined && payloadKind !== row.kind) {
    return err({
      code: 'scriptable-pack-file-asset-invalid',
      expected: 'the row kind and payload.kind to agree',
      hint: 'repair the duplicated kind discriminant in the .pack.json row, then retry the ScriptablePack build',
      detail: {
        path,
        guid: row.guid,
        reason: `row kind ${JSON.stringify(row.kind)} does not match payload.kind ${JSON.stringify(payloadKind)}`,
      },
    });
  }
  const asset = { ...row.payload, kind: row.kind } as Asset;
  return ok({ asset, digest: digest(asset) });
}

async function indexPackFiles(
  assetRoots: readonly string[],
): Promise<SnapshotResult<SnapshotIndex>> {
  const files = await collectPackFiles(assetRoots);
  if (!files.ok) return files;

  const byGuid = new Map<string, IndexedAsset>();
  const pathsByGuid = new Map<string, string>();
  const documents: PackDocument[] = [];

  for (const path of files.value) {
    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch (error) {
      return err({
        code: 'scriptable-pack-file-unreadable',
        expected: 'a readable .pack.json file',
        hint: 'restore the .pack.json file, then retry the ScriptablePack build',
        detail: { path, reason: reasonOf(error) },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (error) {
      return err({
        code: 'scriptable-pack-file-json-invalid',
        expected: 'a parseable JSON .pack.json file',
        hint: 'repair or restore the .pack.json file, then retry the ScriptablePack build',
        detail: { path, reason: reasonOf(error) },
      });
    }

    if (!validatePack(parsed)) {
      return err(
        invalidPack(
          path,
          (validatePack.errors ?? []).map((error) => ({
            instancePath: error.instancePath,
            message: error.message ?? 'unknown schema validation error',
          })),
        ),
      );
    }

    const document = parsed as PackDocument;
    documents.push(document);
    for (const row of document.assets) {
      const existingPath = pathsByGuid.get(row.guid.toLowerCase());
      if (existingPath !== undefined) {
        return err({
          code: 'scriptable-pack-file-guid-collision',
          expected: 'each ordinary Pack asset GUID to be declared by exactly one .pack.json file',
          hint: 'remove the duplicate GUID declaration or keep one authoritative .pack.json package, then retry',
          detail: { guid: row.guid.toLowerCase(), paths: [existingPath, path] },
        });
      }
      const asset = assetFromRow(path, row);
      if (!asset.ok) return asset;
      const key = row.guid.toLowerCase();
      pathsByGuid.set(key, path);
      byGuid.set(key, asset.value);
    }
  }

  const sourceDigest = digest(documents.map(digest).sort());
  return ok({
    generation: generationFromDigest(sourceDigest),
    assets: byGuid,
  });
}

/**
 * Create a build-time ScriptablePack reader backed by ordinary `.pack.json`
 * files below the configured asset roots. The first read builds one immutable
 * GUID index; subsequent reads return private Asset snapshots from that index.
 */
export function createScriptablePackFileAssetSnapshotSource(
  options: ScriptablePackFileAssetSnapshotSourceOptions,
): ScriptablePackAssetSnapshotSource {
  const index = indexPackFiles(options.assetRoots);
  return {
    async readByGuid(
      guid: AssetGuidType,
    ): Promise<Result<ScriptablePackAssetSnapshot, ScriptablePackFileAssetSnapshotError>> {
      const key = AssetGuid.format(guid).toLowerCase();
      const indexed = await index;
      if (!indexed.ok) return indexed;
      const asset = indexed.value.assets.get(key);
      if (asset === undefined) {
        return err({
          code: 'asset-not-found',
          expected: `an ordinary .pack.json asset with GUID ${key} under the configured asset roots`,
          hint: 'add the dependency to an asset root or declare it as a ScriptablePack external reference, then retry',
          detail: { guid: key },
        });
      }
      return ok({
        asset: structuredClone(asset.asset),
        generation: indexed.value.generation,
        digest: asset.digest,
      });
    },
  };
}
