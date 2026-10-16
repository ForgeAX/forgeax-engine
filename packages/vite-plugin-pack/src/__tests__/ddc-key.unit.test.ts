import { semanticBuildKey } from '@forgeax/engine-ddc';
import { describe, expect, it } from 'vitest';

const input = () => ({
  schemaVersion: '2.0.0',
  importerVersion: 'image@1',
  codecVersion: 'codec@2',
  sourceDependencies: [{ path: 'assets/a.png', digest: 'aaa' }],
  settings: { colorSpace: 'srgb', mipmap: true },
  declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  cookProfile: 'release',
  publish: { base: '/preview/', url: 'assets/a.bin', hash: 'hash-a' },
});

describe('semantic DDC key', () => {
  it('includes every semantic input and excludes publish environment', () => {
    const a = semanticBuildKey(input());
    const b = semanticBuildKey({ ...input(), publish: { base: '/release/', url: 'x', hash: 'y' } });
    expect(a).toBe(b);
    expect(semanticBuildKey({ ...input(), codecVersion: 'codec@3' })).not.toBe(a);
    expect(
      semanticBuildKey({ ...input(), settings: { colorSpace: 'linear', mipmap: true } }),
    ).not.toBe(a);
    expect(
      semanticBuildKey({
        ...input(),
        sourceDependencies: [{ path: 'assets/a.png', digest: 'bbb' }],
      }),
    ).not.toBe(a);
  });

  it('is stable for object insertion order and GUID order', () => {
    const a = semanticBuildKey(input());
    const b = semanticBuildKey({
      ...input(),
      settings: { mipmap: true, colorSpace: 'srgb' },
      declaredGuids: [...input().declaredGuids].reverse(),
    });
    expect(a).toBe(b);
  });

  it('does not use path or publish fields as semantic identity', () => {
    const a = semanticBuildKey(input());
    const b = semanticBuildKey({
      ...input(),
      sourceDependencies: [{ path: 'moved/a.png', digest: 'aaa' }],
      publish: { base: '/other/', url: 'other/a.bin', hash: 'other-hash' },
    });
    expect(a).toBe(b);
  });

  it('normalizes host-specific asset roots for path-only dependencies', () => {
    const a = semanticBuildKey({
      ...input(),
      sourceDependencies: ['../../tmp/sample/assets/vfx/flow.png'],
    });
    const b = semanticBuildKey({
      ...input(),
      sourceDependencies: ['host-games/sample/assets/vfx/flow.png'],
    });
    expect(a).toBe(b);
  });

  it('invalidates changed source dependency evidence while ignoring order', () => {
    const a = semanticBuildKey({
      ...input(),
      sourceDependencies: [
        { path: 'assets/a.png', digest: 'aaa' },
        { path: 'assets/b.png', digest: 'bbb' },
      ],
    });
    const reordered = semanticBuildKey({
      ...input(),
      sourceDependencies: [
        { path: 'assets/b.png', digest: 'bbb' },
        { path: 'assets/a.png', digest: 'aaa' },
      ],
    });
    expect(reordered).toBe(a);
    expect(
      semanticBuildKey({
        ...input(),
        sourceDependencies: [
          { path: 'assets/a.png', digest: 'changed' },
          { path: 'assets/b.png', digest: 'bbb' },
        ],
      }),
    ).not.toBe(a);
  });
});
