import type { BasisModuleFactory, BasisTranscoderModule } from './wasm/basis-types.js';

/** Browser/Node URL loading; the native condition selects the unmodified factory directly. */
export default async function createBasisModule(
  overrides?: Record<string, unknown>,
): Promise<BasisTranscoderModule> {
  const glue = new URL('../pkg/basis_transcoder.mjs', import.meta.url);
  const wasm = new URL('../pkg/basis_transcoder.wasm', import.meta.url);
  const factory = (
    (await import(/* @vite-ignore */ glue.href)) as {
      default: BasisModuleFactory<BasisTranscoderModule>;
    }
  ).default;
  return factory({ locateFile: () => wasm.href, ...overrides });
}

/**
 * Compile the transcoder WASM once so realms that run it can share the module.
 * Resolves `undefined` where the binary is not fetchable (file URLs, Hosts
 * without streaming compilation); callers then load it themselves.
 */
export async function compileBasisWasm(): Promise<WebAssembly.Module | undefined> {
  const wasm = new URL('../pkg/basis_transcoder.wasm', import.meta.url);
  if (
    !['http:', 'https:', 'blob:'].includes(wasm.protocol) ||
    typeof fetch !== 'function' ||
    typeof WebAssembly?.compile !== 'function'
  )
    return undefined;
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(fetch(wasm.href));
    } catch {
      // A server without the wasm MIME type still serves the bytes.
    }
  }
  const response = await fetch(wasm.href);
  if (!response.ok) return undefined;
  return WebAssembly.compile(await response.arrayBuffer());
}
