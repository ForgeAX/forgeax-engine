import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PackProgramImport } from '@forgeax/engine-pack/runtime';
import { resolve as resolveImport } from 'import-meta-resolve';
import { localEnginePackageRoot } from '../engine-binding.js';
import { nativeModuleIdentity, resolveNativeModuleKey } from './native-module-identity.js';

export const PACK_PROGRAM_ENGINE_IMPORTS = [
  '@forgeax/engine/ecs',
  '@forgeax/engine/scene',
  '@forgeax/engine/geometry',
  '@forgeax/engine/plugin',
  '@forgeax/engine/pack/source',
  '@forgeax/engine/types',
] as const;

/** One code identity for the delivered Engine closure, independent of checkout location. */
export async function runtimeProgramIdentity(manifestPath: string): Promise<string> {
  const require = createRequire(manifestPath);
  const seen = new Set<string>();
  const hash = createHash('sha256');
  const visit = async (manifestPath: string): Promise<void> => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };
    if (seen.has(manifest.name)) return;
    seen.add(manifest.name);
    hash.update(
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
      }),
    );
    const directory = resolve(dirname(manifestPath), 'dist');
    const files = (await readdir(directory, { recursive: true }))
      .filter((path) => /\.(?:mjs|js)$/.test(path))
      .sort();
    for (const file of files) {
      hash.update(file);
      hash.update(await readFile(resolve(directory, file)));
    }
    for (const name of Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith('@forgeax/engine-'))
      .sort()) {
      await visit(require.resolve(`${name}/package.json`, { paths: [dirname(manifestPath)] }));
    }
  };
  await visit(manifestPath);
  return `sha256:${hash.digest('hex')}`;
}

/** Native Node imports resolve to the same Engine selection as native compilation. */
export async function createNodePackProgramImports(
  root: string,
  specifiers: readonly string[] = PACK_PROGRAM_ENGINE_IMPORTS,
): Promise<Readonly<Record<string, PackProgramImport>>> {
  const resolveProgramImport = createNodePackProgramResolver(root);
  return Object.fromEntries(
    await Promise.all(
      specifiers.map(async (specifier) => [specifier, await resolveProgramImport(specifier)]),
    ),
  );
}

async function selectProgramEngine(root: string, projectManifest: string) {
  const packageRoot = await localEnginePackageRoot(root);
  const manifest =
    packageRoot === undefined
      ? createRequire(projectManifest).resolve('@forgeax/engine/package.json')
      : resolve(packageRoot, 'package.json');
  const parent = pathToFileURL(manifest).href;
  if (
    packageRoot !== undefined &&
    resolveImport('@forgeax/engine/package.json', parent) !== parent
  ) {
    throw new TypeError(`engine-local-package-invalid: ${manifest}`);
  }
  return {
    parent,
    local: packageRoot !== undefined,
    identity: await runtimeProgramIdentity(manifest),
  };
}

/** One Engine selection and code identity per native compile or archive restore. */
export function createNodePackProgramResolver(
  root: string,
  trace: <T>(stage: string, operation: () => Promise<T>) => Promise<T> = (_stage, operation) =>
    operation(),
): (specifier: string) => Promise<PackProgramImport> {
  const projectManifest = resolve(root, 'package.json');
  let engine: ReturnType<typeof selectProgramEngine> | undefined;
  return (specifier) =>
    resolveProgramImport(root, projectManifest, specifier, () => {
      engine ??= trace('host-compile-engine-identity', () =>
        selectProgramEngine(root, projectManifest),
      );
      return engine;
    });
}

async function resolveProgramImport(
  root: string,
  projectManifest: string,
  specifier: string,
  selectEngine: () => ReturnType<typeof selectProgramEngine>,
): Promise<PackProgramImport> {
  let nativeUrl: string | undefined;
  if (isBuiltin(specifier))
    nativeUrl = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
  else if (specifier.startsWith('npm:')) nativeUrl = await resolveNativeModuleKey(root, specifier);
  else if (specifier === '@deepseek-ai/cordis')
    nativeUrl = pathToFileURL(
      createRequire(import.meta.resolve('@forgeax/engine-plugin')).resolve(specifier),
    ).href;
  if (nativeUrl !== undefined)
    return { url: nativeUrl, identity: await nativeModuleIdentity(nativeUrl) };
  if (
    specifier === '@forgeax/engine' ||
    specifier.startsWith('@forgeax/engine/') ||
    specifier.startsWith('@forgeax/engine-')
  ) {
    const { identity, local, parent } = await selectEngine();
    // These services belong to the executing Host and must keep its live tokens.
    if (specifier === '@forgeax/engine/plugin' || specifier === '@forgeax/engine-plugin')
      return { url: import.meta.resolve('@forgeax/engine-plugin'), identity };
    if (
      specifier === '@forgeax/engine/tool-runtime' ||
      specifier === '@forgeax/engine-tool-runtime'
    )
      return { url: import.meta.resolve('@forgeax/engine-tool-runtime'), identity };
    if (specifier.startsWith('@forgeax/engine-host/'))
      return { url: import.meta.resolve(specifier), identity };
    const url = resolveImport(
      specifier,
      local || specifier.startsWith('@forgeax/engine-')
        ? parent
        : pathToFileURL(projectManifest).href,
    );
    if (local && !(await stat(fileURLToPath(url))).isFile())
      throw new TypeError(`engine-local-module-invalid: ${url}`);
    return { url, identity };
  }
  throw new TypeError(`native program import requires a recorded package locator: ${specifier}`);
}
