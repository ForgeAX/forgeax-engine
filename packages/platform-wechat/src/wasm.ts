import { type PlatformError, platformError } from '@forgeax/engine-platform';
import { ok, type Result } from '@forgeax/engine-types';
import type {
  NativeWgpuCanvas,
  NativeWgpuHost,
  NativeWgpuImports,
  NativeWgpuInstance,
} from '@forgeax/engine-wgpu-wasm/native-host';
import { createWechatClock, type WechatClockSource } from './clock.js';
import type { WechatPackageSource } from './package-fetch.js';

export interface WechatWasmSource {
  readonly wx: WechatPackageSource & WechatClockSource;
  readonly WXWebAssembly: {
    instantiate(path: string, imports: NativeWgpuImports): Promise<NativeWgpuInstance>;
  };
}

/** Bind the immutable packaged path to both integrity reads and native instantiation. */
export function createWechatWgpuHost(
  source: WechatWasmSource,
  path: string,
  surfaces: readonly NativeWgpuCanvas[],
): Result<NativeWgpuHost, PlatformError> {
  const binding = createWechatWasmHost(source, path);
  if (!binding.ok) return binding;
  return ok({
    ...binding.value,
    surfaces: Object.freeze([...surfaces]),
    instantiate(imports) {
      const bindings = imports['./wgpu_wasm_bg.js'];
      if (!bindings) return binding.value.instantiate(imports);
      return binding.value.instantiate({
        ...imports,
        './wgpu_wasm_bg.js': Object.fromEntries(
          Object.entries(bindings).map(([name, original]) => {
            if (typeof original !== 'function') return [name, original];
            if (name.startsWith('__wbg_getProgramParameter_')) {
              return [
                name,
                function (this: unknown, context: unknown, program: unknown, parameter: number) {
                  const value = original.call(this, context, program, parameter);
                  // WebGL LINK_STATUS is boolean. WeChat Android can return the
                  // native GLboolean 0/1; all other query values remain untouched.
                  return parameter === 0x8b82 && (value === 0 || value === 1) ? value === 1 : value;
                },
              ];
            }
            if (name.startsWith('__wbg_getSyncParameter_')) {
              return [
                name,
                function (this: unknown, context: unknown, sync: unknown, parameter: number) {
                  const value = original.call(this, context, sync, parameter);
                  if (parameter !== 0x9114 || value !== 0x9118) return value;
                  const wait = (
                    context as {
                      clientWaitSync?: (sync: unknown, flags: number, timeout: number) => unknown;
                    }
                  ).clientWaitSync;
                  if (typeof wait !== 'function') return value;
                  // Advance native fence observation without blocking. A timeout
                  // remains UNSIGNALED; only native completion confirms SIGNALED.
                  const status = wait.call(context, sync, 0, 0);
                  return status === 0x911a || status === 0x911c ? 0x9119 : value;
                },
              ];
            }
            return [name, original];
          }),
        ),
      });
    },
  });
}

/** Bind one published WASM path; each domain retains its own imports and finalizer. */
export function createWechatWasmHost(source: WechatWasmSource, path: string) {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.wasm(?:\.br)?$/.test(path)) {
    return platformError('platform-operation-failed', {
      operation: 'wasm.package-path',
      cause: 'expected an immutable package-relative .wasm or .wasm.br path',
    });
  }
  if (
    typeof source.wx?.getFileSystemManager !== 'function' ||
    typeof source.WXWebAssembly?.instantiate !== 'function'
  ) {
    return platformError('platform-unavailable', { operation: 'WXWebAssembly.instantiate' });
  }
  const compressed = path.endsWith('.br');
  try {
    if (compressed && typeof source.wx.getFileSystemManager().readCompressedFile !== 'function') {
      return platformError('platform-unavailable', {
        operation: 'FileSystemManager.readCompressedFile',
      });
    }
  } catch (cause) {
    return platformError('platform-operation-failed', {
      operation: 'wx.getFileSystemManager',
      cause,
    });
  }
  const clock = createWechatClock(source.wx);
  if (!clock.ok) return clock;
  return ok({
    now: () => clock.value.now().unwrap(),
    readWasm: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const request = {
          filePath: path,
          success: (result: { readonly data: ArrayBuffer }) =>
            result.data instanceof ArrayBuffer
              ? resolve(new Uint8Array(result.data))
              : reject(new TypeError('WASM integrity read did not return binary bytes')),
          fail: reject,
        };
        const files = source.wx.getFileSystemManager();
        if (compressed) {
          if (!files.readCompressedFile)
            throw new Error('WeChat readCompressedFile is unavailable');
          files.readCompressedFile({ ...request, compressionAlgorithm: 'br' });
        } else files.readFile(request);
      }),
    instantiate: (imports: NativeWgpuImports) => source.WXWebAssembly.instantiate(path, imports),
  });
}
