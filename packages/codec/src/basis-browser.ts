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
