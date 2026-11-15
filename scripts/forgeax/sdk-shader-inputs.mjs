import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coreBaseShaderDirectory,
  restoreCoreBaseShader,
} from '../ci/restore-core-shader-inputs.mjs';
import { reusableSharedShader, sharedShaderInputFingerprint } from '../lib/shared-build-cache.mjs';

/** Called only after the SDK's cold package/compiler rebuild. */
export function admitSdkShaderInputs(root, staging = process.env.FORGEAX_SDK_SHADER_INPUTS) {
  if (!staging) throw new Error('SDK shader artifact staging is required');
  if (process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1')
    throw new Error('SDK artifact reuse is incompatible with disabled task caches');
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
  restoreCoreBaseShader(root, join(staging, 'core'));
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
