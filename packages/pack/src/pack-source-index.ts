import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PackageId } from './guid.js';
import { parsePackSourceJson } from './pack-authoring.js';
import { declaredPackAssets, SCANNER_BLACKLIST, scanInventory } from './scanner.js';

export interface PackSourceIndexRow {
  readonly sourcePath: string;
  readonly revision?: string;
  readonly format: 'pack.json' | 'pack.ts';
  readonly packageId?: string;
  readonly outputs: readonly { guid: string; kind: string; sourceKey?: string }[];
  readonly diagnostic?: { code: string; hint: string };
}

/** Bounded, partial source inventory. Scriptable Pack metadata is never executed by this read. */
export async function listPackSources(
  projectRoot: string,
  limit = 200,
  assetRoots?: readonly string[],
): Promise<{
  sources: readonly PackSourceIndexRow[];
  hasMore: boolean;
}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Pack source limit must be 1..200');
  const root = await realpath(projectRoot);
  const paths: string[] = [];
  let visited = 0;
  let hasMore = false;
  const visitedDirectories = new Set<string>();
  async function visit(dir: string): Promise<void> {
    if (hasMore || visitedDirectories.has(dir)) return;
    visitedDirectories.add(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 10_000 || paths.length > limit) {
        hasMore = true;
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCANNER_BLACKLIST.has(entry.name)) await visit(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.pack.json') || entry.name.endsWith('.pack.ts'))
      ) {
        paths.push(path);
      }
    }
  }
  for (const directory of assetRoots ?? ['']) {
    const path = resolve(root, directory);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new RangeError('Pack source directories must stay inside the project');
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry?.isDirectory() && (await realpath(path)) === path) await visit(path);
  }
  hasMore ||= paths.length > limit;
  const selected = paths.slice(0, limit);
  const sources: PackSourceIndexRow[] = [];
  for (const path of selected) {
    const canonical = await realpath(path).catch(() => undefined);
    const sourcePath = relative(root, path).split(sep).join('/');
    const format = basename(path).endsWith('.pack.ts') ? 'pack.ts' : 'pack.json';
    if (!canonical || canonical !== path) {
      sources.push({
        sourcePath,
        format,
        outputs: [],
        diagnostic: { code: 'pack-source-changed', hint: 'Source changed during enumeration.' },
      });
      continue;
    }
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes || bytes.byteLength > 1024 * 1024) {
      sources.push({
        sourcePath,
        format,
        outputs: [],
        diagnostic: {
          code: 'pack-source-unreadable',
          hint: 'Source cannot be read within the 1 MiB limit.',
        },
      });
      continue;
    }
    const revision = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (format === 'pack.ts') {
      sources.push({
        sourcePath,
        revision,
        format,
        outputs: [],
        diagnostic: {
          code: 'pack-source-unmaterialized',
          hint: 'Scriptable Pack metadata is resolved by an explicit Pack inspect.',
        },
      });
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      sources.push({
        sourcePath,
        revision,
        format,
        outputs: [],
        diagnostic: { code: 'pack-malformed-pack', hint: 'Pack source is not valid JSON.' },
      });
      continue;
    }
    if (
      document &&
      typeof document === 'object' &&
      (document as { schemaVersion?: unknown }).schemaVersion === '3.0.0'
    ) {
      const parsed = parsePackSourceJson(document);
      if (!parsed.ok) {
        sources.push({
          sourcePath,
          revision,
          format,
          outputs: [],
          diagnostic: { code: parsed.error.code, hint: parsed.error.hint },
        });
        continue;
      }
      sources.push({
        sourcePath,
        revision,
        format,
        packageId: PackageId.format(parsed.value.packageId),
        outputs: declaredPackAssets(parsed.value)
          .slice(0, 50)
          .map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            ...(asset.sourceKey ? { sourceKey: asset.sourceKey } : {}),
          })),
      });
      continue;
    }
    const scanned = await scanInventory([path]);
    if (!scanned.ok) {
      sources.push({
        sourcePath,
        revision,
        format,
        outputs: [],
        diagnostic: { code: scanned.error.code, hint: scanned.error.message },
      });
      continue;
    }
    const declaration = scanned.value.declarations.get(path);
    if (declaration?.format !== 'pack.json') {
      sources.push({
        sourcePath,
        revision,
        format,
        outputs: [],
        diagnostic: { code: 'pack-source-unresolved', hint: 'Pack declaration was not resolved.' },
      });
      continue;
    }
    const packageId =
      typeof declaration.value.packageId === 'string'
        ? declaration.value.packageId
        : declaration.value.packageId
          ? PackageId.format(declaration.value.packageId)
          : undefined;
    sources.push({
      sourcePath,
      revision,
      format,
      ...(packageId ? { packageId } : {}),
      outputs: declaredPackAssets(declaration.value)
        .slice(0, 50)
        .map((asset) => ({
          guid: asset.guid,
          kind: asset.kind,
          ...(asset.sourceKey ? { sourceKey: asset.sourceKey } : {}),
        })),
    });
  }
  return { sources, hasMore };
}
