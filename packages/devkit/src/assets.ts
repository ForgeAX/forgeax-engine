import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { runCliFbx } from '@forgeax/engine-fbx/cli-fbx';
import { bakeFont } from '@forgeax/engine-font/cli-font';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { importMeshFile } from '@forgeax/engine-mesh-io';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import {
  createFileSystemPackAuthoringGateway,
  type PackAuthoringMaterializedAsset,
} from '@forgeax/engine-pack/build';
import { createAssetVerificationReport, scanEntries } from '@forgeax/engine-pack/cli-asset';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { isValidAssetGuidString, readCatalogRows } from '@forgeax/engine-types';
import { verifyDist } from './dist.js';
import { commandError, readProjectFacts } from './project.js';
import type {
  AssetAddOptions,
  AssetInspectOptions,
  AssetListOptions,
  AssetResolveOptions,
  CommandError,
  CommandResult,
  ProjectCommandOptions,
} from './types.js';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.hdr']);
const meshExtensions = new Set(['.obj', '.stl', '.svg']);
const gltfExtensions = new Set(['.gltf', '.glb']);
const fbxExtensions = new Set(['.fbx']);
const fontExtensions = new Set(['.ttf', '.otf']);
const ASSET_LIST_DEFAULT_LIMIT = 100;
const ASSET_LIST_MAX_LIMIT = 256;

function failure(error: CommandError): CommandResult<never> {
  return { ok: false, error };
}

/** Owner failures cross the command boundary as the CommandError fields only (e.g. Pack `actual` stays behind). */
function ownerFailure({ code, expected, hint, detail }: CommandError): CommandResult<never> {
  return failure({ code, expected, hint, detail });
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

async function addImage(sourcePath: string, dryRun: boolean): Promise<CommandResult<unknown>> {
  const metaPath = `${sourcePath}.meta.json`;
  const source = basename(sourcePath);
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure({
        code: 'asset-meta-unreadable',
        expected: 'an absent or readable JSON sidecar',
        hint: 'Repair the existing sidecar before adding the source again.',
        detail: { source: sourcePath, metaPath },
      });
    }
  }
  if (existing !== undefined) {
    const value = existing as {
      importer?: unknown;
      source?: unknown;
      subAssets?: readonly { guid?: unknown; kind?: unknown }[];
    };
    const row = value.subAssets?.[0];
    if (
      value.importer !== 'image' ||
      value.source !== source ||
      value.subAssets?.length !== 1 ||
      typeof row?.guid !== 'string' ||
      row.kind !== 'texture'
    ) {
      return failure({
        code: 'asset-meta-conflict',
        expected: 'the existing sidecar to describe this image source and one texture identity',
        hint: 'Resolve the sidecar conflict explicitly; DevKit will not replace authored identity.',
        detail: { source: sourcePath, metaPath },
      });
    }
    return { ok: true, value: { source: sourcePath, metaPath, guid: row.guid, reused: true } };
  }
  const guid = AssetGuid.format(AssetGuid.random());
  const linear = extname(sourcePath).toLowerCase() === '.hdr';
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source,
    importSettings: {
      colorSpace: linear ? 'linear' : 'srgb',
      mipmap: true,
      addressMode: 'repeat',
      filterMode: 'linear',
    },
    subAssets: [{ guid, sourceIndex: 0, kind: 'texture', sourceKey: 'texture' }],
  } as const;
  if (!dryRun) await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  return { ok: true, value: { source: sourcePath, metaPath, guid, reused: false, dryRun } };
}

