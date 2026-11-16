import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepositoryRoot = resolve(defaultPackageRoot, '../..');

export function parseWaterContentArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--source-root' || !argv[1])
    throw new Error('usage: prepare-water-content.mjs [--source-root <water-directory>]');
  return { sourceRoot: resolve(argv[1]) };
}

/** Restore the exact authored sources; Meta and GUID ownership stay in Content. */
export async function prepareWaterContent({
  repositoryRoot = defaultRepositoryRoot,
  packageRoot = repositoryRoot === defaultRepositoryRoot
    ? defaultPackageRoot
    : resolve(repositoryRoot, 'packages/content'),
  sourceRoot = existsSync(resolve(repositoryRoot, '.forgeax-public-distribution'))
    ? resolve(packageRoot, 'assets/water')
    : resolve(repositoryRoot, 'forgeax-engine-assets/water'),
  outputRoot = resolve(packageRoot, 'assets/water'),
} = {}) {
  const provenance = JSON.parse(await readFile(resolve(packageRoot, 'assets/water/provenance.json'), 'utf8'));
  const inputs = await Promise.all(provenance.files.map(async ({ file, sha256 }) => {
    if (basename(file) !== file) throw new Error(`water-content-source-path: ${file}`);
    const source = resolve(sourceRoot, file);
    const bytes = await readFile(source);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error(`water-content-source-digest: ${file}: ${actual}`);
    return { file, source, sha256 };
  }));
  await mkdir(outputRoot, { recursive: true });
  for (const { file, source } of inputs) {
    const target = resolve(outputRoot, file);
    if (source !== target) await copyFile(source, target);
  }
  return inputs.map(({ file, sha256 }) => ({ file, sha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareWaterContent(parseWaterContentArgs(process.argv.slice(2)))));
}
