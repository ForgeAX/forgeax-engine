import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const audioPackage = 'node-web-audio-api';

async function resolvePackage(name: string, importer: string) {
  let root = dirname(createRequire(importer).resolve(name));
  for (;;) {
    const manifestPath = join(root, 'package.json');
    const source = await readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (source !== undefined) {
      const manifest = JSON.parse(source) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (manifest.name === name) return { root, manifestPath, manifest };
    }
    const parent = dirname(root);
    if (parent === root) throw new Error(`Cannot locate installed audio dependency ${name}`);
    root = parent;
  }
}

type Emit = (fileName: string, source: Uint8Array) => void;

async function emitRuntimeFiles(
  source: string,
  destination: string,
  nativeFile: string | undefined,
  emit: Emit,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const input = join(source, name);
    const output = `${destination}/${name}`;
    if (entry.isDirectory() && !['node_modules', 'test', 'tests', 'examples'].includes(name)) {
      await emitRuntimeFiles(input, output, undefined, emit);
    } else if (
      entry.isFile() &&
      (name === nativeFile || /\.(m?js|cjs|json)$|^(LICEN[CS]E|NOTICE|COPYING)(\.|$)/i.test(name))
    ) {
      emit(output, await readFile(input));
    }
  }
}

async function emitDependencies(
  importer: string,
  dependencies: readonly string[],
  emitted: Map<string, string>,
  emit: Emit,
): Promise<void> {
  for (const dependency of dependencies) {
    const { root, manifestPath, manifest } = await resolvePackage(dependency, importer);
    const previous = emitted.get(dependency);
    if (previous === root) continue;
    if (previous !== undefined)
      throw new Error(`Native audio package resolves multiple versions of ${dependency}`);
    emitted.set(dependency, root);
    await emitRuntimeFiles(root, `audio/node_modules/${dependency}`, undefined, emit);
    await emitDependencies(
      manifestPath,
      Object.keys(manifest.dependencies ?? {}).sort(),
      emitted,
      emit,
    );
  }
}

/** Relocate the pinned package and its runtime dependency closure, including its licenses. */
export async function emitDesktopAudioPayload(
  platform: NodeJS.Platform,
  arch: string,
  emit: Emit,
): Promise<void> {
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : '';
  const { root, manifestPath, manifest } = await resolvePackage(audioPackage, import.meta.url);
  const nativeFile = `${audioPackage}.${platform}-${arch}${suffix}.node`;
  await readFile(join(root, nativeFile));
  await emitRuntimeFiles(root, 'audio', nativeFile, emit);
  await emitDependencies(
    manifestPath,
    Object.keys(manifest.dependencies ?? {}).sort(),
    new Map(),
    emit,
  );
}
