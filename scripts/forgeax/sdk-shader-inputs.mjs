import { cpSync, existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
