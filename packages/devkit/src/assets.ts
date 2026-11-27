import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { decodeDocumentText } from '@forgeax/engine-codec';
import { runCliFbx } from '@forgeax/engine-fbx/cli-fbx';
import { bakeFont } from '@forgeax/engine-font/cli-font';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { directPackCookInput } from '@forgeax/engine-import';
import { importMeshFile } from '@forgeax/engine-mesh-io';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createFileSystemPackAuthoringGateway } from '@forgeax/engine-pack/build';
import { inspectOfflineAsset } from '@forgeax/engine-pack/cli-asset';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { type ScanInventory, type ScanOptions, scanInventory } from '@forgeax/engine-pack/scanner';
import { validateMeta } from '@forgeax/engine-pack/schema';
import { projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  createMaterialPackCooker,
  createTextureGeneratorPackCooker,
} from '@forgeax/engine-shader-compiler';
import { isValidAssetGuidString, ok } from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { createDefaultCloudCookers } from './cloud-cookers.js';
import { verifyDist } from './dist.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import { DEFAULT_IMPORTERS } from './importers.js';
import { commandError, readProjectFacts } from './project.js';
import {
  projectSourceFailure,
  projectSourceRoots,
  scanProjectSources,
} from './project-source-scan.js';
import type {
  AssetAddOptions,
  AssetInspectOptions,
  AssetListOptions,
  AssetResolveOptions,
  CommandError,
  CommandResult,
  ProjectCommandOptions,
  ProjectFacts,
} from './types.js';
import { completeCommand, rejectCommand } from './types.js';

const sourceFormats = DEFAULT_IMPORTERS.flatMap((importer) =>
  (importer.capabilities?.sourceFormats ?? []).map((format) => ({
    ...format,
    importer: importer.key,
  })),
);
function sourceFormat(path: string) {
  const lower = path.toLowerCase();
  return sourceFormats.find((format) =>
    format.extensions.some((extension) => lower.endsWith(extension)),
  );
}
const meshExtensions = new Set(['.obj', '.stl', '.svg']);
const explicitProducers = {
  '.gltf': addGltf,
  '.glb': addGltf,
  '.fbx': (path: string, dryRun: boolean) => addModel(path, dryRun, 'FBX'),
  '.ttf': addFont,
  '.otf': addFont,
};
function addGltf(path: string, dryRun: boolean) {
  return addModel(path, dryRun, 'glTF');
}

function produceAsset(path: string, options: AssetAddOptions) {
  const extension = extname(path).toLowerCase();
  if (meshExtensions.has(extension)) return importMeshFile(path, options.dryRun === true);
  const format = sourceFormat(path);
  if (format !== undefined) return addSource(path, options.dryRun === true, format);
  const produce = Object.hasOwn(explicitProducers, extension)
    ? explicitProducers[extension as keyof typeof explicitProducers]
    : undefined;
  return produce?.(path, options.dryRun === true);
}

const ASSET_LIST_DEFAULT_LIMIT = 100;
const ASSET_LIST_MAX_LIMIT = 256;

/** Owner failures cross the command boundary as the CommandError fields only (e.g. Pack `actual` stays behind). */
function ownerFailure({ code, expected, hint, detail }: CommandError): CommandResult<never> {
  return rejectCommand({ code, expected, hint, detail });
}

async function sourcesAt(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const output: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
      continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...(await sourcesAt(child)));
    else if (entry.isFile() && !entry.name.endsWith('.meta.json')) output.push(child);
  }
  return output;
}

