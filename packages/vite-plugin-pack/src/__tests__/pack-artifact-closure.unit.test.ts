import { expect, it } from 'vitest';
import { persistedArtifactPaths } from '../plugin-pack.js';

it('reads the artifact closure from material-program wire transport', () => {
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ artifacts: { body: { path: 'mesh/body.bin' } } }],
  };
  expect(
    persistedArtifactPaths({ schemaVersion: 'pack-material-programs/1', pack, programs: [] }),
  ).toEqual(['mesh/body.bin']);
  expect(
    persistedArtifactPaths({ schemaVersion: 'pack-material-programs/1', pack, programs: [{}] }),
  ).toBeUndefined();
});
