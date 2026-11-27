import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Native provider identity from the same setup selection; no adapter/device is requested. */
export function vfxNativeLoaderEvidence() {
  const modules = Object.fromEntries(
    ['@forgeax/engine-ecs', '@forgeax/engine-vfx', '@forgeax/engine-vfx-render'].map((name) => {
      const url = import.meta.resolve(name);
      return [
        name,
        {
          url,
          sha256: createHash('sha256')
            .update(readFileSync(fileURLToPath(url)))
            .digest('hex'),
        },
      ];
    }),
  );
  const usesWgpuNative = process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native';
  const provider = usesWgpuNative ? 'wgpu-native' : 'upstream-webgpu';
  const module = usesWgpuNative
    ? new URL('../../../rhi-wgpu-native/src/index.ts', import.meta.url).href
    : createRequire(import.meta.resolve('@forgeax/engine-dawn-node')).resolve('upstream-webgpu');
  const modulePath = usesWgpuNative ? fileURLToPath(module) : module;
  const architecture = process.platform === 'darwin' ? 'universal' : process.arch;
  const binary = usesWgpuNative
    ? new URL(`../native/forgeax-rhi-wgpu-native.${process.platform}-${process.arch}.node`, module)
    : join(dirname(modulePath), 'dist', `${process.platform}-${architecture}`, 'dawn.node');
  const path = realpathSync(binary);
  const bytes = readFileSync(path);
  return {
    provider,
    module,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    modules,
    moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
    binary: {
      path,
      loaded: createRequire(module).cache[path] !== undefined,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
