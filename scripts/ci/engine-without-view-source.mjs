import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SDK_RESOURCE_ALLOWLIST } from '../forgeax/sdk-lib.mjs';

/** Supply the sealed resources intentionally absent from the Git projection. */
export async function prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot }) {
  for (const entry of SDK_RESOURCE_ALLOWLIST) {
    for (const file of entry.files) {
      const destination = resolve(sourceRoot, entry.sourceRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repositoryRoot, entry.sourceRoot, file), destination);
    }
  }
  await writeFile(
    resolve(sourceRoot, '.forgeax-public-distribution'),
    'This source snapshot uses the public SDK resource and substrate inputs.\n',
  );
}
