import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@forgeax/engine-types';
import { findEngineWorkspaceRoot } from '../asset-libraries.js';
import { findSdkContext } from '../sdk.js';

export async function desktopAddon(platform: NodeJS.Platform, arch: string) {
  const fileName = `forgeax-rhi-wgpu-native.${platform}-${arch}.node`;
  const root = findEngineWorkspaceRoot();
  if (root !== undefined) {
    const owner = resolve(root, 'packages/rhi-wgpu-native');
    const addon = resolve(owner, 'native', fileName);
    if (existsSync(addon)) {
      return { fileName, module: resolve(owner, 'src/index.ts'), read: () => readFile(addon) };
    }
  }
  const sdk = await findSdkContext();
  const relative = `native-player/${platform}-${arch}/${fileName}`;
  const artifact = sdk?.manifest.artifacts.find((row) => row.path === relative);
  if (sdk === undefined || artifact === undefined)
    throw new Error(
      `Missing desktop addon ${fileName}. Build it in an Engine checkout or use an SDK with the matching native player artifact.`,
    );
  return {
    fileName,
    module: fileURLToPath(import.meta.resolve('@forgeax/engine-rhi-wgpu-native')),
    async read() {
      const binary = await readFile(resolve(sdk.root, relative));
      const digest = sha256(binary);
      if (binary.length !== artifact.bytes || digest !== artifact.sha256)
        throw new Error(`SDK native player artifact failed integrity verification: ${relative}`);
      return binary;
    },
  };
}
