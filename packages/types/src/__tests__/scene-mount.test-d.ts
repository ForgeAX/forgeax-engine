// Keyed nested SceneAsset declarations replace numeric mount windows.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  SceneAsset,
  SceneEntity,
  SceneEntityAddress,
  SceneInstanceDeclaration,
  SceneInstanceOverride,
} from '../index';

describe('keyed nested scene contract', () => {
  it('keeps entity values limited to components and an optional instance', () => {
    expectTypeOf<SceneEntity['components']>().not.toBeNever();
    expectTypeOf<SceneEntity['instance']>().toEqualTypeOf<SceneInstanceDeclaration | undefined>();
    expectTypeOf<SceneAsset>().not.toHaveProperty('mounts');
  });

  it('uses a source plus ordered child-relative override declarations', () => {
    expectTypeOf<SceneInstanceDeclaration['source']>().toEqualTypeOf<string>();
    expectTypeOf<SceneInstanceDeclaration['overrides']>().toEqualTypeOf<
      readonly SceneInstanceOverride[] | undefined
    >();
    expectTypeOf<SceneInstanceOverride['target']>().toEqualTypeOf<readonly [string, ...string[]]>();
  });

  it('supports same-scene keys and nested key addresses', () => {
    expectTypeOf<SceneEntityAddress>().toEqualTypeOf<string | readonly [string, ...string[]]>();
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: {} },
        child: { components: { ChildOf: { parent: 'root' } } },
      },
    };
    expectTypeOf(scene).toMatchTypeOf<SceneAsset>();
  });
});
