import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {} from '@forgeax/engine/devkit/plugin-build';
import type { Plugin } from '@forgeax/engine/plugin';
import { createCloudCookers } from '@forgeax/engine/render/authoring';
import { compileShader, getShaderCompilerFingerprint } from '@forgeax/engine/shader-compiler';
import { loadCloudDensityModules, loadCloudRendererModules } from '@forgeax/engine/vite-plugin-shader';

export function referenceCloudCookers() {
  return createCloudCookers({
    loadRendererModules: loadCloudRendererModules,
    async loadSource(packSourcePath, siblingWgsl) {
      const root = dirname(await realpath(packSourcePath));
      const path = await realpath(resolve(root, siblingWgsl));
      if (dirname(path) !== root) throw new Error('Cloud WGSL must stay beside its Pack source.');
      return {
        path,
        source: await readFile(path, 'utf8'),
        ...(siblingWgsl === 'reference-layout.wgsl'
          ? { densityKernel: await loadCloudDensityModules() }
          : {}),
      };
    },
    async compilerIdentity() {
      return (await getShaderCompilerFingerprint()).unwrap();
    },
    compile: (source, id, imports) => compileShader(source, { id, ...(imports === undefined ? {} : { imports }) }),
  });
}

export const build: Plugin = {
  name: 'forgeax-assets/volumetric-clouds/build',
  inject: ['nativeCookers'],
  apply(ctx) {
    for (const cooker of referenceCloudCookers()) {
      ctx.effect(() => ctx.nativeCookers!.register(cooker));
    }
  },
};
