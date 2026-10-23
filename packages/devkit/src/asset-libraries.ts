import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineBinding } from './engine-binding.js';
import { filesystemPathRelative, isFilesystemPathWithin } from './filesystem-path.js';
import type { CommandResult, ProjectAssetLibrary } from './types.js';

const ENGINE_FACADE_PREFIX = '@forgeax/engine/';

/** The Engine source checkout that contains this DevKit, when it runs from source. */
export function findEngineWorkspaceRoot(): string | undefined {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function libraryError(
  code: 'project-asset-library-unresolved' | 'project-asset-library-invalid',
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

async function manifestName(packageRoot: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      readonly name?: unknown;
    };
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/** Node's ancestor `node_modules` lookup, independent of the package's `exports` map. */
async function installedPackageRoot(from: string, name: string): Promise<string | undefined> {
  for (let cursor = resolve(from); ; cursor = dirname(cursor)) {
    const candidate = resolve(cursor, 'node_modules', name);
    if ((await manifestName(candidate)) === name) return realpath(candidate);
    if (dirname(cursor) === cursor) return undefined;
  }
}

async function workspacePackageRoot(
  workspaceRoot: string | undefined,
  directory: string,
  name: string,
): Promise<string | undefined> {
  if (workspaceRoot === undefined) return undefined;
  const candidate = resolve(workspaceRoot, 'packages', directory);
  return (await manifestName(candidate)) === name ? realpath(candidate) : undefined;
}

/**
 * Engine facades follow the project's Engine selection: an explicit local
 * binding, then the project's installed `@forgeax/engine` closure, then the
 * Engine that contains this DevKit. Other packages resolve from the project.
 */
async function libraryPackageRoot(
  projectRoot: string,
  specifier: string,
): Promise<CommandResult<{ readonly name: string; readonly root: string | undefined }>> {
  if (!specifier.startsWith(ENGINE_FACADE_PREFIX)) {
    return {
      ok: true,
      value: { name: specifier, root: await installedPackageRoot(projectRoot, specifier) },
    };
  }
  const directory = specifier.slice(ENGINE_FACADE_PREFIX.length);
  const name = `@forgeax/engine-${directory}`;
  const binding = await readEngineBinding(projectRoot);
  if (!binding.ok) return binding;
  if (binding.value !== null)
    return {
      ok: true,
      value: { name, root: await workspacePackageRoot(binding.value.path, directory, name) },
    };
  const engineRoot = await installedPackageRoot(projectRoot, '@forgeax/engine');
  const root =
    (engineRoot === undefined ? undefined : await installedPackageRoot(engineRoot, name)) ??
    (await installedPackageRoot(dirname(fileURLToPath(import.meta.url)), name)) ??
    (await workspacePackageRoot(findEngineWorkspaceRoot(), directory, name));
  return { ok: true, value: { name, root } };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve forge.json `assetLibraries` to the read-only asset directories they mount. */
export async function resolveAssetLibraries(
  projectRoot: string,
  specifiers: readonly string[],
): Promise<CommandResult<readonly ProjectAssetLibrary[]>> {
  const libraries: ProjectAssetLibrary[] = [];
  for (const specifier of specifiers) {
    const located = await libraryPackageRoot(projectRoot, specifier);
    if (!located.ok) return located;
    const { name, root: packageRoot } = located.value;
    if (packageRoot === undefined) {
      return libraryError(
        'project-asset-library-unresolved',
        `forge.json assetLibraries entry ${specifier} to resolve to an installed package`,
        specifier.startsWith(ENGINE_FACADE_PREFIX)
          ? 'Install @forgeax/engine in the project (or bind a local Engine) and use an existing Engine package directory.'
          : `Add ${name} to the project dependencies and install it, or remove the entry.`,
        { root: projectRoot, specifier, package: name },
      );
    }
    let assetRoot: unknown;
    try {
      const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
      assetRoot = manifest?.forgeax?.library?.assetRoot;
    } catch {
      assetRoot = undefined;
    }
    const invalid = (reason: string) =>
      libraryError(
        'project-asset-library-invalid',
        `${name} package.json#forgeax.library.assetRoot to name an asset directory inside the package`,
        'Use a package that declares forgeax.library.assetRoot, or remove it from forge.json assetLibraries.',
        { root: projectRoot, specifier, package: name, packageRoot, reason },
      );
    if (typeof assetRoot !== 'string' || assetRoot.length === 0)
      return invalid('forgeax.library.assetRoot is missing');
    const root = resolve(packageRoot, assetRoot);
    if (
      filesystemPathRelative(packageRoot, root, false) === undefined ||
      !(await isDirectory(root))
    )
      return invalid(`asset root ${assetRoot} is not a directory inside the package`);
    libraries.push({ specifier, root: await realpath(root) });
  }
  return { ok: true, value: libraries };
}

/** The mounted library that owns `path`, if any. */
export function owningAssetLibrary(
  libraries: readonly ProjectAssetLibrary[],
  path: string,
): ProjectAssetLibrary | undefined {
  return libraries.find((library) => isFilesystemPathWithin(library.root, path, false));
}

/** Catalog identity of a library source: `<specifier>/<path inside the library>`. */
export function assetLibrarySourceIdentity(
  libraries: readonly ProjectAssetLibrary[],
  path: string,
): string | undefined {
  const library = owningAssetLibrary(libraries, path);
  if (library === undefined) return undefined;
  const local = filesystemPathRelative(library.root, path, false);
  return local === undefined ? undefined : `${library.specifier}/${local.replaceAll('\\', '/')}`;
}
