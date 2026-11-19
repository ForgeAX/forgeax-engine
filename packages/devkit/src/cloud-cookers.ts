import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createCloudCookers } from '@forgeax/engine-render/authoring';
import { compileShader, getShaderCompilerFingerprint } from '@forgeax/engine-shader-compiler';
import { loadCloudRendererModules } from '@forgeax/engine-vite-plugin-shader';

/** Build-host defaults; runtime only receives the existing cooked cloud artifacts. */
export function createDefaultCloudCookers(
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): ReturnType<typeof createCloudCookers> {
  return createCloudCookers({
    loadRendererModules: () => loadCloudRendererModules(readText),
    async loadSource(packSourcePath, siblingWgsl) {
      const root = dirname(await realpath(packSourcePath));
      const path = await realpath(resolve(root, siblingWgsl));
      if (dirname(path) !== root) throw new Error('Cloud WGSL must stay beside its Pack source.');
      return { path, source: await readText(path) };
    },
    async compilerIdentity() {
      return (await getShaderCompilerFingerprint()).unwrap();
    },
    compile: (source, id, imports) =>
      compileShader(source, { id, ...(imports === undefined ? {} : { imports }) }),
  });
}
