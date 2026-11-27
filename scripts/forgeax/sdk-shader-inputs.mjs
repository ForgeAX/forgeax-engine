import { cpSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { cachePath, inventoryMatches, workspacePackages } from '../build-task-cache.mjs';
import {
  assertCoreSource,
  coreBaseShaderDirectory,
  restoreCoreBaseShader,
} from '../ci/restore-core-shader-inputs.mjs';
import { reusableSharedShader, sharedShaderInputFingerprint } from '../lib/shared-build-cache.mjs';

/** The download owner already verifies both GitHub archives and their exact source. */
export function sdkCoreBuildRoot(root, core) {
  if (process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1')
    throw new Error('SDK artifact reuse is incompatible with disabled task caches');
  assertCoreSource(root, core);
  return core;
}

function restorePackageSourceMap(root, core, path, position) {
  const compact = JSON.parse(readFileSync(join(core, path), 'utf8'));
  const sourcesContent = compact.sources.map((name) => {
    const source = resolve(root, dirname(path), compact.sourceRoot ?? '', name);
    const location = relative(root, source);
    if (location === '..' || location.startsWith(`..${sep}`))
      throw new Error('SDK Core source map refers outside the checkout');
    return readFileSync(source, 'utf8');
  });
  const fields = Object.entries(compact);
  fields.splice(position, 0, ['sourcesContent', sourcesContent]);
  writeFileSync(join(core, path), JSON.stringify(Object.fromEntries(fields)));
}

/** The normal package scheduler rechecks source, dependency and output fingerprints. */
export function seedSdkPackageBuilds(root, core) {
  const positionsPath = join(core, 'package-map-source-positions.json');
  if (!existsSync(positionsPath)) return;
  const positions = JSON.parse(readFileSync(positionsPath, 'utf8'));
  let prepared = 0;
  for (const pkg of workspacePackages(root)) {
    const targetReceipt = cachePath(root, 'receipts/packages', pkg.manifest.name);
    const receiptPath = join(core, 'package-build-receipts', basename(targetReceipt));
    if (!existsSync(receiptPath)) continue;
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const dist = join(pkg.relativeDirectory, 'dist');
    const files = receipt.outputInventory?.files;
    if (
      !files?.length ||
      files.some(({ path }) =>
        path.split('/').some((part) => part === '' || part === '.' || part === '..'),
      )
    )
      continue;
    try {
      for (const file of files) {
        const path = join(dist, file.path).split(sep).join('/');
        if (Number.isInteger(positions[path]))
          restorePackageSourceMap(root, core, path, positions[path]);
      }
      if (!inventoryMatches(join(core, dist), receipt.outputInventory)) continue;
    } catch {
      // A missing source or a package-specific generated map is rebuilt by
      // its original producer. No shortened map is accepted as a cache hit.
      continue;
    }
    for (const file of files) {
      const path = join(dist, file.path);
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(core, path), join(root, path));
    }
    mkdirSync(dirname(targetReceipt), { recursive: true });
    cpSync(receiptPath, targetReceipt);
    prepared++;
  }
  console.log(`[sdk-build-inputs] offered ${prepared} Core package receipts to the package cache`);
}

/** Warm TS module resolution. The checked build still owns emission and declaration maps. */
export function seedSdkDeclarations(root, core) {
  const declarations = globSync('packages/*/dist/**/*.d.ts', { cwd: core });
  if (declarations.length === 0) throw new Error('SDK Core artifact has no declarations');
  let count = 0;
  for (const path of declarations) {
    const target = join(root, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(core, path), target);
    count++;
  }
  console.log(`[sdk-build-inputs] seeded ${count} declarations before the checked build`);
}

/** Called only after the SDK's cold package/compiler rebuild. */
export function admitSdkShaderInputs(root, staging = process.env.FORGEAX_SDK_SHADER_INPUTS) {
  if (!staging) throw new Error('SDK shader artifact staging is required');
  const core = sdkCoreBuildRoot(root, join(staging, 'core'));
  const pointRoot = join(staging, 'point');
  const pointDirectory = 'shared-app-inputs';
  const pointManifest = join(pointRoot, pointDirectory, 'manifest.json');
  const pointFingerprint = sharedShaderInputFingerprint(root, {
    pointShadows: true,
    hdrpSsao: true,
  });
  let reason;
  if (
    JSON.parse(readFileSync(pointManifest, 'utf8')).producer !== 'shared-app-inputs' ||
    !reusableSharedShader(pointRoot, pointManifest, pointFingerprint, (value) => {
      reason = value;
    })
  )
    throw new Error(`SDK point shader admission failed: ${reason ?? 'wrong producer'}`);
  // The existing core owner checks the source SHA and base profile before copying.
  restoreCoreBaseShader(root, core);
  const target = join(root, pointDirectory);
  mkdirSync(target, { recursive: true });
  for (const path of ['manifest.json', 'shaders'])
    cpSync(join(pointRoot, pointDirectory, path), join(target, path), { recursive: true });
  if (!reusableSharedShader(root, join(target, 'manifest.json'), pointFingerprint))
    throw new Error('restored SDK point shader receipt failed verification');
  console.log(
    `[sdk-shader-inputs] admitted ${coreBaseShaderDirectory} and ${pointDirectory}; compile count=0`,
  );
  return join(target, 'manifest.json');
}
