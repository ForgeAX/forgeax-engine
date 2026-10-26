import { isValidAssetGuidString } from '@forgeax/engine-types';
import { decodeCatalogWire } from './catalog-wire.js';
import { type AssetCliContext, emitAssetCliError } from './cli-output.js';

// @forgeax/engine-pack/src/cli-asset — Pack producer implementation used by
// DevKit's unified `forgeax asset` command. It is not a package bin.
//
// stderr contract (plan-strategy section 2.3 weak-contract): every error
// path emits a single JSON Lines record carrying `code` / `expected` /
// `hint`; `detail` is included when the underlying error supplied one.
// Exit codes: 0 success, 1 any error.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as zlib from 'node:zlib';
import { decodeDocumentText } from '@forgeax/engine-codec';
import type {
  ArtifactDescriptor,
  AssetEvidence,
  CookReceipt,
  PackIndexEntry,
} from '@forgeax/engine-types';
import { validateArtifactPath } from './artifact-path.js';
import { runAtlas } from './atlas/run-atlas.js';
import {
  buildOfflineAssetEvidence,
  type OfflineArtifactInput,
} from './evidence/offline-evidence.js';
import { readSourceInventory } from './evidence/source-inventory.js';

import { parsePackV2 } from './index.js';
import { projectScriptablePackMeta } from './pack-authoring.js';
import { declaredPackAssets, type ScanSourceDeclaration, scanInventory } from './scanner.js';
import { loadScriptablePack } from './scriptable-pack-node.js';

// The unified DevKit command tree reuses the producer implementation without
// reviving the historical standalone executable as a second public surface.
export { runAtlas } from './atlas/run-atlas.js';

