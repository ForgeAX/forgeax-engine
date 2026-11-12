import { describe, expect, it } from 'vitest';
import { fixtureDigests } from './determinism-fixtures';
import golden from './golden/determinism.json';

describe('determinism in Chromium (design 15)', () => {
  it('produces the same FXEM and MeshAsset bytes as Node', async () => {
    expect(await fixtureDigests()).toEqual(golden);
  });
});
