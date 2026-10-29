import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  bindGroupByteRangeLeaf4,
  bindGroupChainLeaf,
  bindGroupChainLeaf2,
  bindGroupChainLeaf3,
  bindGroupChainLeaf4,
  bindGroupChainLeaf6,
  bindGroupSkinRangeLeaf6,
  getOrCreateFromChain,
  getOrCreateFromChainResult,
  rememberBindGroup,
} from '../mesh-ssbo';

describe('mesh bind-group cache chains', () => {
  it('owns numeric range variants with physical resources and keeps changed ranges distinct', () => {
    const root = new WeakMap<object, unknown>();
    const a = {},
      b = {},
      c = {},
      d = {},
      e = {},
      f = {};
    const group = { id: 'range' } as never;
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const mesh = bindGroupByteRangeLeaf4(root, a, b, c, d);
    rememberBindGroup(mesh, 256, group, counts, 'gpu-driven-hdrp:256');
    expect(bindGroupByteRangeLeaf4(root, a, b, c, d).get(256)).toBe(group);
    expect(mesh.get(512)).toBeUndefined();
    expect(bindGroupChainLeaf4(root, a, b, c, d).get('256')).toBeUndefined();
    const skin = bindGroupSkinRangeLeaf6(root, a, b, c, d, e, f, 256, 32);
    rememberBindGroup(skin, 64, group, counts, 'gpu-driven-hdrp-skin:256:32:64');
    expect(bindGroupSkinRangeLeaf6(root, a, b, c, d, e, f, 256, 32).get(64)).toBe(group);
    expect(bindGroupSkinRangeLeaf6(root, a, b, c, d, e, f, 512, 32).get(64)).toBeUndefined();
    expect(bindGroupSkinRangeLeaf6(root, a, b, c, d, e, f, 256, 48).get(64)).toBeUndefined();
    expect(skin.get(128)).toBeUndefined();
    expect(bindGroupSkinRangeLeaf6(root, a, b, c, d, e, {}, 256, 32).get(64)).toBeUndefined();
    expect(bindGroupByteRangeLeaf4(new WeakMap(), a, b, c, d).get(256)).toBeUndefined();
    expect(counts).toEqual({
      createBindGroup: 2,
      keys: ['gpu-driven-hdrp:256', 'gpu-driven-hdrp-skin:256:32:64'],
    });
  });

  it('shares fixed-depth leaves with the generic cache without aliasing prefixes or resources', () => {
    const root = new WeakMap<object, unknown>();
    const a = {},
      b = {},
      c = {},
      d = {},
      e = {},
      f = {};
    const two = bindGroupChainLeaf2(root, a, b);
    const three = bindGroupChainLeaf3(root, a, b, c);
    expect(bindGroupChainLeaf(root, [a, b])).toBe(two);
    expect(bindGroupChainLeaf(root, [a, b, c])).toBe(three);
    expect(two).not.toBe(three);
    const four = bindGroupChainLeaf4(root, a, b, c, d);
    const six = bindGroupChainLeaf6(root, a, b, c, d, e, f);
    const group = { id: 'four' } as never;
    four.set('variant', group);
    expect(bindGroupChainLeaf(root, [a, b, c, d])).toBe(four);
    expect(bindGroupChainLeaf(root, [a, b, c, d, e, f])).toBe(six);
    expect(six).not.toBe(four);
    expect(six.get('variant')).toBeUndefined();
    expect(bindGroupChainLeaf6(root, a, b, c, d, e, {})).not.toBe(six);
    expect(bindGroupChainLeaf4(root, a, b, c, {})).not.toBe(four);
    const counts = { createBindGroup: 0, keys: [] as string[] };
    expect(
      getOrCreateFromChain(
        root,
        [a, b, c, d],
        'variant',
        () => {
          throw new Error('fixed-depth leaf was not shared');
        },
        counts,
      ),
    ).toBe(group);
    expect(counts.createBindGroup).toBe(0);
  });

  it('keeps variable-depth material resource chains isolated', () => {
    const root = new WeakMap<object, unknown>();
    const shared = { shared: true };
    const coatSampler = { coatSampler: true };
    const coatTexture = { coatTexture: true };
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const long = getOrCreateFromChain(
      root,
      [shared, coatSampler, coatTexture],
      'material-shared',
      () => ({ id: 'long' }) as never,
      counts,
    );
    const short = getOrCreateFromChain(
      root,
      [shared, coatSampler],
      'material-shared',
      () => ({ id: 'short' }) as never,
      counts,
    );

    expect(
      getOrCreateFromChain(
        root,
        [shared, coatSampler],
        'material-shared',
        () => ({ id: 'unexpected' }) as never,
        counts,
      ),
    ).toBe(short);
    expect(long).not.toBe(short);
    expect(counts.createBindGroup).toBe(2);
  });

  it('propagates bind-group creation failures without poisoning the cache', () => {
    const root = new WeakMap<object, unknown>();
    const resource = {};
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const failure = { code: 'rhi-device-lost' };
    const failed = getOrCreateFromChainResult(
      root,
      [resource],
      'retryable',
      () => err(failure),
      counts,
    );
    expect(failed).toEqual({ ok: false, error: failure });
    expect(counts.createBindGroup).toBe(0);

    const created = { id: 'created' } as never;
    const recovered = getOrCreateFromChainResult(
      root,
      [resource],
      'retryable',
      () => ok(created),
      counts,
    );
    expect(recovered).toEqual({ ok: true, value: created });
    expect(counts.createBindGroup).toBe(1);
    expect(
      getOrCreateFromChainResult(
        root,
        [resource],
        'retryable',
        () => {
          throw new Error('cache miss after recovery');
        },
        counts,
      ),
    ).toEqual({ ok: true, value: created });
  });
});