async function addSource(
  sourcePath: string,
  dryRun: boolean,
  format: NonNullable<ReturnType<typeof sourceFormat>>,
): Promise<CommandResult<unknown>> {
  const metaPath = `${sourcePath}.meta.json`;
  const source = basename(sourcePath);
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      return rejectCommand({
        code: 'asset-meta-unreadable',
        expected: 'an absent or readable JSON sidecar',
        hint: 'Repair the existing sidecar before adding the source again.',
        detail: { source: sourcePath, metaPath },
      });
    }
  }
  if (existing !== undefined) {
    if (!validateMeta(existing))
      return rejectCommand({
        code: 'asset-meta-conflict',
        expected: 'the existing sidecar to satisfy the Meta schema',
        hint: 'Repair the reported sidecar fields without replacing authored identity.',
        detail: { source: sourcePath, metaPath, diagnostics: validateMeta.errors ?? [] },
      });
    const value = existing as {
      importer?: unknown;
      source?: unknown;
      subAssets?: readonly { guid?: unknown; kind?: unknown; sourceIndex?: unknown }[];
    };
    const row = value.subAssets?.[0];
    if (
      value.importer !== format.importer ||
      value.source !== source ||
      value.subAssets?.length !== 1 ||
      typeof row?.guid !== 'string' ||
      !isValidAssetGuidString(row.guid) ||
      row.sourceIndex !== 0 ||
      row.kind !== format.kind
    ) {
      return rejectCommand({
        code: 'asset-meta-conflict',
        expected: `the existing sidecar to describe this ${format.importer} source and one ${format.kind} identity`,
        hint: 'Resolve the sidecar conflict explicitly; DevKit will not replace authored identity.',
        detail: { source: sourcePath, metaPath },
      });
    }
    return { ok: true, value: { source: sourcePath, metaPath, guid: row.guid, reused: true } };
  }
  const guid = AssetGuid.format(AssetGuid.random());
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: format.importer,
    source,
    importSettings: format.importSettings,
    subAssets: [{ guid, sourceIndex: 0, kind: format.kind, sourceKey: format.sourceKey }],
  } as const;
  if (!dryRun) await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  return { ok: true, value: { source: sourcePath, metaPath, guid, reused: false, dryRun } };
}

