import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prepareWaterContent } from '../../packages/content/scripts/prepare-water-content.mjs';
import { SDK_RESOURCE_ALLOWLIST } from '../forgeax/sdk-lib.mjs';

/** Select the same sealed resource inputs as the public SDK source build. */
export async function prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot }) {
  for (const entry of SDK_RESOURCE_ALLOWLIST) {
    for (const file of entry.files) {
      const destination = resolve(sourceRoot, entry.sourceRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repositoryRoot, entry.sourceRoot, file), destination);
    }
  }
  await prepareWaterContent({
    repositoryRoot: sourceRoot,
    sourceRoot: resolve(sourceRoot, 'packages/content/assets/water'),
  });
  await writeFile(
    resolve(sourceRoot, '.forgeax-public-distribution'),
    'This source snapshot uses the public SDK resource and substrate inputs.\n',
  );
}