export interface PackEntry
  extends Pick<
    PackIndexEntry,
    'guid' | 'kind' | 'sourcePath' | 'name' | 'sourceKey' | 'sourceIndex'
  > {
  readonly sourceRevision?: string;
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

const ASSET_VERIFY_LIMIT = 256;

type VerificationFacts = Pick<
  AssetVerificationReport['assets'][number],
  'dependencies' | 'output' | 'producer'
>;

interface AssetCtx extends AssetCliContext {
  /** Optional cwd override (defaults to `process.cwd()`); enables hermetic tests. */
  readonly cwd?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function scanEntries(
  roots: readonly string[],
  ctx: AssetCtx,
): Promise<
  | { ok: true; value: PackEntry[]; declarations: ReadonlyMap<string, ScanSourceDeclaration> }
  | { ok: false }
> {
  const result = await scanInventory(roots);
  if (!result.ok) {
    emitAssetCliError(ctx, {
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
      detail: result.error.detail,
    });
    return { ok: false };
  }
  const entries: PackEntry[] = [];
  // The scanner is the single identity projection for Pack JSON. ScriptablePack
  // source modules deliberately contribute no rows until a build generation.
  for (const declaration of result.value.declarations.values()) {
    if (declaration.format !== 'meta.json') continue;
    const sourcePath = declaration.sourcePath;
    const assets = declaration.value.subAssets;
    for (const asset of assets) {
      if (!isRecord(asset) || typeof asset.guid !== 'string' || typeof asset.kind !== 'string') {
        continue;
      }
      const name =
        typeof asset.name === 'string'
          ? asset.name
          : typeof asset.sourceKey === 'string'
            ? asset.sourceKey
            : undefined;
      entries.push({
        guid: asset.guid,
        kind: asset.kind,
        sourcePath,
        sourceIndex: asset.sourceIndex,
        sourceRevision: declaration.sourceRevision,
        ...(name === undefined ? {} : { name }),
      });
    }
  }
  const names = new Map<string, string>();
  for (const declaration of result.value.declarations.values()) {
    if (declaration.format !== 'pack.json') continue;
    for (const asset of declaredPackAssets(declaration.value)) {
      if (typeof asset.name === 'string') {
        names.set(`${declaration.sourcePath}:${asset.guid.toLowerCase()}`, asset.name);
      }
    }
  }
  for (const inventoryEntry of result.value.inventory) {
    const declaration = result.value.declarations.get(inventoryEntry.sourcePath) as
      | ScanSourceDeclaration
      | undefined;
    const name = names.get(`${inventoryEntry.sourcePath}:${inventoryEntry.guid.toLowerCase()}`);
    entries.push({
      guid: inventoryEntry.guid,
      kind: inventoryEntry.kind,
      sourcePath: inventoryEntry.sourcePath,
      sourceRevision: inventoryEntry.sourceRevision,
      ...(inventoryEntry.sourceKey === undefined ? {} : { sourceKey: inventoryEntry.sourceKey }),
      ...(inventoryEntry.sourceIndex === undefined
        ? {}
        : { sourceIndex: inventoryEntry.sourceIndex }),
      ...(name === undefined ? {} : { name }),
      ...(declaration?.format === 'pack.json' &&
      declaration.value.schemaVersion === '3.0.0' &&
      inventoryEntry.sourceKey !== undefined &&
      name === undefined
        ? { name: inventoryEntry.sourceKey }
        : {}),
    });
  }
  entries.sort((left, right) =>
    `${left.sourcePath}:${left.guid}`.localeCompare(`${right.sourcePath}:${right.guid}`),
  );
  return { ok: true, value: entries, declarations: result.value.declarations };
}

function helpBody(): string {
  return [
    'forgeax asset — offline pack scanner / lookup / verifier / atlas builder',
    '',
    'Usage:',
    '  forgeax asset list --root <project> --json',
    '  forgeax asset inspect --subject <guid> --root <project> --json',
    '  forgeax asset verify --root <project> --json',
    '    output is bounded to 256 assets and includes the scanned source scope',
    '  forgeax asset inspect --subject <source.pack.ts> --root <project> --json',
    '  forgeax asset atlas --input <glob> --name <prefix> --root <project> [--output <dir>]',
    '',
    'AI recovery commands (host execution remains explicit):',
    '  inspect [--guid <guid>]      read subject, execution, lifecycle, authority, and sourceKey evidence',
    '  rebuild [--guid <guid>]     request the declared producer to rebuild',
    '  cold-cook [--guid <guid>]   discard invalid DDC output and cook from author authority',
    '  preview-LKG [--guid <guid>] read the explicit last-known-good projection',
    '  override [--guid <guid>]    request an Editor-owned override through its gateway',
    '  promote [--guid <guid>]     request an authored Pack from an imported result',
    '  stop-publish [--guid <guid>] block publication while evidence is incomplete',
    '',
  ].join('\n');
}

export async function runCliAsset(rest: string[], ctx: AssetCtx): Promise<number> {
  const [sub, ...subRest] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    ctx.stdoutWrite(helpBody());
    return 0;
  }
  switch (sub) {
    case 'scan':
      return runScan(subRest, ctx);
    case 'lookup':
      return runLookup(subRest, ctx);
    case 'verify':
      return runVerify(subRest, ctx);
    case 'atlas':
      return runAtlas(subRest, ctx);
    case 'meta':
      return runMeta(subRest, ctx);
    case 'inspect':
    case 'rebuild':
    case 'cold-cook':
    case 'preview-LKG':
    case 'override':
    case 'promote':
    case 'stop-publish':
      return runRecoveryCommand(sub, subRest, ctx);
    default:
      return emitAssetCliError(ctx, {
        code: 'unknown-subcommand',
        expected: 'subcommand in {scan, lookup, verify, atlas, meta}',
        hint: "run 'forgeax help asset' for usage",
        detail: { subcommand: sub },
      });
  }
}

async function runMeta(rest: string[], ctx: AssetCtx): Promise<number> {
  let source: string | undefined;
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { json: { type: 'boolean' } },
    });
    source = parsed.positionals[0];
    if (source === undefined || parsed.positionals.length !== 1) {
      throw new Error('exactly one ScriptablePack source path is required');
    }
  } catch (error) {
    return emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset inspect --subject <source.pack.ts> --root <project> --json',
      hint: 'pass one trusted ScriptablePack module path',
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const loaded = await loadScriptablePack(absolutePath(source, cwd), {
    metadataOnly: true,
  });
  if (!loaded.ok) return emitAssetCliError(ctx, loaded.error);
  ctx.stdoutWrite(JSON.stringify(projectScriptablePackMeta(loaded.value, source)));
  return 0;
}