function existingPath(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function addModel(
  sourcePath: string,
  dryRun: boolean,
  format: 'glTF' | 'FBX',
): Promise<CommandResult<unknown>> {
  if (dryRun) {
    const exists = await existingPath(`${sourcePath}.meta.json`);
    return completeCommand({
      source: sourcePath,
      metaPath: `${sourcePath}.meta.json`,
      reused: exists,
      dryRun: true,
    });
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = format === 'glTF' ? runCliGltf : runCliFbx;
  const exitCode = await run(['import', sourcePath], {
    stdoutWrite: (line) => stdout.push(line),
    stderrWrite: (line) => stderr.push(line),
  });
  if (exitCode !== 0) {
    try {
      return rejectCommand(JSON.parse(stderr.at(-1) ?? '') as CommandError);
    } catch {
      return rejectCommand({
        code: 'asset-add-failed',
        expected: `the ${format} producer to create or reuse a valid sidecar`,
        hint: `Inspect the ${format} source and its external references.`,
        detail: { source: sourcePath, diagnostic: stderr.join('\n') },
      });
    }
  }
  return { ok: true, value: { source: sourcePath, metaPath: `${sourcePath}.meta.json` } };
}

async function addFont(sourcePath: string, dryRun: boolean): Promise<CommandResult<unknown>> {
  const output = dirname(sourcePath);
  const stem = basename(sourcePath).replace(/\.[^.]+$/, '');
  const atlasPath = resolve(output, `${stem}.atlas.png`);
  const metaPath = resolve(output, `${stem}.meta.json`);
  if (dryRun) {
    const existing = await Promise.all([existingPath(atlasPath), existingPath(metaPath)]);
    return completeCommand({
      source: sourcePath,
      atlasPath,
      metaPath,
      reused: existing.every(Boolean),
      dryRun: true,
    });
  }
  try {
    await bakeFont(sourcePath, output);
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause) {
      const candidate = cause as Partial<CommandError>;
      if (typeof candidate.code === 'string') return rejectCommand(candidate as CommandError);
    }
    return rejectCommand({
      code: 'asset-font-bake-failed',
      expected: 'the font producer to create an atlas and sidecar',
      hint: cause instanceof Error ? cause.message : 'Inspect the font source and retry.',
      detail: { source: sourcePath },
    });
  }
  return {
    ok: true,
    value: { source: sourcePath, atlasPath, metaPath },
  };
}

export async function assetAddCommand(options: AssetAddOptions): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const target = resolve(facts.value.root, options.path);
  try {
    const sources = await sourcesAt(target);
    const assets: unknown[] = [];
    for (const source of sources) {
      const produced = produceAsset(source, options);
      if (produced === undefined) continue;
      const result = await produced;
      if (!result.ok)
        return rejectCommand({
          code: result.error.code,
          expected: result.error.expected,
          hint: result.error.hint,
          detail: result.error.detail ?? {},
        });
      assets.push(result.value);
    }
    if (assets.length === 0) {
      return rejectCommand({
        code: 'source-package-importer-missing',
        expected: `a supported source: ${[...sourceFormats.flatMap((format) => format.extensions), ...meshExtensions, ...Object.keys(explicitProducers)].join(', ')}`,
        hint: 'Use a supported built-in importer or add an explicit producer before adding this source.',
        detail: { target },
      });
    }
    return { ok: true, value: { root: facts.value.root, assets, dryRun: options.dryRun === true } };
  } catch (cause) {
    return rejectCommand(commandError(cause, 'asset-add-failed'));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function packIndexFailure(
  root: string,
  code: 'asset-index-invalid' | 'asset-index-unreadable',
  detail: Record<string, unknown>,
): CommandResult<never> {
  return rejectCommand({
    code,
    expected: 'dist/pack-index.json to contain readable published asset rows',
    hint:
      code === 'asset-index-unreadable'
        ? 'Rebuild the project to regenerate dist/pack-index.json, then retry.'
        : 'Repair the generated Pack index or rebuild the project before querying assets.',
    detail: { root, ...detail },
  });
}

/**
 * Decode a generated Pack index document. Builds may store `dist/pack-index.json`
 * as UTF-8 JSON or as one zstd frame; every reader goes through this decoder.
 */
async function decodeCatalogDocument(bytes: Uint8Array) {
  const text = await decodeDocumentText(bytes);
  return text.ok ? decodeCatalogWire(JSON.parse(text.value)) : text;
}

export async function readProjectCatalog(root: string): Promise<CommandResult<readonly unknown[]>> {
  const indexPath = resolve(root, 'dist', 'pack-index.json');
  let raw: Uint8Array;
  try {
    raw = await readFile(indexPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok([]);
    return packIndexFailure(root, 'asset-index-unreadable', {
      indexPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  try {
    const decoded = await decodeCatalogDocument(raw);
    return decoded.ok
      ? decoded
      : packIndexFailure(root, 'asset-index-invalid', {
          indexPath,
          code: decoded.error.code,
          detail: decoded.error.detail,
        });
  } catch (cause) {
    return packIndexFailure(root, 'asset-index-invalid', {
      indexPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function packGateway(
  facts: Extract<Awaited<ReturnType<typeof readProjectFacts>>, { readonly ok: true }>['value'],
  inventory?: NonNullable<Parameters<typeof createFileSystemPackAuthoringGateway>[0]['inventory']>,
  inspectCatalogSubjects = false,
) {
  const catalog = await readProjectCatalog(facts.root);
  if (!catalog.ok) return catalog;
  return {
    ok: true as const,
    value: createFileSystemPackAuthoringGateway({
      gameRoot: facts.root,
      scanRoots: facts.assetRoots,
      inspectCatalogSubjects,
      catalog: () => catalog.value,
      ...(inventory === undefined ? {} : { inventory }),
    }),
  };
}

function describeDetail(detail: unknown): string[] {
  if (!isRecord(detail)) return [];
  const facts = Object.entries(detail)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value)}`);
  const nested = describeDetail(detail.cause ?? detail.causeDetail);
  return [...facts, ...nested];
}

function messageOf(cause: unknown): string {
  if (isRecord(cause)) {
    const parts = [cause.code, cause.expected, cause.hint, cause.message].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    const facts = describeDetail(cause.detail ?? cause.cause);
    if (parts.length > 0 || facts.length > 0)
      return [...new Set(parts), ...(facts.length > 0 ? [`(${facts.join(', ')})`] : [])].join(': ');
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Dry-cook direct declarations from the same inventory used for reference verification. */
export async function checkProjectAssets(
  projectRoot: string,
  roots: readonly string[],
  inventory: ScanInventory,
) {
  const cookers = new Map<string, NativeCooker>(
    createDefaultCloudCookers().map((cooker) => [cooker.key, cooker]),
  );
  const factories = new Map<string, () => NativeCooker>([
    ['material', () => createMaterialPackCooker(roots)],
    ['texture-generator', () => createTextureGeneratorPackCooker(roots)],
    ['particle-effect', () => createParticleCodeNativeCookerFromRoots(roots)],
  ]);
  const skipped: string[] = [];
  const failures: { pack: string; key: string; kind: string; message: string }[] = [];
  let checked = 0;
  for (const path of [...inventory.declarations.keys()].sort()) {
    if (!roots.some((root) => isFilesystemPathWithin(root, path))) continue;
    const declaration = inventory.declarations.get(path);
    const pack = relative(projectRoot, path);
    if (declaration?.format === 'pack.ts') skipped.push(pack);
    if (declaration?.format !== 'pack.json' || declaration.value.format !== 'direct') continue;
    for (const asset of projectDirectPackJson(declaration.value).assets) {
      try {
        let cooker = cookers.get(asset.kind);
        if (cooker === undefined) {
          cooker = factories.get(asset.kind)?.();
          if (cooker === undefined) continue;
          cookers.set(asset.kind, cooker);
        }
        await cooker.cook(directPackCookInput(asset, path));
        checked++;
      } catch (cause) {
        failures.push({ pack, key: asset.sourceKey, kind: asset.kind, message: messageOf(cause) });
      }
    }
  }
  return { checked, skipped, failures };
}

export async function checkProjectSources(facts: ProjectFacts) {
  try {
    const scanned = await scanProjectSources(facts, projectSourceRoots(facts));
    if (!scanned.ok) return rejectCommand(projectSourceFailure(scanned.error));
    const roots = facts.assetRoots.map((root) => resolve(facts.root, root));
    const { checked, skipped, failures } = await checkProjectAssets(
      facts.root,
      roots,
      scanned.value,
    );
    if (failures.length > 0)
      return rejectCommand({
        code: 'project-assets-invalid',
        expected: 'every authored material and particle-effect to cook offline',
        hint: 'Fix the listed assets (see detail.failures) and rerun project check; dev start would fail on the same rows.',
        detail: { checked, failures },
      });
    const gateway = await packGateway(facts, async () => ok(scanned.value));
    if (!gateway.ok) return gateway;
    const verified = await gateway.value.execute({
      operation: 'asset.verify',
      requestId: randomUUID(),
    });
    return verified.ok
      ? ok({ packSources: scanned.value.declarations.size, assets: { checked, skipped } })
      : ownerFailure(verified.error);
  } catch (cause) {
    return rejectCommand(projectSourceFailure(cause));
  }
}

async function packSourceList(options: ProjectCommandOptions) {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const { root, assetRoots } = facts.value;
  const roots = assetRoots.length === 0 ? [root] : assetRoots.map((path) => resolve(root, path));
  const failures: Parameters<NonNullable<ScanOptions['onSourceFailure']>>[] = [];
  const scanOptions = { scriptablePack: { metadataOnly: true } } as const;
  let scanned: ReturnType<typeof scanInventory> | undefined;
  const inventory = async (onSourceFailure?: ScanOptions['onSourceFailure']) => {
    scanned ??= scanInventory(roots, {
      ...scanOptions,
      onSourceFailure: (...failure) => failures.push(failure),
    });
    const result = await scanned;
    if (onSourceFailure) {
      for (const failure of failures) onSourceFailure(...failure);
    } else if (failures.length > 0) {
      return scanInventory(roots, scanOptions);
    }
    return result;
  };
  const gateway = await packGateway(facts.value, inventory);
  if (!gateway.ok) return gateway;
  const listing = await gateway.value.execute({ operation: 'asset.list', requestId: randomUUID() });
  if (!listing.ok) return listing;
  return {
    ok: true as const,
    value: { root, gateway: gateway.value, listing: listing.value },
  };
}

export async function assetListCommand(
  options: AssetListOptions = {},
): Promise<CommandResult<unknown>> {
  const limit = options.limit ?? ASSET_LIST_DEFAULT_LIMIT;
  const cursor = options.cursor === undefined ? 0 : Number(options.cursor);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ASSET_LIST_MAX_LIMIT ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  ) {
    return rejectCommand({
      code: 'cli-parse-error',
      expected: '--limit 1..256 and --cursor a non-negative integer',
      hint: 'Use a bounded limit and pass the returned nextCursor for the next page.',
      detail: { limit: options.limit ?? null, cursor: options.cursor ?? null },
    });
  }
  const source = await packSourceList(options);
  if (!source.ok) return ownerFailure(source.error);
  const listing = source.value.listing;
  const sources = listing.sources ?? [];
  const assets = (listing.assets ?? []).filter(
    (asset) => options.type === undefined || asset.kind === options.type,
  );
  const total = Math.max(assets.length, sources.length);
  const page = {
    cursor,
    limit,
    total,
    ...(cursor + limit < total ? { nextCursor: String(cursor + limit) } : {}),
  };
  const items = assets.slice(cursor, cursor + limit);
  return ok(
    sources.length === 0 && listing.diagnostics === undefined
      ? { items, page }
      : {
          ...listing,
          assets: items,
          sources: sources.slice(cursor, cursor + limit),
          page: { ...page, sourceTotal: sources.length },
        },
  );
}

export async function assetVerifyCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const source = await packSourceList(options);
  if (!source.ok) return ownerFailure(source.error);
  const { root, gateway, listing } = source.value;
  // A ready Catalog row alone does not prove its published bytes.
  if (listing.assets?.some((asset) => asset.status === 'ready') === true) {
    const verifiedDist = await verifyDist(resolve(root, 'dist'));
    if (!verifiedDist.ok) return verifiedDist;
  }
  const result = await gateway.execute({ operation: 'asset.verify', requestId: randomUUID() });
  return result.ok ? ok(result.value) : ownerFailure(result.error);
}

async function inspectCatalogAsset(options: AssetInspectOptions, catalog: string) {
  const project = resolve(options.root ?? process.cwd());
  const inspected = await inspectOfflineAsset({
    guid: options.subject,
    project,
    catalog: resolve(project, catalog),
  });
  if (inspected.ok) return { ok: true as const, value: inspected.value };
  const { code, expected, hint, detail } = inspected.error;
  return rejectCommand({ code, expected, hint, detail: isRecord(detail) ? detail : {} });
}

async function inspectAssetParameters(
  options: AssetInspectOptions,
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const gateway = createFileSystemPackAuthoringGateway({ gameRoot: facts.value.root });
  try {
    const inspected = await gateway.execute({
      operation: 'asset.inspect',
      requestId: randomUUID(),
      subject: options.subject,
      parametersOnly: true,
    });
    return inspected.ok ? { ok: true, value: inspected.value } : ownerFailure(inspected.error);
  } finally {
    gateway.dispose?.();
  }
}

export async function assetInspectCommand(
  options: AssetInspectOptions,
): Promise<CommandResult<unknown>> {
  if (options.catalog !== undefined) return inspectCatalogAsset(options, options.catalog);
  if (options.parametersOnly) return inspectAssetParameters(options);
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const gateway = await packGateway(facts.value, undefined, true);
  if (!gateway.ok) return gateway;
  const inspected = await gateway.value.execute({
    operation: 'asset.inspect',
    requestId: randomUUID(),
    subject: options.subject,
    ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey }),
  });
  return inspected.ok
    ? ok(inspected.value.catalogSubject ?? inspected.value)
    : ownerFailure(inspected.error);
}

/** CLI convenience adapter for the Pack-owned asset.resolve operation. */
export async function assetResolveCommand(
  options: AssetResolveOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const gateway = await packGateway(facts.value);
  if (!gateway.ok) return gateway;
  const result = await gateway.value.execute({
    operation: 'asset.resolve',
    requestId: options.requestId ?? randomUUID(),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...(options.packageId === undefined ? {} : { packageId: options.packageId }),
    ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey }),
    ...(options.require === undefined ? {} : { require: options.require }),
  });
  return result.ok ? { ok: true, value: result.value } : ownerFailure(result.error);
}
