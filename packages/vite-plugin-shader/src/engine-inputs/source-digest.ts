import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

function collectProgramInputs(directory: string, files: string[], typescript = false): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !['__tests__', '__generated__', 'tmp', 'temp', 'dist', 'node_modules', '.cache'].includes(
          entry.name,
        )
      )
        collectProgramInputs(path, files, typescript);
    } else if (entry.isFile()) {
      if (
        /\.(?:test|spec|fixture|generated|tmp|temp)\.[^.]+$/.test(entry.name) ||
        entry.name.endsWith('.d.ts')
      )
        continue;
      if (entry.name.endsWith('.wgsl') || (typescript && entry.name.endsWith('.ts')))
        files.push(path);
    }
  }
}

function recipeDirectory(root: string): string {
  const name = '@forgeax/engine-vite-plugin-shader/package.json';
  let manifest: string;
  try {
    manifest = createRequire(join(root, 'package.json')).resolve(name);
  } catch {
    manifest = createRequire(import.meta.url).resolve(name);
  }
  return join(dirname(manifest), 'src', 'engine-inputs');
}

// Compiled profile membership also depends on the engine manifest producer,
// not only on the bytes of individual WGSL files. Bump this revision whenever
// source-entry selection/composition changes so an older publication cannot
// pass provenance checks while omitting a newly admitted renderer entry.
const ENGINE_SHADER_INPUTS_REVISION = 5;

/**
 * SHA-256 over the entry recipe, Shader-owned WGSL/TypeScript inputs and
 * package program declarations. Shader/src is one conservative bounded TS
 * input owner: helpers need no naming convention or parallel dependency list.
 * Its small runtime support portion is deliberately included rather than
 * guessing which exports influence a program. Tests/artifacts are excluded.
 * Paths stay relative so producer and consumer checkouts agree. `undefined`
 * when `root` holds no WGSL, i.e. there is no source to compare against.
 */
export function engineShaderSourceDigest(root: string): string | undefined {
  const files: string[] = [];
  const recipeFiles: string[] = [];
  let recipeRoot: string;
  try {
    collectProgramInputs(root, files, true);
    recipeRoot = recipeDirectory(root);
    collectProgramInputs(recipeRoot, recipeFiles, true);
  } catch {
    return undefined;
  }
  if (!files.some((path) => path.endsWith('.wgsl'))) return undefined;
  const hash = createHash('sha256');
  hash.update(`forgeax-engine-shader-inputs-v${ENGINE_SHADER_INPUTS_REVISION}\0`);
  const rows = [
    ...files.map((path) => [`shader/${relative(root, path).split(sep).join('/')}`, path] as const),
    ...recipeFiles.map(
      (path) => [`recipe/${relative(recipeRoot, path).split(sep).join('/')}`, path] as const,
    ),
  ];
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, path] of rows) {
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  // The shared profile also publishes package-owned VFX programs. Their
  // declarations and WGSL are inputs even when the common View is unchanged.
  try {
    let manifestPath: string;
    try {
      manifestPath = createRequire(join(root, 'package.json')).resolve(
        '@forgeax/engine-vfx-render/package.json',
      );
    } catch {
      manifestPath = createRequire(import.meta.url).resolve(
        '@forgeax/engine-vfx-render/package.json',
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    hash.update(JSON.stringify(manifest.forgeax?.materialPrograms ?? {})).update('\0');
    const packageRoot = join(dirname(manifestPath), 'src', 'shaders');
    const packageFiles: string[] = [];
    collectProgramInputs(packageRoot, packageFiles);
    for (const path of packageFiles.sort()) {
      hash
        .update(`vfx-render/${relative(packageRoot, path).split(sep).join('/')}`)
        .update('\0')
        .update(readFileSync(path))
        .update('\0');
    }
  } catch {
    // A shader-only consumer has no package-owned VFX entries.
  }
  return hash.digest('hex');
}
