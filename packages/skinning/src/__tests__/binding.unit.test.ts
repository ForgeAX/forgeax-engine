import { componentSchema } from '@forgeax/engine-ecs/internal';
import { resolveSkinJoints, Skin, SkinJointPathUnresolvedError } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

describe('skinning binding contract', () => {
  it('exposes Skin as the optional binding component', () => {
    expect(Skin.name).toBe('Skin');
    expect(componentSchema(Skin).skeleton).toBe('shared<SkeletonAsset>');
    expect(componentSchema(Skin).joints).toBe('array<entity>');
  });

  it('returns the canonical error and retries with only the Name map repaired', () => {
    const jointPaths = ['Root/Arm', 'Root/Missing', 'Root/Hand'];
    const names = new Map([
      ['Arm', 4 as never],
      ['Root', 5 as never],
    ]);
    const result = resolveSkinJoints(jointPaths, names, 7 as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const expected = new SkinJointPathUnresolvedError(7, ['Root', 'Missing'], 1);
    expect(result.error).toBeInstanceOf(SkinJointPathUnresolvedError);
    expect(result.error.code).toBe('skin-joint-path-unresolved');
    expect(result.error.expected).toBe(expected.expected);
    expect(result.error.hint).toBe(expected.hint);
    expect(result.error.detail).toEqual(expected.detail);

    names.set('Missing', 6 as never);
    names.set('Hand', 8 as never);
    const retry = resolveSkinJoints(jointPaths, names, 7 as never);
    expect(retry).toEqual({ ok: true, value: new Uint32Array([4, 6, 8]) });
  });
});
