import { lstat, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Options } from 'tsup';

// Hashed split chunks occupy tsup's generated namespace. Named entrypoints can
// also be checked source assets, so they are never selected for cleanup.
const generatedChunk = /-[A-Z0-9]{8}\.mjs(?:\.map)?$/;

async function pruneObsoleteChunks(outDir: string, writtenFiles: readonly { name: string }[]) {
  const packageRoot = process.cwd();
  const outputRoot = resolve(packageRoot, outDir);
  const outputPath = relative(packageRoot, outputRoot);
  if (!outputPath || isAbsolute(outputPath) || outputPath.split(sep).includes('..')) {
    throw new Error(`tsup chunk cleanup requires an output directory inside ${packageRoot}`);
  }
  let checkedPath = packageRoot;
  for (const segment of outputPath.split(sep)) {
    checkedPath = join(checkedPath, segment);
    if ((await lstat(checkedPath)).isSymbolicLink()) {
      throw new Error(`tsup chunk cleanup refuses linked output directory ${checkedPath}`);
    }
  }
  const currentFiles = new Set(writtenFiles.map(({ name }) => resolve(packageRoot, name)));
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && generatedChunk.test(entry.name) && !currentFiles.has(file)) {
        await unlink(file);
      }
    }
  }
  await visit(outputRoot);
}

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
 * - `clean: false` — tsc owns declarations and build info; source assets share
 *   the output directory. After successful ESM production, remove only obsolete
 *   hashed JS chunks/maps using tsup's current written-file inventory.
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
  plugins: [
    {
      name: 'prune-obsolete-esm-chunks',
      async buildEnd({ writtenFiles }) {
        if (this.format === 'esm' && this.splitting) {
          await pruneObsoleteChunks(this.options.outDir, writtenFiles);
        }
      },
    },
  ],
  // Force .mjs extension (tsup 8.x defaults to .js for `type: module` packages, but
  // plan-strategy §K-1 + §AC-02 require `.mjs` literal as the published artifact).
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
};
