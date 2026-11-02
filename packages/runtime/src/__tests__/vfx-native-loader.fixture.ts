import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  const provider = process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' ? 'wgpu-native' : 'dawn';
  const module =
    provider === 'dawn'
      ? import.meta.resolve('@forgeax/engine-dawn-node')
      : new URL('../../../rhi-wgpu-native/src/index.ts', import.meta.url).href;
  if (provider === 'dawn' && process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      provider: 'upstream-webgpu',
      module: createRequire(module).resolve('upstream-webgpu'),
      node: process.version,
      modules,
      binary: { state: 'not-exposed-by-upstream-loader' },
    };
  }
  const binary =
    provider === 'dawn'
      ? new URL(`../dist/native/${process.platform}-${process.arch}/dawn.node`, module)
      : new URL(
          `../native/forgeax-rhi-wgpu-native.${process.platform}-${process.arch}.node`,
          module,
        );
  const path = realpathSync(fileURLToPath(binary));
  const bytes = readFileSync(path);
  return {
    provider,
    module,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    modules,
    moduleSha256: createHash('sha256')
      .update(readFileSync(fileURLToPath(module)))
      .digest('hex'),
    binary: {
      path,
      loaded: createRequire(module).cache[path] !== undefined,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
