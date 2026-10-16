import { PACK_AUTHORING_OPERATION_IDS } from '@forgeax/engine-pack/source';
import { operationCommandPath } from '@forgeax/engine-tool-runtime';
import { expect, it } from 'vitest';
import { createDefaultContributions } from '../contributions.js';
import { createUnifiedCommandContributions } from '../unified-contributions.js';

it('uses the public operation ID for every built-in CLI path', () => {
  for (const { descriptor } of [
    ...createDefaultContributions('/game'),
    ...createUnifiedCommandContributions('/game'),
  ]) {
    expect(descriptor.path ?? operationCommandPath(descriptor.id), descriptor.id).toEqual(
      descriptor.id.split('.'),
    );
  }
  expect(PACK_AUTHORING_OPERATION_IDS).toContain('asset.source.instance.create');
  expect(PACK_AUTHORING_OPERATION_IDS).toContain('asset.source.values.apply');
});