/** Emit a canonical host-operation request so recovery actions are executable
 * from one CLI door even when the actual write/cook owner is the running host. */
async function runRecoveryCommand(
  operation:
    | 'inspect'
    | 'rebuild'
    | 'cold-cook'
    | 'preview-LKG'
    | 'override'
    | 'promote'
    | 'stop-publish',
  rest: string[],
  ctx: AssetCtx,
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { guid: { type: 'string' } },
    });
    const guid = parsed.values.guid;
    ctx.stdoutWrite(
      JSON.stringify({
        operation,
        status: 'accepted',
        execution: 'host-gateway',
        ...(typeof guid === 'string' ? { guid } : {}),
        hint: 'forward this operation descriptor to the running Editor/Studio gateway for its terminal result',
      }),
    );
    return 0;
  } catch (error) {
    return emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: `${operation} [--guid <guid>]`,
      hint: "run 'forgeax help asset' for usage",
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function runScan(rest: string[], ctx: AssetCtx): Promise<number> {
  let roots: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { roots: { type: 'string', multiple: true } },
    });
    roots = (parsed.values.roots as string[] | undefined) ?? [ctx.cwd ?? process.cwd()];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset list --root <project> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
  }
  const result = await scanEntries(roots, ctx);
  if (!result.ok) return 1;
  ctx.stdoutWrite(JSON.stringify(result.value));
  return 0;
}

async function runLookup(rest: string[], ctx: AssetCtx): Promise<number> {
  if (rest.some((value) => value === '--guid')) return runEvidence(rest, ctx);
  const [guid] = rest;
  if (typeof guid !== 'string') {
    return emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset inspect --subject <guid> --root <project> --json',
      hint: 'pass a 36-char dash-form UUID positional argument',
    });
  }
  if (!isValidAssetGuidString(guid)) {
    return emitAssetCliError(ctx, {
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: guid, reason: 'invalid-format' },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;
  const normalized = guid.toLowerCase();
  const entry = result.value.find((e) => e.guid.toLowerCase() === normalized);
  if (entry === undefined) {
    return emitAssetCliError(ctx, {
      code: 'asset-not-found',
      expected: 'GUID present in scan results',
      hint: 'run scan to list known GUIDs; verify the GUID came from a .meta.json sub-asset entry',
      detail: { guid: normalized },
    });
  }
  ctx.stdoutWrite(JSON.stringify(entry));
  return 0;
}

function artifactPaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((descriptor) =>
    isRecord(descriptor) && typeof descriptor.path === 'string' ? [descriptor.path] : [],
  );
}

function unknownVerificationFacts(): VerificationFacts {
  return {
    dependencies: [],
    output: {
      status: 'unknown',
      availability: 'unknown',
      freshness: 'unknown',
    },
    producer: { state: 'unknown' },
  };
}

