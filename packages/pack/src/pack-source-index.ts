import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PackageId } from './guid.js';
import {
  type PackParameterDefinition,
  type PackParameterInheritanceSubject,
  type ParsedPackJson,
  parsePackSourceJson,
  resolvePackParameterInheritance,
} from './pack-authoring.js';
import { packSourceFailure, readPackAuthoringDeclaration } from './pack-authoring-literals.js';
import { declaredPackAssets, enumeratePackSourcePaths } from './scanner.js';

export interface PackSourceIndexRow {
  readonly sourcePath: string;
  readonly revision?: string;
  readonly format: 'pack.json' | 'pack.ts';
  readonly packageId?: string;
  readonly outputs: readonly { guid: string; kind: string; sourceKey?: string }[];
  readonly diagnostic?: { code: string; hint: string };
}

/** Bounded source listing with an optional static reader of the same captured bytes. */
export async function listPackSources(
  projectRoot: string,
  limit = 200,
  assetRoots?: readonly string[],
  visit?: (sourcePath: string, source: string, declaration?: ParsedPackJson) => void,
): Promise<{
  sources: readonly PackSourceIndexRow[];
  hasMore: boolean;
}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Pack source limit must be 1..200');
  const root = await realpath(projectRoot);
  const directories: string[] = [];
  for (const directory of assetRoots ?? ['']) {
    const path = resolve(root, directory);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new RangeError('Pack source directories must stay inside the project');
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry?.isDirectory() && (await realpath(path)) === path) directories.push(path);
  }
  const { paths, hasMore } = await enumeratePackSourcePaths(directories, { sourceLimit: limit });
  const selected = paths.slice(0, limit);
  const sources: PackSourceIndexRow[] = [];
  for (const path of selected) {
    const canonical = await realpath(path).catch(() => undefined);
    const sourcePath = relative(root, path).split(sep).join('/');
    const format = path.endsWith('.pack.ts') ? 'pack.ts' : 'pack.json';
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
      visit?.(sourcePath, bytes.toString('utf8'));
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
    const source = bytes.toString('utf8');
    let document: unknown;
    try {
      document = JSON.parse(source);
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
    const parsed = parsePackSourceJson(document);
    if (parsed.ok) {
      visit?.(sourcePath, source, parsed.value);
      sources.push(sourceIndexRow(sourcePath, revision, parsed.value));
    } else {
      sources.push({
        sourcePath,
        revision,
        format,
        outputs: [],
        diagnostic: { code: parsed.error.code, hint: parsed.error.hint },
      });
    }
  }
  return { sources, hasMore };
}

function sourceIndexRow(
  sourcePath: string,
  revision: string,
  declaration: ParsedPackJson,
): PackSourceIndexRow {
  return {
    sourcePath,
    revision,
    format: 'pack.json',
    packageId: PackageId.format(declaration.packageId),
    outputs: declaredPackAssets(declaration)
      .slice(0, 50)
      .map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        sourceKey: asset.sourceKey,
      })),
  };
}

/** Resolve the static parent using the indexed source bytes. */
export async function readPackAuthoringParent(
  root: string,
  parent: string,
  sourceRoots?: readonly string[],
): Promise<{
  readonly parameters: readonly PackParameterDefinition[];
  readonly sourcePath: string;
  readonly source: string;
  readonly paths: readonly string[];
}> {
  const sources = new Map<
    string,
    {
      sourcePath: string;
      source: string;
      subject: PackParameterInheritanceSubject;
    }
  >();
  const inventory = await listPackSources(
    root,
    200,
    sourceRoots,
    (sourcePath, source, declaration) => {
      let subject: PackParameterInheritanceSubject;
      if (declaration) subject = declaration;
      else {
        const parsed = readPackAuthoringDeclaration(sourcePath, source);
        if (!parsed.ok) return;
        const identity = PackageId.parse(parsed.value.packageId);
        if (!identity.ok) throw identity.error;
        subject = {
          format: 'source',
          packageId: identity.value,
          parameters: parsed.value.parameters,
        };
      }
      const key = PackageId.format(subject.packageId);
      if (sources.has(key))
        throw packSourceFailure(sourcePath, 'duplicate parent package identity');
      sources.set(key, { sourcePath, source, subject });
    },
  );
  if (inventory.hasMore)
    throw packSourceFailure(
      parent,
      'static parent inventory is incomplete; use the existing instance authoring entry',
    );
  const paths: string[] = [];
  const read = (id: PackageId): PackParameterInheritanceSubject | undefined => {
    const source = sources.get(PackageId.format(id));
    if (source === undefined) return undefined;
    paths.push(source.sourcePath);
    return source.subject;
  };
  const identity = PackageId.parse(parent);
  const subject = identity.ok ? read(identity.value) : undefined;
  if (subject === undefined)
    throw packSourceFailure(parent, 'parent has no static authoring declaration');
  const inherited = (await resolvePackParameterInheritance(subject, read)).unwrap();
  const rootSource = sources.get(PackageId.format(inherited.rootPackageId));
  if (rootSource === undefined) throw packSourceFailure(parent, 'parent source was retired');
  const parameters = inherited.parameters.map((parameter) => ({
    ...parameter,
    default: inherited.values[parameter.name] ?? parameter.default,
  }));
  return { sourcePath: rootSource.sourcePath, source: rootSource.source, parameters, paths };
}
