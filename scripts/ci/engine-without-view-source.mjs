import { existsSync } from 'node:fs';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SDK_RESOURCE_ALLOWLIST } from '../forgeax/sdk-lib.mjs';
import { runnerResources, shaderSourceCompileWorkers } from '../lib/runner-resources.mjs';

/** Keep the complete cold producer within its existing heap, CPU and memory admission. */
export function engineWithoutViewBuildEnvironment(environment, resources = runnerResources()) {
  return {
    ...environment,
    FORGEAX_SHADER_COMPILE_WORKERS: String(
      shaderSourceCompileWorkers(
        resources,
        environment.FORGEAX_SHADER_COMPILE_WORKERS ?? (environment.CI === 'true' ? '4' : '2'),
      ),
    ),
  };
}

/** Select sealed resources and an optional shader-cache candidate for the public source build. */
export async function prepareEngineWithoutViewContent({
  repositoryRoot,
  sourceRoot,
  sharedInputsRoot,
}) {
  for (const entry of SDK_RESOURCE_ALLOWLIST) {
    for (const file of entry.files) {
      const destination = resolve(sourceRoot, entry.sourceRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repositoryRoot, entry.sourceRoot, file), destination);
    }
  }
  if (
    sharedInputsRoot &&
    existsSync(resolve(sharedInputsRoot, 'manifest.json')) &&
    existsSync(resolve(sharedInputsRoot, 'shaders/manifest.json'))
  ) {
    await cp(sharedInputsRoot, resolve(sourceRoot, 'shared-app-inputs'), { recursive: true });
    // The build producer accepts this cache only after validating the rebuilt
    // compiler, shader sources and profile fingerprint in the projected tree.
    await symlink('shared-app-inputs', resolve(sourceRoot, 'shared-build-inputs'), 'dir');
  }
  await writeFile(
    resolve(sourceRoot, '.forgeax-public-distribution'),
    'This source snapshot uses the public SDK resource and substrate inputs.\n',
  );
}