async function addModel(
  sourcePath: string,
  dryRun: boolean,
  format: 'glTF' | 'FBX',
): Promise<CommandResult<unknown>> {
  if (dryRun) {
    const exists = await stat(`${sourcePath}.meta.json`)
      .then(() => true)
      .catch(() => false);
    return {
      ok: true,
      value: {
        source: sourcePath,
        metaPath: `${sourcePath}.meta.json`,
        reused: exists,
        dryRun: true,
      },
    };
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
      return failure(JSON.parse(stderr.at(-1) ?? '') as CommandError);
    } catch {
      return failure({
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
    const existing = await Promise.all([
      stat(atlasPath)
        .then(() => true)
        .catch(() => false),
      stat(metaPath)
        .then(() => true)
        .catch(() => false),
    ]);
    return {
      ok: true,
      value: {
        source: sourcePath,
        atlasPath,
        metaPath,
        reused: existing.every(Boolean),
        dryRun: true,
      },
    };
  }
  try {
    await bakeFont(sourcePath, output);
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause) {
      const candidate = cause as Partial<CommandError>;
      if (typeof candidate.code === 'string') return failure(candidate as CommandError);
    }
    return failure({
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
    const supported = sources.filter((source) => {
      const extension = extname(source).toLowerCase();
      return (
        meshExtensions.has(extension) ||
        imageExtensions.has(extension) ||
        gltfExtensions.has(extension) ||
        fbxExtensions.has(extension) ||
        fontExtensions.has(extension)
      );
    });
    if (supported.length === 0) {
      return failure({
        code: 'source-package-importer-missing',
        expected:
          'a .png, .jpg, .jpeg, .hdr, .gltf, .glb, .fbx, .obj, .stl, .svg, .ttf, or .otf source',
        hint: 'Use a supported built-in importer or add an explicit producer before adding this source.',
        detail: { target },
      });
    }
    const assets: unknown[] = [];
    for (const source of supported) {
      const result = meshExtensions.has(extname(source).toLowerCase())
        ? await importMeshFile(source, options.dryRun === true)
        : imageExtensions.has(extname(source).toLowerCase())
          ? await addImage(source, options.dryRun === true)
          : gltfExtensions.has(extname(source).toLowerCase())
            ? await addModel(source, options.dryRun === true, 'glTF')
            : fbxExtensions.has(extname(source).toLowerCase())
              ? await addModel(source, options.dryRun === true, 'FBX')
              : await addFont(source, options.dryRun === true);
      if (!result.ok)
        return failure({
          code: result.error.code,
          expected: result.error.expected,
          hint: result.error.hint,
          detail: result.error.detail ?? {},
        });
      assets.push(result.value);
    }
    return { ok: true, value: { root: facts.value.root, assets, dryRun: options.dryRun === true } };
  } catch (cause) {
    return failure(commandError(cause, 'asset-add-failed'));
  }
}

async function entries(options: ProjectCommandOptions) {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await scanEntries(
    facts.value.assetRoots.map((root) => resolve(facts.value.root, root)),
    { stdoutWrite: (line) => stdout.push(line), stderrWrite: (line) => stderr.push(line) },
  );
  if (!result.ok) {
    try {
      return failure(JSON.parse(stderr.at(-1) ?? '') as CommandError);
    } catch {
      return failure({
        code: 'asset-authority-invalid',
        expected: 'all asset roots and sidecars to pass the pack scanner',
        hint: 'Repair the first invalid asset authority reported by the scanner.',
        detail: { diagnostic: stderr.join('\n') },
      });
    }
  }
  return {
    ok: true as const,
    value: {
      facts: facts.value,
      entries: result.value,
      declarations: result.declarations,
    },
  };
}

interface PackIndexRow {
  readonly guid?: unknown;
  readonly kind?: unknown;
  readonly sourcePath?: unknown;
  readonly packageId?: unknown;
  readonly sourceKey?: unknown;
  readonly refs?: unknown;
  readonly lifecycle?: unknown;
  readonly publication?: unknown;
  readonly subject?: unknown;
  readonly provenance?: unknown;
}

interface PackIndexProjection {
  readonly materialized: readonly PackAuthoringMaterializedAsset[];
  readonly knownGuids: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function packIndexFailure(
  root: string,
  code: 'asset-index-invalid' | 'asset-index-unreadable',
  detail: Record<string, unknown>,
): CommandResult<never> {
  return failure({
    code,
    expected: 'dist/pack-index.json to contain readable published asset rows',
    hint:
      code === 'asset-index-unreadable'
        ? 'Rebuild the project to regenerate dist/pack-index.json, then retry.'
        : 'Repair the generated Pack index or rebuild the project before querying assets.',
    detail: { root, ...detail },
  });
}

async function readPackIndexMaterialized(
  root: string,
): Promise<CommandResult<PackIndexProjection>> {
  const indexPath = resolve(root, 'dist', 'pack-index.json');
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: { materialized: [], knownGuids: [] } };
    }
    return packIndexFailure(root, 'asset-index-unreadable', {
      indexPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  let parsed: unknown;
  try {
    const decoded = decodeCatalogWire(JSON.parse(raw));
    if (!decoded.ok) {
      return packIndexFailure(root, 'asset-index-invalid', {
        indexPath,
        code: decoded.error.code,
        detail: decoded.error.detail,
      });
    }
    parsed = decoded.value;
  } catch (cause) {
    return packIndexFailure(root, 'asset-index-invalid', {
      indexPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const catalogRows = readCatalogRows(parsed);
  if (catalogRows === undefined) {
    return packIndexFailure(root, 'asset-index-invalid', { indexPath, actual: typeof parsed });
  }
  const rows: PackAuthoringMaterializedAsset[] = [];
  const knownGuids = new Set<string>();
  for (const [index, candidate] of catalogRows.entries()) {
    if (!isRecord(candidate)) {
      return packIndexFailure(root, 'asset-index-invalid', {
        indexPath,
        row: String(index),
        reason: 'row must be an object',
      });
    }
    const row = candidate as PackIndexRow;
    const publication = isRecord(row.publication) ? row.publication : undefined;
    const current =
      publication !== undefined && isRecord(publication.current) ? publication.current : undefined;
    const published =
      current !== undefined &&
      typeof current.packageUrl === 'string' &&
      current.packageUrl.length > 0;
    if (
      typeof row.guid === 'string' &&
      isValidAssetGuidString(row.guid) &&
      typeof row.kind === 'string' &&
      row.kind.length > 0 &&
      row.lifecycle === 'current' &&
      published
    ) {
      knownGuids.add(row.guid.toLowerCase());
    }
    // Catalog rows without the Pack identity pair belong to other importers or
    // legacy sources and remain visible through the scanner projection.
    if (typeof row.packageId !== 'string' || typeof row.sourceKey !== 'string') continue;
    const provenance = isRecord(row.provenance) ? row.provenance : undefined;
    const provider = provenance?.provider;
    if (row.subject !== 'internal-asset' && provider !== 'pack-ts' && provider !== 'pack') continue;
    if (typeof row.guid !== 'string' || typeof row.kind !== 'string') {
      return packIndexFailure(root, 'asset-index-invalid', {
        indexPath,
        row: String(index),
        reason: 'Pack rows require guid and kind',
      });
    }
    rows.push({
      packageId: row.packageId,
      sourceKey: row.sourceKey,
      guid: row.guid,
      kind: row.kind,
      ...(typeof row.sourcePath === 'string' ? { sourcePath: row.sourcePath } : {}),
      ...(Array.isArray(row.refs) ? { refs: row.refs as readonly string[] } : {}),
      ready: row.lifecycle === 'current' && published,
      artifactsReady: row.lifecycle === 'current' && published,
    });
  }
  return { ok: true, value: { materialized: rows, knownGuids: [...knownGuids] } };
}

async function packGateway(
  facts: Extract<Awaited<ReturnType<typeof readProjectFacts>>, { readonly ok: true }>['value'],
) {
  const materialized = await readPackIndexMaterialized(facts.root);
  if (!materialized.ok) return materialized;
  return {
    ok: true as const,
    value: createFileSystemPackAuthoringGateway({
      gameRoot: facts.root,
      scanRoots: facts.assetRoots,
      materialized: () => materialized.value.materialized,
      additionalKnownGuids: () => materialized.value.knownGuids,
    }),
  };
}

async function packSourceList(options: ProjectCommandOptions) {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const gateway = await packGateway(facts.value);
  if (!gateway.ok) return gateway;
  const listing = await gateway.value.execute({ operation: 'asset.list', requestId: randomUUID() });
  if (!listing.ok) return listing;
  return {
    ok: true as const,
    value: { root: facts.value.root, gateway: gateway.value, listing: listing.value },
  };
}

export async function assetListCommand(
  options: AssetListOptions = {},
): Promise<CommandResult<unknown>> {
  const packSource = await packSourceList(options);
  if (!packSource.ok) {
    return ownerFailure(packSource.error);
  }
  const listing = packSource.value.listing;
  const paginate = <T>(items: readonly T[]) => {
    const limit = options.limit ?? ASSET_LIST_DEFAULT_LIMIT;
    const cursor = options.cursor === undefined ? 0 : Number(options.cursor);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ASSET_LIST_MAX_LIMIT ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      return failure({
        code: 'cli-parse-error',
        expected: '--limit 1..256 and --cursor a non-negative integer',
        hint: 'Use a bounded limit and pass the returned nextCursor for the next page.',
        detail: { limit: options.limit ?? null, cursor: options.cursor ?? null },
      });
    }
    const page = items.slice(cursor, cursor + limit);
    return {
      ok: true as const,
      value: {
        items: page,
        page: {
          cursor,
          limit,
          ...(cursor + page.length < items.length
            ? { nextCursor: String(cursor + page.length) }
            : {}),
          total: items.length,
        },
      },
    };
  };
  const sources = listing.sources ?? [];
  if (sources.length > 0) {
    const assets = (listing.assets ?? []).filter(
      (asset) => options.type === undefined || asset.kind === options.type,
    );
    const page = paginate(assets);
    if (!page.ok) return page;
    const cursor = page.value.page.cursor;
    const limit = page.value.page.limit;
    const sourcePage = sources.slice(cursor, cursor + limit);
    // Pack exposes two projections through one response. Keep their cursor
    // shared, but size the window by the longer projection so source-only
    // Pack files remain discoverable after the published output list ends.
    const total = Math.max(assets.length, sources.length);
    const nextCursor =
      cursor + Math.max(page.value.items.length, sourcePage.length) < total
        ? String(cursor + limit)
        : undefined;
    return {
      ok: true,
      value: {
        ...listing,
        assets: page.value.items,
        sources: sourcePage,
        page: {
          ...page.value.page,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          total,
          sourceTotal: sources.length,
        },
      },
    };
  }
  const result = await entries(options);
  if (!result.ok) return result;
  const filtered = result.value.entries.filter(
    (entry) => options.type === undefined || entry.kind === options.type,
  );
  const page = paginate(filtered);
  if (!page.ok) return page;
  return { ok: true, value: page.value };
}

export async function assetVerifyCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const packSource = await packSourceList(options);
  if (!packSource.ok) {
    return ownerFailure(packSource.error);
  }
  const { root, gateway, listing } = packSource.value;
  if ((listing.sources?.length ?? 0) > 0) {
    // A published Pack row is only an identity projection. Verify the one
    // immutable dist closure before reporting its bytes as available. Keep
    // source-only projects cheap: without a ready output there is no closure
    // to admit and the gateway reports the honest unproduced state.
    if (listing.assets?.some((asset) => asset.status === 'ready') === true) {
      const verifiedDist = await verifyDist(resolve(root, 'dist'));
      if (!verifiedDist.ok) return verifiedDist;
    }
    const verified = await gateway.execute({
      operation: 'asset.verify',
      requestId: randomUUID(),
    });
    return verified.ok ? { ok: true, value: verified.value } : ownerFailure(verified.error);
  }
  const result = await entries(options);
  if (!result.ok) return result;
  return {
    ok: true,
    value: createAssetVerificationReport(result.value.facts.root, {
      value: result.value.entries,
      declarations: result.value.declarations,
    }),
  };
}

export async function assetInspectCommand(
  options: AssetInspectOptions,
): Promise<CommandResult<unknown>> {
  if (options.parametersOnly) {
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
  const packSource = await packSourceList(options);
  if (!packSource.ok) {
    return ownerFailure(packSource.error);
  }
  const { gateway, listing } = packSource.value;
  if ((listing.sources?.length ?? 0) > 0 || options.sourceKey !== undefined) {
    if (isValidAssetGuidString(options.subject)) {
      const resolved = await gateway.execute({
        operation: 'asset.resolve',
        requestId: randomUUID(),
        subject: options.subject,
      });
      if (resolved.ok) {
        return { ok: true, value: { ...resolved.value, operation: 'asset.inspect' } };
      }
    }
    const inspected = await gateway.execute({
      operation: 'asset.inspect',
      requestId: randomUUID(),
      subject: options.subject,
      ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey }),
    });
    if (inspected.ok) return { ok: true, value: inspected.value };
    if (
      options.sourceKey !== undefined ||
      (inspected.error.code !== 'pack-source-not-found' &&
        inspected.error.code !== 'pack-source-path-invalid')
    ) {
      return ownerFailure(inspected.error);
    }
  }
  const result = await entries(options);
  if (!result.ok) return result;
  const subject = options.subject.toLowerCase();
  const matches = result.value.entries.filter(
    (entry) => entry.guid.toLowerCase() === subject || entry.name?.toLowerCase() === subject,
  );
  if (matches.length !== 1) {
    return failure({
      code: matches.length === 0 ? 'asset-not-found' : 'asset-subject-ambiguous',
      expected: 'the GUID or name to resolve to exactly one asset',
      hint:
        matches.length === 0
          ? 'Run asset list and choose a known subject.'
          : 'Use the stable GUID.',
      detail: { subject: options.subject, matches },
    });
  }
  return { ok: true, value: matches[0] };
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
