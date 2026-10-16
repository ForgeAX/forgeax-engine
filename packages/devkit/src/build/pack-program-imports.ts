import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PackProgramImport } from '@forgeax/engine-pack/runtime';
import { resolve as resolveImport } from 'import-meta-resolve';
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

/** Native Node imports resolve to the same installed modules as the owning Host. */
export async function createNodePackProgramImports(
  root: string,
  specifiers: readonly string[] = PACK_PROGRAM_ENGINE_IMPORTS,
): Promise<Readonly<Record<string, PackProgramImport>>> {
  const engineIdentity = specifiers.some((key) => key.startsWith('@forgeax/engine'))
    ? await runtimeProgramIdentity(
        createRequire(resolve(root, 'package.json')).resolve('@forgeax/engine/package.json'),
      )
    : '';
  return Object.fromEntries(
    await Promise.all(
      specifiers.map(async (specifier) => [
        specifier,
        await resolveNodePackProgramImport(root, specifier, engineIdentity),
      ]),
    ),
  );
}

/** Shared by native compilation and standalone restore; preserves the owning Host's module selection. */
export async function resolveNodePackProgramImport(
  root: string,
  specifier: string,
  engineIdentity?: string,
): Promise<PackProgramImport> {
  const parent = pathToFileURL(resolve(root, 'package.json')).href;
  if (isBuiltin(specifier)) {
    const url = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
    return { url, identity: await nativeModuleIdentity(url) };
  }
  if (specifier.startsWith('npm:')) {
    const url = await resolveNativeModuleKey(root, specifier);
    return { url, identity: await nativeModuleIdentity(url) };
  }
  if (specifier === '@deepseek-ai/cordis') {
    const url = pathToFileURL(
      createRequire(import.meta.resolve('@forgeax/engine-plugin')).resolve(specifier),
    ).href;
    return { url, identity: await nativeModuleIdentity(url) };
  }
  let url: string;
  if (specifier === '@forgeax/engine/plugin' || specifier === '@forgeax/engine-plugin')
    url = import.meta.resolve('@forgeax/engine-plugin');
  else if (
    specifier === '@forgeax/engine/tool-runtime' ||
    specifier === '@forgeax/engine-tool-runtime'
  )
    url = import.meta.resolve('@forgeax/engine-tool-runtime');
  else if (specifier.startsWith('@forgeax/engine-host/')) url = import.meta.resolve(specifier);
  else if (
    specifier === '@forgeax/engine' ||
    specifier.startsWith('@forgeax/engine/') ||
    specifier.startsWith('@forgeax/engine-')
  ) {
    url = resolveImport(
      specifier,
      specifier.startsWith('@forgeax/engine-')
        ? resolveImport('@forgeax/engine/package.json', parent)
        : parent,
    );
  } else
    throw new TypeError(`native program import requires a recorded package locator: ${specifier}`);
  return {
    url,
    identity:
      engineIdentity ??
      (await runtimeProgramIdentity(
        createRequire(resolve(root, 'package.json')).resolve('@forgeax/engine/package.json'),
      )),
  };
}
