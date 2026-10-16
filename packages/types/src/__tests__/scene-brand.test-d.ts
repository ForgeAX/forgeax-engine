// Keyed SceneAsset type-level contract.

import { describe, expectTypeOf, it } from 'vitest';
import type { SceneAsset, SceneEntity, SceneEntityKey } from '../index';

describe('keyed SceneAsset identity', () => {
  it('uses a string key as the sole author identity', () => {
    expectTypeOf<SceneEntityKey>().toEqualTypeOf<string>();
    expectTypeOf<SceneEntity>().not.toHaveProperty('localId');
    expectTypeOf<SceneEntity>().not.toHaveProperty('bindingKey');
  });

  it('stores entities in a readonly keyed collection', () => {
    expectTypeOf<SceneAsset>()
      .toHaveProperty('entities')
      .toEqualTypeOf<Readonly<Record<string, SceneEntity>>>();
  });

  it('keeps the scene discriminator closed', () => {
    expectTypeOf<SceneAsset>().toHaveProperty('kind').toEqualTypeOf<'scene'>();
  });
});
