import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import { describe, expect, it } from 'vitest';
import { gltfErr } from '../errors';
import { buildNodeParentMap, resolveNamedNodePath } from '../node-path';

describe('glTF animation target paths', () => {
  const nodes = [
    { name: 'Root', children: [1] },
    { name: 'Hip', children: [] },
  ] as const;

  it('derives a stable full-path ID from a source node index', () => {
    const parents = buildNodeParentMap(nodes);
    const path = resolveNamedNodePath(nodes, parents, 1);
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    expect(path.value).toEqual(['Root', 'Hip']);
    expect(deriveAnimationTargetId(path.value)).toBe('a95da0ec669189f98273e8f86d8ad9f2');
  });

  it('uses one stable code with a reason discriminator', () => {
    const error = gltfErr('gltf-animation-target-invalid', {
      reason: 'name-missing',
      animationIndex: 0,
      channelIndex: 1,
      nodeIndex: 1,
    });
    expect(error.code).toBe('gltf-animation-target-invalid');
    expect(error.detail.reason).toBe('name-missing');
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('rejects cyclic node ancestry instead of looping', () => {
    const cyclicNodes = [
      { name: 'A', children: [1] },
      { name: 'B', children: [0] },
    ] as const;
    const path = resolveNamedNodePath(cyclicNodes, buildNodeParentMap(cyclicNodes), 0);

    expect(path).toEqual({
      ok: false,
      reason: 'hierarchy-cycle',
      nodeIndex: 0,
    });
  });

  it('does not reject unnamed nodes that are not animation targets', () => {
    const parents = buildNodeParentMap([{ children: [] }]);
    expect(parents.size).toBe(0);
  });
});
