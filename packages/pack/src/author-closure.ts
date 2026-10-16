import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { err } from '@forgeax/engine-types';
import ts from 'typescript';
import { AssetGuid, PackageId } from './guid.js';
import { type AnyScriptablePackDefinition, resolvePackParameterValues } from './pack-authoring.js';
import { declarationPackageId, type ScanSourceDeclaration, scanInventory } from './scanner.js';
import { loadScriptablePack } from './scriptable-pack-node.js';

export interface AuthorPackFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}
export interface AuthorPackClosure {
  readonly root: string;
  readonly sourcePath: string;
  readonly files: readonly AuthorPackFile[];
  readonly declarations: readonly ScanSourceDeclaration[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly identities: ReadonlyMap<
    string,
    { readonly packageId?: string; readonly sourceKey?: string }
  >;
  readonly manifestRevision: string;
}
function invalid(path: string, reason: string): never {
  throw {
    code: 'pack-source-mutation-unsupported',
    expected: 'a portable, statically declared author source closure',
    hint: 'declare literal module/resource edges and project dependencies before transferring this Pack',
    detail: { path, reason },
  };
}
export function authorFileDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
async function localFile(from: string, specifier: string): Promise<string> {
  const plain = specifier.split('?')[0] ?? specifier;
  const path = resolve(dirname(from), plain);
  const extension = extname(path);
  const alternatives = [
    path,
    ...(extension === '.js' ? [`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`] : []),
    ...(extension
      ? []
      : ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js'].map(
          (suffix) => path + suffix,
        )),
  ];
  for (const candidate of alternatives) {
    try {
      if ((await stat(candidate)).isFile()) return realpath(candidate);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  return invalid(from, `unresolved source edge ${specifier}`);
}

/** Pack identities select asset owners; literal imports and URLs select code and resource bytes. */
export async function collectAuthorPackClosure(
  projectRoot: string,
  sourcePath: string,
): Promise<AuthorPackClosure> {
  const root = await realpath(projectRoot);
  const entry = await realpath(resolve(root, sourcePath));
  if (!inside(root, entry) || !/\.pack\.(?:json|ts)$/.test(entry))
    invalid(sourcePath, 'expected a project-local Pack source');
  const scanned = await scanInventory([resolve(root, 'assets')]);
  if (!scanned.ok) throw scanned.error;
  const declarations = scanned.value.declarations;
  if (!declarations.has(entry))
    invalid(sourcePath, 'Pack source must be in the project assets tree');
  const identityOwners = new Map<string, string>();
  const identities = new Map<string, { packageId?: string; sourceKey?: string }>();
  const outputs = new Map<string, unknown>();
  const blocked = new Set<string>();
  const outputOrigins = new Map<string, string>();
  for (const row of scanned.value.inventory) {
    identityOwners.set(row.guid.toLowerCase(), row.sourcePath);
    const packageId = declarationPackageId(declarations.get(row.sourcePath));
    identities.set(row.guid.toLowerCase(), {
      ...(packageId ? { packageId } : {}),
      ...(row.sourceKey ? { sourceKey: row.sourceKey } : {}),
    });
  }
  for (const declaration of declarations.values()) {
    const namespace = declarationPackageId(declaration);
    if (namespace) identityOwners.set(namespace.toLowerCase(), declaration.sourcePath);
    // scanInventory's rows describe direct Packs. External resources own their
    // identities in Meta, before any importer or cooked catalog exists.
    if (declaration.format === 'meta.json')
      for (const asset of declaration.value.subAssets) {
        const guid = asset.guid.toLowerCase();
        identityOwners.set(guid, declaration.sourcePath);
        identities.set(guid, {
          ...(namespace ? { packageId: namespace } : {}),
          ...(asset.sourceKey ? { sourceKey: asset.sourceKey } : {}),
        });
      }
  }
  // Evaluate through the existing isolated Pack executor, never runtime plugin apply.
  // Output identity and computed reference edges must not depend on textual UUID guesses.
  async function evaluate(
    path: string,
    origin: string,
    definition: AnyScriptablePackDefinition,
    packageId = definition.packageId,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const reads: string[] = [];
    const context = {
      packageId,
      async readByGuid(guid: AssetGuid) {
        reads.push(AssetGuid.format(guid));
        blocked.add(path);
        return err({ code: 'author-transfer-read-blocked' });
      },
    };
    const result =
      'parameters' in definition
        ? await definition.build({
            ...context,
            values: resolvePackParameterValues(definition, overrides).unwrap(),
          })
        : await definition.build(context);
    if (!result.ok && !reads.length) throw result.error;
    outputs.set(path, result.ok ? result.value : reads);
    outputOrigins.set(path, origin);
    if (result.ok)
      for (const key of Object.keys(result.value)) {
        const guid = AssetGuid.format(AssetGuid.derive(packageId, key));
        identityOwners.set(guid, path);
        identities.set(guid, { packageId: PackageId.format(packageId), sourceKey: key });
      }
  }
  for (const declaration of declarations.values()) {
    if (declaration.format === 'pack.ts')
      await evaluate(declaration.sourcePath, declaration.sourcePath, declaration.definition);
  }
  for (const [sourcePath, instance] of scanned.value.instances) {
    await evaluate(
      sourcePath,
      instance.root.sourcePath,
      (await loadScriptablePack(instance.root.sourcePath)).unwrap(),
      instance.packageId,
      instance.values,
    );
  }
  const manifestBytes = await readFile(resolve(root, 'package.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies: Record<string, string> = {};
  const files = new Map<string, AuthorPackFile>();
  const pending = [entry];
  const selected = new Map<string, ScanSourceDeclaration>();
  const shaderOwners = new Map<string, string>();
  async function indexShaders(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.forgeax', 'dist', '.git'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await indexShaders(path);
      else if (entry.isFile() && path.endsWith('.wgsl')) {
        const source = await readFile(path, 'utf8');
        const name = /^\s*#define_import_path\s+([\w:.-]+)/m.exec(source)?.[1];
        if (!name) continue;
        if (shaderOwners.has(name)) invalid(path, `duplicate shader module ${name}`);
        shaderOwners.set(name, path);
      }
    }
  }
  await indexShaders(resolve(root, 'assets'));
  function shaderEdge(name: string): void {
    const owner = [...shaderOwners.keys()]
      .filter((module) => name === module || name.startsWith(`${module}::`))
      .sort((a, b) => b.length - a.length)[0];
    const path = owner === undefined ? undefined : shaderOwners.get(owner);
    if (path !== undefined) pending.push(path);
  }
  async function edge(from: string, specifier: string): Promise<void> {
    if (specifier.startsWith('.')) {
      pending.push(await localFile(from, specifier));
      return;
    }
    if (isBuiltin(specifier)) return;
    if (/^(?:data:|https?:)/.test(specifier))
      invalid(from, `external resource ${specifier} is not a portable source file`);
    if (isAbsolute(specifier) || specifier.includes('\\'))
      invalid(from, `absolute source edge ${specifier}`);
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    if (typeof version !== 'string') invalid(from, `declare ${name} in package.json`);
    dependencies[name] = version;
  }
  while (pending.length) {
    const next = pending.pop();
    if (next === undefined) break;
    const path = await realpath(next);
    if (files.has(path)) continue;
    if (
      !inside(root, path) ||
      relative(root, path)
        .split('/')
        .some((part) => ['node_modules', '.forgeax', 'dist', '.git'].includes(part))
    )
      invalid(path, 'source closure crosses a project/generated boundary');
    const bytes = await readFile(path);
    files.set(path, {
      path: relative(root, path).replaceAll('\\', '/'),
      bytes,
      digest: authorFileDigest(bytes),
    });
    // UiAuthoringProfile requires a same-basename CSS companion even when
    // HTML has no link element. Its own URLs are traversed by the CSS rule.
    if (path.endsWith('.ui.html'))
      pending.push(
        await localFile(
          path,
          `./${path.slice(dirname(path).length + 1).replace(/\.ui\.html$/, '.ui.css')}`,
        ),
      );
    if (!path.endsWith('.meta.json') && declarations.has(`${path}.meta.json`))
      pending.push(`${path}.meta.json`);
    const declaration = declarations.get(path);
    if (declaration) {
      selected.set(path, declaration);
      if (declaration.format === 'pack.ts')
        pending.push(...declaration.sourceClosure.map((file) => file.path));
      if (outputs.has(path)) {
        if (blocked.has(path))
          invalid(
            path,
            'source closure requires cooked reads; make the transferable Pack source-discoverable',
          );
        const origin = outputOrigins.get(path) ?? path;
        if (origin !== path) pending.push(origin);
        async function refs(value: unknown, key = ''): Promise<void> {
          if (value instanceof Uint8Array && value.length === 16) {
            const owner = identityOwners.get(AssetGuid.format(value as AssetGuid));
            if (owner) pending.push(owner);
          } else if (typeof value === 'string') {
            shaderEdge(value);
            const owner = identityOwners.get(value.toLowerCase());
            if (owner) pending.push(owner);
            else if (key === '$asset') invalid(path, `missing referenced asset ${value}`);
            if (['specifier', 'executor'].includes(key)) await edge(origin, value);
          } else if (Array.isArray(value)) {
            for (const item of value) await refs(item);
          } else if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
            for (const [key, item] of Object.entries(value)) await refs(item, key);
          }
        }
        await refs(outputs.get(path));
      }
      if (declaration.format === 'meta.json')
        pending.push(
          await localFile(
            path,
            './' +
              (declaration.value.source ??
                path.slice(dirname(path).length + 1, -'.meta.json'.length)),
          ),
        );
    }
    const isCode = /\.[cm]?[jt]sx?$/.test(path);
    if (!isCode && !/\.(?:json|gltf|css|html|wgsl)$/.test(path)) continue;
    const source = bytes.toString('utf8');
    if (path.endsWith('.wgsl'))
      for (const match of source.matchAll(/^\s*#import\s+([\w:.-]+)/gm))
        if (match[1]) shaderEdge(match[1]);
    const strings: string[] = [];
    const edges: string[] = [];
    if (isCode) {
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      for (const imported of ts.preProcessFile(source, true, true).importedFiles)
        edges.push(imported.fileName);
      function visit(node: ts.Node): void {
        if (ts.isStringLiteralLike(node)) strings.push(node.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          (node.arguments[0] === undefined || !ts.isStringLiteralLike(node.arguments[0]))
        )
          invalid(path, 'dynamic module imports require literal specifiers');
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'URL' &&
          node.arguments?.[1]?.getText(ast) === 'import.meta.url'
        ) {
          const value = node.arguments?.[0];
          if (!value || !ts.isStringLiteralLike(value))
            invalid(path, 'resource URLs require literal specifiers');
          if (value.text.startsWith('.')) edges.push(value.text);
        }
        if (
          ts.isPropertyAssignment(node) &&
          ['specifier', 'executor'].includes(node.name.getText(ast).replace(/['"]/g, '')) &&
          ts.isStringLiteralLike(node.initializer)
        )
          edges.push(node.initializer.text);
        ts.forEachChild(node, visit);
      }
      visit(ast);
    } else if (/\.(?:json|gltf)$/.test(path)) {
      function visit(value: unknown, key = ''): void {
        if (typeof value === 'string') {
          strings.push(value);
          if (key === '$asset' && !identityOwners.has(value.toLowerCase()))
            invalid(path, `missing referenced asset ${value}`);
          if (['specifier', 'executor', 'uri'].includes(key) && !value.startsWith('data:'))
            edges.push(value.startsWith('.') || key !== 'uri' ? value : `./${value}`);
        } else if (Array.isArray(value))
          value.forEach((item) => {
            visit(item);
          });
        else if (value && typeof value === 'object')
          for (const [key, item] of Object.entries(value)) visit(item, key);
      }
      visit(JSON.parse(source));
    } else {
      const patterns = path.endsWith('.css')
        ? [/(?:url\(\s*['"]?)([^'"\s)]+)/g, /@import\s+['"]([^'"]+)['"]/g]
        : path.endsWith('.html')
          ? [/(?:src|href)\s*=\s*['"]([^'"]+)['"]/g]
          : [/#import\s+['"]([^'"]+)['"]/g];
      for (const pattern of patterns)
        for (const match of source.matchAll(pattern)) {
          const value = match[1];
          if (!value || value.startsWith('data:') || value.startsWith('#')) continue;
          if (value.startsWith('/') || /^[a-z]+:/i.test(value))
            invalid(path, `nonportable resource ${value}`);
          edges.push(value.startsWith('.') ? value : `./${value}`);
        }
    }
    for (const text of strings) {
      shaderEdge(text);
      const owner = identityOwners.get(text.toLowerCase());
      if (owner) pending.push(owner);
    }
    for (const specifier of new Set(edges)) await edge(path, specifier);
  }
  return {
    root,
    sourcePath: relative(root, entry).replaceAll('\\', '/'),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    declarations: [...selected.values()],
    dependencies,
    identities: new Map(
      [...identities].filter(([guid]) => selected.has(identityOwners.get(guid) ?? '')),
    ),
    manifestRevision: authorFileDigest(manifestBytes),
  };
}

export async function assertAuthorPackUnchanged(closure: AuthorPackClosure): Promise<void> {
  if (
    authorFileDigest(await readFile(resolve(closure.root, 'package.json'))) !==
    closure.manifestRevision
  )
    invalid(closure.root, 'source dependency declarations changed during transfer');
  for (const file of closure.files)
    if (authorFileDigest(await readFile(resolve(closure.root, file.path))) !== file.digest)
      invalid(file.path, 'source changed during transfer');
}
