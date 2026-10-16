import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeWgpu } from '../native-build.mjs';

const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');
let prepared;

async function prepareNativeWgpuModule() {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-native-browser-'));
  try {
    const { directory } = await buildNativeWgpu({ out: join(temporary, 'native') });
    const result = await build({
      entryPoints: [join(directory, 'wgpu-native.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      alias: {
        '@forgeax/engine/wgpu-wasm/native-host': fileURLToPath(
          new URL('../../src/native-host.ts', import.meta.url),
        ),
      },
    });
    return result.outputFiles[0].text;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export const nativeBindingCommands = {
  prepareNativeWgpuModule() {
    prepared ??= prepareNativeWgpuModule().catch((error) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  },
};
