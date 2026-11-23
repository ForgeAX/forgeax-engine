import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { decodeDocumentText } from '@forgeax/engine-codec';
import {
  type ArtifactDescriptor,
  type AssetEvidence,
  type AssetEvidencePackageInput,
  type CookReceipt,
  err,
  isValidAssetGuidString,
  ok,
  projectAssetEvidence,
  type Result,
} from '@forgeax/engine-types';
import { validateArtifactPath } from './artifact-path.js';
import {
  matchesArtifactSha256,
  selectDecodedArtifactBytes,
  storedArtifactRangeIssue,
} from './bundle.js';
import { decodeCatalogWire } from './catalog-wire.js';
import type { AssetCliError } from './cli-output.js';
import { readSourceInventory } from './evidence/source-inventory.js';

export type { AssetVerificationReport } from './evidence/source-inventory.js';

import { parsePackV2 } from './schema-compiled.js';

export { runAtlas, runAtlasCommand } from './atlas/run-atlas.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface OfflineAssetEvidenceOptions {
  readonly guid: string;
  readonly project: string;
  readonly catalog: string;
}

async function readJson(path: string): Promise<Result<unknown, AssetCliError>> {
  try {
    const text = await decodeDocumentText(await readFile(path));
    if (!text.ok) throw new Error(`document decode failed: ${text.error.code}`);
    return ok(JSON.parse(text.value) as unknown);
  } catch (cause) {
    return err({
      code: 'asset-evidence-input-invalid',
      expected: `readable JSON evidence input at ${path}`,
      hint: 'restore the Catalog, Pack or cook receipt JSON, then rerun asset inspect',
      detail: { path, message: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

function catalogRows(value: unknown): readonly Record<string, unknown>[] | undefined {
  // Offline inspection also accepts row containers without runtime authority.
  const rows =
    isRecord(value) && value.schemaVersion !== 'pack-index-tables/1' ? value.entries : value;
  const decoded = decodeCatalogWire(rows);
  if (!decoded.ok) return undefined;
  const entries: readonly unknown[] = decoded.value;
  return entries.filter(isRecord);
}

function packagePath(projectRoot: string, packageUrl: string): string {
  const relative = packageUrl.replace(/^\/+/, '');
  return resolve(projectRoot, relative);
}

// Node 22.15 adds zstd to zlib; older runtimes report the artifact as unverifiable.
const zstdDecompress = (zlib as { zstdDecompressSync?: (bytes: Uint8Array) => Uint8Array })
  .zstdDecompressSync;

function zstdDecoded(bytes: Uint8Array): Uint8Array {
  if (zstdDecompress === undefined) throw new Error('zstd decoding requires Node 22.15');
  return zstdDecompress(bytes);
}

function decodedOfflineArtifact(bytes: Uint8Array, descriptor: ArtifactDescriptor): Uint8Array {
  const decoded = descriptor.contentEncoding === 'zstd' ? zstdDecoded(bytes) : bytes;
  const selected = selectDecodedArtifactBytes(decoded, descriptor);
  if (!selected.ok) throw new Error(selected.error);
  return selected.value;
}

function artifactInputs(
  pack: { readonly guid: string; readonly artifacts: Readonly<Record<string, ArtifactDescriptor>> },
  packagePathValue: string,
): Promise<AssetEvidencePackageInput['artifacts']> {
  return Promise.all(
    Object.entries(pack.artifacts).map(async ([key, descriptor]) => {
      const pathResult = validateArtifactPath(descriptor.path, {
        packageRoot: dirname(packagePathValue),
        guid: pack.guid,
        artifactKey: key,
      });
      if (!pathResult.ok) return [key, { descriptor, verification: 'failed' as const }] as const;
      const artifactPath = resolve(dirname(packagePathValue), pathResult.value);
      try {
        const stored = await readFile(artifactPath);
        const range = descriptor.byteRange;
        if (
          storedArtifactRangeIssue(descriptor) !== undefined ||
          (range !== undefined &&
            (range.offset + range.length > stored.length ||
              `sha256:${createHash('sha256').update(stored).digest('hex')}` !== range.bundleDigest))
        )
          return [key, { descriptor, verification: 'failed' as const }] as const;
        const window =
          range === undefined ? stored : stored.subarray(range.offset, range.offset + range.length);
        const bytes = decodedOfflineArtifact(window, descriptor);
        const lengthOk =
          descriptor.byteLength === undefined || descriptor.byteLength === bytes.byteLength;
        const digestOk =
          descriptor.integrity === undefined ||
          matchesArtifactSha256(
            descriptor.integrity.digest,
            createHash('sha256').update(bytes).digest(),
          );
        return [
          key,
          {
            descriptor,
            verification: lengthOk && digestOk ? ('passed' as const) : ('failed' as const),
          },
        ] as const;
      } catch {
        return [key, { descriptor, verification: 'failed' as const }] as const;
      }
    }),
  ).then((entries) => Object.fromEntries(entries));
}

/** Join offline source, catalog, receipt, and Pack v2 facts into one JSON result. */
export async function inspectOfflineAsset(
  options: OfflineAssetEvidenceOptions,
): Promise<Result<AssetEvidence, AssetCliError>> {
  if (!isValidAssetGuidString(options.guid)) {
    return err({
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: options.guid, reason: 'invalid-format' },
    });
  }
  const catalog = await readJson(options.catalog);
  if (!catalog.ok) return catalog;
  const rows = catalogRows(catalog.value);
  if (rows === undefined) {
    return err({
      code: 'asset-evidence-input-invalid',
      expected: 'catalog JSON array or {entries: []} object',
      hint: 'rebuild the catalog and rerun asset inspect',
      detail: { path: options.catalog },
    });
  }
  const row = rows.find(
    (candidate) => candidate.guid?.toString().toLowerCase() === options.guid.toLowerCase(),
  );
  if (row === undefined || typeof row.packageUrl !== 'string') {
    return err({
      code: 'asset-not-found',
      expected: 'catalog row with GUID and packageUrl',
      hint: 'rebuild the catalog or verify the GUID came from the project source inventory',
      detail: { guid: options.guid },
    });
  }
  const packageUrl = row.packageUrl;
  const packageFile = packagePath(options.project, packageUrl);
  const packageValue = await readJson(packageFile);
  if (!packageValue.ok) return packageValue;
  const parsedPack = parsePackV2(packageValue.value);
  if (!parsedPack.ok) return parsedPack;
  const asset = parsedPack.value.assets.find(
    (candidate) => candidate.guid.toLowerCase() === options.guid.toLowerCase(),
  );
  if (asset === undefined) {
    return err({
      code: 'asset-evidence-input-invalid',
      expected: 'Pack v2 package asset with the requested GUID',
      hint: 'recook the package and rebuild the catalog so the GUID and package agree',
      detail: { guid: options.guid, packageUrl },
    });
  }
  const source = await readSourceInventory({ projectRoot: options.project, guid: options.guid });
  const receiptUrl = typeof row.cookReceiptUrl === 'string' ? row.cookReceiptUrl : undefined;
  const receipt =
    receiptUrl === undefined ? undefined : await readJson(packagePath(options.project, receiptUrl));
  if (receipt && !receipt.ok) return receipt;
  const packageArtifacts = await artifactInputs(asset, packageFile);
  return projectAssetEvidence({
    guid: options.guid,
    ...(source === undefined ? {} : { source }),
    locator: { packageUrl, ...(receiptUrl === undefined ? {} : { cookReceiptUrl: receiptUrl }) },
    ...(receipt === undefined ? {} : { receipt: receipt.value as CookReceipt }),
    package: { guid: asset.guid, artifacts: packageArtifacts },
  });
}