function sourceVerificationFacts(
  entry: PackEntry,
  declaration: ScanSourceDeclaration | undefined,
): VerificationFacts {
  if (declaration === undefined) return unknownVerificationFacts();
  if (declaration.format === 'meta.json' || declaration.format === 'pack.ts') {
    return {
      dependencies: [],
      output: {
        status: 'unproduced',
        availability: 'unknown',
        freshness: 'unknown',
      },
      producer: { state: 'not-run' },
    };
  }

  if (declaration.value.schemaVersion === '3.0.0') {
    const parsed = declaration.value;
    if (parsed.format !== 'direct' || entry.sourceKey === undefined) {
      return {
        dependencies: [],
        output: {
          status: 'unproduced',
          availability: 'unknown',
          freshness: 'unknown',
        },
        producer: { state: 'not-run' },
      };
    }
    const asset = parsed.assets[entry.sourceKey];
    return {
      dependencies: asset?.refs ?? [],
      output: {
        status: 'unproduced',
        availability: 'unknown',
        freshness: 'unknown',
      },
      producer: { state: 'not-run' },
    };
  }

  const asset = declaration.value.assets.find(
    (candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase(),
  );
  if (asset === undefined || (asset.execution !== 'direct' && asset.execution !== 'cooked')) {
    return unknownVerificationFacts();
  }
  return {
    dependencies: asset.refs,
    output: {
      // A validated legacy package row is the only published evidence this
      // offline command reads. Artifact bytes and cook receipts remain
      // producer-owned, so availability/freshness stay explicitly unknown.
      status: 'produced',
      availability: 'unknown',
      freshness: 'unknown',
      packagePath: entry.sourcePath,
      ...(asset.artifacts === undefined ? {} : { artifactPaths: artifactPaths(asset.artifacts) }),
    },
    producer: { state: 'published' },
  };
}

async function runVerify(rest: string[], ctx: AssetCtx): Promise<number> {
  if (rest.some((value) => value === '--guid')) return runEvidence(rest, ctx);
  try {
    parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {},
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset verify --root <project> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;
  ctx.stdoutWrite(JSON.stringify(createAssetVerificationReport(cwd, result)));
  return 0;
}

/** Build the bounded provenance projection from one validated scanner pass. */
export function createAssetVerificationReport(
  root: string,
  result: {
    readonly value: readonly PackEntry[];
    readonly declarations: ReadonlyMap<string, ScanSourceDeclaration>;
  },
): AssetVerificationReport {
  const declarations = result.declarations;
  const sourcePaths = [...declarations.keys()].sort();
  const scriptablePackSources = [...declarations.values()]
    .filter(
      (declaration): declaration is Extract<ScanSourceDeclaration, { format: 'pack.ts' }> =>
        declaration.format === 'pack.ts',
    )
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const emittedEntries = result.value.slice(0, ASSET_VERIFY_LIMIT);
  const facts = emittedEntries.map((entry) =>
    sourceVerificationFacts(entry, declarations.get(entry.sourcePath)),
  );
  const materialCount = result.value.filter((e) => e.kind === 'material').length;
  return {
    schemaVersion: 'asset-verification-v1',
    root,
    scope: {
      sourceCount: sourcePaths.length,
      assetCount: result.value.length,
      sourcePaths: sourcePaths.slice(0, ASSET_VERIFY_LIMIT),
      omittedSourceCount: Math.max(0, sourcePaths.length - ASSET_VERIFY_LIMIT),
      assetLimit: ASSET_VERIFY_LIMIT,
      truncated: result.value.length > ASSET_VERIFY_LIMIT,
      scriptablePackSourceCount: scriptablePackSources.length,
      scriptablePackSources: scriptablePackSources.slice(0, ASSET_VERIFY_LIMIT).map((source) => ({
        sourcePath: source.sourcePath,
        packageId: source.value.packageId,
        output: 'unproduced' as const,
        reason: 'producer-not-run' as const,
      })),
      omittedScriptablePackSourceCount: Math.max(
        0,
        scriptablePackSources.length - ASSET_VERIFY_LIMIT,
      ),
    },
    assets: emittedEntries.map((entry, index) => ({
      guid: entry.guid,
      type: entry.kind,
      source: {
        path: entry.sourcePath,
        format: declarations.get(entry.sourcePath)?.format ?? 'pack.json',
        role: 'author' as const,
        ...(entry.sourceRevision === undefined ? {} : { revision: entry.sourceRevision }),
      },
      ...(facts[index] as VerificationFacts),
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.sourceKey === undefined ? {} : { sourceKey: entry.sourceKey }),
      ...(entry.sourceIndex === undefined ? {} : { sourceIndex: entry.sourceIndex }),
    })),
    summary: {
      assetCount: result.value.length,
      emittedAssetCount: emittedEntries.length,
      materialCount,
      unproducedAssetCount: facts.filter((value) => value.output.status === 'unproduced').length,
      unknownAssetCount: facts.filter((value) => value.output.status === 'unknown').length,
      unmaterializedScriptablePackCount: scriptablePackSources.length,
    },
  };
}

interface EvidenceCliOptions {
  readonly guid: string;
  readonly project: string;
  readonly catalog: string;
}

/** Parse the machine-oriented evidence probe flags shared by lookup and verify. */
function parseEvidenceOptions(rest: string[], ctx: AssetCtx): EvidenceCliOptions | undefined {
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        guid: { type: 'string' },
        project: { type: 'string' },
        catalog: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const guid = parsed.values.guid;
    const project = parsed.values.project;
    const catalog = parsed.values.catalog;
    if (typeof guid !== 'string' || typeof project !== 'string' || typeof catalog !== 'string') {
      emitAssetCliError(ctx, {
        code: 'cli-parse-error',
        expected: '--guid <guid> --project <dir> --catalog <path> --json',
        hint: "run 'forgeax help asset' for usage",
      });
      return undefined;
    }
    return { guid, project, catalog };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitAssetCliError(ctx, {
      code: 'cli-parse-error',
      expected: '--guid <guid> --project <dir> --catalog <path> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
    return undefined;
  }
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function readJson(path: string, ctx: AssetCtx): Promise<unknown | undefined> {
  try {
    const text = await decodeDocumentText(await readFile(path));
    if (!text.ok) throw new Error(`document decode failed: ${text.error.code}`);
    return JSON.parse(text.value) as unknown;
  } catch (e) {
    emitAssetCliError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: `readable JSON evidence input at ${path}`,
      hint: 'restore the catalog or cook receipt JSON, then rerun lookup or verify',
      detail: { path, message: e instanceof Error ? e.message : String(e) },
    });
    return undefined;
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

function artifactInputs(
  pack: { readonly guid: string; readonly artifacts: Readonly<Record<string, ArtifactDescriptor>> },
  packagePathValue: string,
): Promise<Readonly<Record<string, OfflineArtifactInput>>> {
  return Promise.all(
    Object.entries(pack.artifacts).map(async ([key, descriptor]) => {
      const pathResult = validateArtifactPath(descriptor.path, {
        packageRoot: dirname(packagePathValue),
        guid: pack.guid,
        artifactKey: key,
      });
      if (!pathResult.ok) return [key, { ...descriptor, verification: 'failed' as const }] as const;
      const artifactPath = resolve(dirname(packagePathValue), pathResult.value);
      try {
        const stored = await readFile(artifactPath);
        const range = descriptor.byteRange;
        const containerOk =
          range === undefined ||
          (Number.isSafeInteger(range.offset) &&
            range.offset >= 0 &&
            Number.isSafeInteger(range.length) &&
            range.length > 0 &&
            Number.isSafeInteger(range.offset + range.length) &&
            range.offset + range.length <= stored.length &&
            descriptor.delivery === undefined &&
            descriptor.integrity !== undefined &&
            `sha256:${createHash('sha256').update(stored).digest('hex')}` === range.bundleDigest);
        const window =
          range === undefined ? stored : stored.subarray(range.offset, range.offset + range.length);
        const bytes = descriptor.contentEncoding === 'zstd' ? zstdDecoded(window) : window;
        const lengthOk =
          descriptor.byteLength === undefined || descriptor.byteLength === bytes.byteLength;
        const digestOk =
          descriptor.integrity === undefined ||
          createHash('sha256').update(bytes).digest('base64') === descriptor.integrity.digest ||
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` ===
            descriptor.integrity.digest;
        return [
          key,
          {
            ...descriptor,
            verification:
              containerOk && lengthOk && digestOk ? ('passed' as const) : ('failed' as const),
          },
        ] as const;
      } catch {
        return [key, { ...descriptor, verification: 'failed' as const }] as const;
      }
    }),
  ).then((entries) => Object.fromEntries(entries));
}

/** Join offline source, catalog, receipt, and Pack v2 facts into one JSON result. */
async function runEvidence(rest: string[], ctx: AssetCtx): Promise<number> {
  const options = parseEvidenceOptions(rest, ctx);
  if (options === undefined) return 1;
  if (!isValidAssetGuidString(options.guid)) {
    return emitAssetCliError(ctx, {
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: options.guid, reason: 'invalid-format' },
    });
  }
  const projectRoot = absolutePath(options.project, ctx.cwd ?? process.cwd());
  const catalogValue = await readJson(absolutePath(options.catalog, ctx.cwd ?? process.cwd()), ctx);
  if (catalogValue === undefined) return 1;
  const rows = catalogRows(catalogValue);
  if (rows === undefined) {
    return emitAssetCliError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: 'catalog JSON array or {entries: []} object',
      hint: 'rebuild the catalog and rerun lookup or verify',
      detail: { path: options.catalog },
    });
  }
  const row = rows.find(
    (candidate) => candidate.guid?.toString().toLowerCase() === options.guid.toLowerCase(),
  );
  if (row === undefined || typeof row.packageUrl !== 'string') {
    return emitAssetCliError(ctx, {
      code: 'asset-not-found',
      expected: 'catalog row with GUID and packageUrl',
      hint: 'rebuild the catalog or verify the GUID came from the project source inventory',
      detail: { guid: options.guid },
    });
  }
  const packageUrl = row.packageUrl;
  const packageFile = packagePath(projectRoot, packageUrl);
  const packageValue = await readJson(packageFile, ctx);
  if (packageValue === undefined) return 1;
  const parsedPack = parsePackV2(packageValue);
  if (!parsedPack.ok) return emitAssetCliError(ctx, parsedPack.error);
  const asset = parsedPack.value.assets.find(
    (candidate) => candidate.guid.toLowerCase() === options.guid.toLowerCase(),
  );
  if (asset === undefined) {
    return emitAssetCliError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: 'Pack v2 package asset with the requested GUID',
      hint: 'recook the package and rebuild the catalog so the GUID and package agree',
      detail: { guid: options.guid, packageUrl },
    });
  }
  const source = await readSourceInventory({ projectRoot, guid: options.guid });
  const receipt =
    typeof row.cookReceiptUrl === 'string'
      ? await readJson(packagePath(projectRoot, row.cookReceiptUrl), ctx)
      : undefined;
  if (row.cookReceiptUrl !== undefined && receipt === undefined) return 1;
  const packageArtifacts = await artifactInputs(asset, packageFile);
  const result = await buildOfflineAssetEvidence({
    guid: options.guid,
    ...(source === undefined ? {} : { source }),
    locator: {
      packageUrl,
      ...(typeof row.cookReceiptUrl === 'string' ? { cookReceiptUrl: row.cookReceiptUrl } : {}),
    },
    ...(receipt !== undefined ? { receipt: receipt as CookReceipt } : {}),
    package: { guid: asset.guid, artifacts: packageArtifacts },
  });
  if (!result.ok) return emitAssetCliError(ctx, result.error);
  ctx.stdoutWrite(JSON.stringify(result.value satisfies AssetEvidence));
  return 0;
}
