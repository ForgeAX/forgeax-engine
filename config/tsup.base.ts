import type { Options } from 'tsup';

/**
 * Base tsup configuration shared across all packages.
 *
 * Field naming intentionally aligns with `tsdown` (format / dts / platform / target),
 * leaving a 0-LOC migration path if tsup is ever archived (plan-strategy §3 R-4).
 *
 * - `format: ['esm']` — ESM-only outputs (`.mjs`); see plan-strategy §K-1.
 * - `dts: false` — declarations come exclusively from `tsc -b` composite graph (§K-2).
 * - `treeshake: true` — Rollup pass guards against esbuild's occasional missed-shake (§K-1 / R-4).
 * - `splitting: false` — single-file entry per package keeps published bundle predictable.
 * - `sourcemap: true` — required for stack traces; included in published artifacts.
 * - `clean: false` — DO NOT wipe `dist/` (tsc -b owns `.d.ts` / `.d.ts.map` /
 *   `.tsbuildinfo` SSOT, §K-2). Build orchestration runs `pnpm -r build && tsc -b`
 *   so tsup's stale `.mjs` is overwritten in-place; old artifacts cleared by
 *   removing `dist/` manually before a clean build (CI does `rm -rf` first).
 */
export const baseTsupConfig: Options = {
  format: ['esm'],
  dts: false,
  treeshake: true,
  splitting: false,
  target: 'es2022',
  platform: 'neutral',
  sourcemap: true,
  clean: false,
  // Force .mjs extension (tsup 8.x defaults to .js for `type: module` packages, but
  // plan-strategy §K-1 + §AC-02 require `.mjs` literal as the published artifact).
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
};
