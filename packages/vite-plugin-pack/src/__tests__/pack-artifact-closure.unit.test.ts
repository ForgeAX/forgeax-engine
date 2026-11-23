import { importPackArtifactPaths } from '@forgeax/engine-import';
import { expect, it } from 'vitest';

it('reads the artifact closure from material-program wire transport', () => {
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ artifacts: { body: { path: 'mesh/body.bin' } } }],
  };
  expect(
    importPackArtifactPaths({
      schemaVersion: 'pack-material-programs/2',
      pack,
      programs: [],
      abis: [],
    }),
  ).toEqual(['mesh/body.bin']);
  expect(
    importPackArtifactPaths({
      schemaVersion: 'pack-material-programs/2',
      pack,
      programs: [{}],
      abis: [],
    }),
  ).toBeUndefined();
});
