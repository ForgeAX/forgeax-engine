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

export interface DesktopRenderKernelAddonHandle {
  readonly fileName: string;
  readonly path: string;
  readonly module: string;
  read(): Promise<Buffer>;
}

/**
 * Resolves the opt-in native Rust wgpu 30 RenderKernel desktop addon
 * (`forgeax-render-kernel.<platform>-<arch>.node`). Returns `undefined` when
 * not built unless `required` is set to `true`.
 */
export async function desktopRenderKernelAddon(
  platform: NodeJS.Platform,
  arch: string,
  options?: { readonly required?: boolean | undefined },
): Promise<DesktopRenderKernelAddonHandle | undefined> {
  const fileName = `forgeax-render-kernel.${platform}-${arch}.node`;
  const root = findEngineWorkspaceRoot();
  if (root !== undefined) {
    const owner = resolve(root, 'packages/render-kernel');
    const addon = resolve(owner, 'native', fileName);
    if (existsSync(addon)) {
      return {
        fileName,
        path: addon,
        module: resolve(owner, 'src/desktop/index.ts'),
        read: () => readFile(addon),
      };
    }
  }
  const sdk = await findSdkContext();
  const relative = `native-player/${platform}-${arch}/${fileName}`;
  const artifact = sdk?.manifest.artifacts.find((row) => row.path === relative);
  if (sdk !== undefined && artifact !== undefined) {
    const addonPath = resolve(sdk.root, relative);
    return {
      fileName,
      path: addonPath,
      module: fileURLToPath(import.meta.resolve('@forgeax/engine-render-kernel/native')),
      async read() {
        const binary = await readFile(addonPath);
        const digest = sha256(binary);
        if (binary.length !== artifact.bytes || digest !== artifact.sha256)
          throw new Error(`SDK render-kernel artifact failed integrity verification: ${relative}`);
        return binary;
      },
    };
  }
  if (options?.required) {
    throw new Error(
      `Missing native RenderKernel desktop addon ${fileName}. Build it with: pnpm --filter @forgeax/engine-render-kernel build:native`,
    );
  }
  return undefined;
}
