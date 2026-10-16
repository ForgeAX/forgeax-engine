// @forgeax/engine-app/internal/rhi-debug-flag -- FORGEAX_ENGINE_RHI_DEBUG
// three-segment dual-source resolution (plan-strategy D-4).
//
// The canvas form reads the flag from two independent sources with a precise
// precedence + short-circuit shape so the same build serves both deployment
// targets:
//
//   browser (vite): `import.meta.env.FORGEAX_ENGINE_RHI_DEBUG` is statically
//     replaced by the vite-plugin-rhi-debug `define` hook.
//   dawn-node     : `import.meta` may be undefined and there is no vite define,
//     so the flag arrives through `globalThis.process.env`.
//
// Extracting the resolution into this pure helper lets it be unit-tested across
// the three scenarios (browser '1' / dawn-node process.env / unset) without a
// real bundler or runtime. The call site keeps the literal `typeof import.meta
// !== 'undefined'` prefix (C5) -- modelled here by passing `undefined` for the
// `importMetaEnv` argument when `import.meta` is absent.

/** Minimal structural view of an env bag carrying the flag. */
interface RhiDebugEnv {
  readonly FORGEAX_ENGINE_RHI_DEBUG?: string | undefined;
}

/**
 * Resolve the raw FORGEAX_ENGINE_RHI_DEBUG flag from the two sources.
 *
 * Precedence: `import.meta.env` wins; `globalThis.process.env` is the fallback.
 * Returns the raw string (or undefined); the caller compares `=== '1'`.
 *
 * @param importMetaEnv `import.meta.env` when `import.meta` is defined,
 *   else `undefined` (models the `typeof import.meta !== 'undefined'` prefix
 *   short-circuiting to a falsy first operand).
 * @param processEnv `globalThis.process?.env` when present, else `undefined`.
 */
export function resolveRhiDebugFlag(
  importMetaEnv: RhiDebugEnv | undefined,
  processEnv: RhiDebugEnv | undefined,
): string | undefined {
  return importMetaEnv?.FORGEAX_ENGINE_RHI_DEBUG ?? processEnv?.FORGEAX_ENGINE_RHI_DEBUG;
}
