import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getGitOrigin,
  getReleaseAsset,
  downloadAsset,
  extractTarball,
} from '../../../scripts/lib/fetch-wasm-lib.mjs';
import { PKG_ROOT, RELEASE_TAG, resolveAsset } from './content-key.mjs';
import { installBundle, verifyProvenance } from './provenance.mjs';

const stage = await mkdtemp(join(PKG_ROOT, '.pkg-fetch-'));
try {
  const { owner, repo } = getGitOrigin();
  const { sha256, assetName } = await resolveAsset();
  const options = {
    owner,
    repo,
    tag: RELEASE_TAG,
    pkgLabel: 'ui-blitz',
    buildHint: 'Run pnpm -F @forgeax/engine-ui-blitz build:wasm using the pinned toolchain.',
  };
  const asset = await getReleaseAsset(owner, repo, RELEASE_TAG, assetName, options);
  const archive = join(stage, 'pkg.tar.gz'),
    extracted = join(stage, 'pkg');
  await downloadAsset(asset, archive, options);
  await extractTarball(archive, extracted);
  await verifyProvenance({ pkgDirectory: extracted, expectedSourceDigest: sha256 });
  await installBundle(extracted);
  process.stdout.write(`[ui-blitz] verified ${assetName}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
