import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { err } from '@forgeax/engine-types';
import ts from 'typescript';
import { AssetGuid, PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  type PackParameterValue,
  resolvePackParameterValues,
} from './pack-authoring.js';
import { executePackBuild } from './pack-parameter-bindings.js';
import { declarationPackageId, type ScanSourceDeclaration, scanInventory } from './scanner.js';
import { type LoadScriptablePackOptions, loadScriptablePack } from './scriptable-pack-node.js';
import { relativeScriptableImportCandidates } from './scriptable-pack-relative-import.js';
import { createScriptablePackSourceSnapshot } from './scriptable-pack-source-snapshot.js';

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
  const alternatives = relativeScriptableImportCandidates(from, plain);
  for (const candidate of alternatives) {
    try {
      if ((await stat(candidate)).isFile()) return realpath(candidate);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause;
    }
  }
  return invalid(from, `unresolved source edge ${specifier}`);
}

/** Pack identities select asset owners; literal imports and URLs select code and resource bytes. */
export async function collectAuthorPackClosure(
  projectRoot: string,
  sourcePath: string,
  assetRoots: readonly string[],
  options?: Pick<LoadScriptablePackOptions, 'packageBinding'>,
): Promise<AuthorPackClosure> {
  const root = await realpath(projectRoot);
  const entry = await realpath(resolve(root, sourcePath));
  if (!inside(root, entry) || !/\.pack\.(?:json|ts)$/.test(entry))
    invalid(sourcePath, 'expected a project-local Pack source');
  const snapshot = createScriptablePackSourceSnapshot();
  const scanned = await scanInventory(
    assetRoots.map((directory) => resolve(root, directory)),
    {
      scriptablePack: { ...options, sourceSnapshot: snapshot },
    },
  );
  if (!scanned.ok) throw scanned.error;
  const declarations = scanned.value.declarations;
  if (!declarations.has(entry))
    invalid(sourcePath, 'Pack source must be inside a configured asset directory');
  type Identity = { packageId?: string; sourceKey?: string };
  const owners = new Map<string, { path: string; identity?: Identity }>();
  const outputs = new Map<string, { origin: string; data: unknown; blocked: boolean }>();
  const declare = (guid: string, path: string, packageId?: string, sourceKey?: string) => {
    const identity = {
      ...(packageId ? { packageId } : {}),
      ...(sourceKey ? { sourceKey } : {}),
    };
    owners.set(guid.toLowerCase(), { path, identity });
  };
  for (const row of scanned.value.inventory)
    declare(
      row.guid,
      row.sourcePath,
      declarationPackageId(declarations.get(row.sourcePath)),
      row.sourceKey,
    );
  for (const declaration of declarations.values()) {
    const { sourcePath } = declaration;
    const namespace = declarationPackageId(declaration);
    if (namespace) {
      const previous = owners.get(namespace.toLowerCase());
      owners.set(namespace.toLowerCase(), { ...previous, path: sourcePath });
    }
  }
  // Evaluate through the existing isolated Pack executor, never runtime plugin apply.
  // Output identity and computed reference edges must not depend on textual UUID guesses.
  async function evaluate(
    path: string,
    origin: string,
    definition: AnyScriptablePackDefinition,
    packageId = definition.packageId,
    values: Readonly<Record<string, PackParameterValue>> | undefined = 'parameters' in definition
      ? resolvePackParameterValues(definition, {}).unwrap()
      : undefined,
  ): Promise<void> {
    let blocked = false;
    const result = await executePackBuild(definition, {
      packageId,
      async readByGuid() {
        blocked = true;
        return err({ code: 'author-transfer-read-blocked' });
      },
      ...(values === undefined ? {} : { values }),
    });
    if (!result.ok && !blocked) throw result.error;
    outputs.set(path, { origin, data: result.ok ? result.value : undefined, blocked });
    if (result.ok)
      for (const key of Object.keys(result.value))
        declare(
          AssetGuid.format(AssetGuid.derive(packageId, key)),
          path,
          PackageId.format(packageId),
          key,
        );
  }
  for (const declaration of declarations.values()) {
    if (declaration.format === 'pack.ts')
      await evaluate(declaration.sourcePath, declaration.sourcePath, declaration.definition);
  }
  // Each isolated build consumes its executor. Instances reuse the captured
  // module inputs and resolved values, and acquire their own executor.
  for (const [sourcePath, instance] of scanned.value.instances) {
    await evaluate(
      sourcePath,
      instance.root.sourcePath,
      (
        await loadScriptablePack(instance.root.sourcePath, { ...options, sourceSnapshot: snapshot })
      ).unwrap(),
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
    const digest = authorFileDigest(bytes);
    files.set(path, { path: relative(root, path).replaceAll('\\', '/'), bytes, digest });
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
      const output = outputs.get(path);
      if (output !== undefined) {
        if (output.blocked)
          invalid(
            path,
            'source closure requires cooked reads; make the transferable Pack source-discoverable',
          );
        const { origin, data } = output;
        if (origin !== path) pending.push(origin);
        async function refs(value: unknown, key = ''): Promise<void> {
          if (value instanceof Uint8Array && value.length === 16) {
            const owner = owners.get(AssetGuid.format(value as AssetGuid))?.path;
            if (owner) pending.push(owner);
          } else if (typeof value === 'string') {
            shaderEdge(value);
            const owner = owners.get(value.toLowerCase())?.path;
            if (owner) pending.push(owner);
            else if (key === '$asset') invalid(path, `missing referenced asset ${value}`);
            if (['specifier', 'executor'].includes(key)) await edge(origin, value);
          } else if (Array.isArray(value)) {
            for (const item of value) await refs(item);
          } else if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
            for (const [key, item] of Object.entries(value)) await refs(item, key);
          }
        }
        await refs(data);
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
      edges.push(...(await snapshot.imports(path, { includeTypeOnly: true })));
      if ((await snapshot.digest(path)) !== digest) invalid(path, 'source changed during transfer');
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
          if (key === '$asset' && !owners.has(value.toLowerCase()))
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
      const owner = owners.get(text.toLowerCase())?.path;
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
      [...owners].flatMap(([guid, owner]) =>
        owner.identity && selected.has(owner.path) ? [[guid, owner.identity] as const] : [],
      ),
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
