import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAssetSource } from '../resolve-asset-source.js';

describe('resolveAssetSource — companion and sidecar-relative sources', () => {
  const metaDir = '/project/assets';

  it('derives an omitted source from the companion filename', () => {
    const metaPath = resolve(metaDir, 'foo.png.meta.json');
    expect(resolveAssetSource(metaPath, undefined)).toBe(resolve(metaDir, 'foo.png'));
  });

  it('supports every ordinary companion extension without a special table', () => {
    const cases = [
      { meta: 'model.glb.meta.json', expected: 'model.glb' },
      { meta: 'sprite.png.meta.json', expected: 'sprite.png' },
      { meta: 'font.ttf.meta.json', expected: 'font.ttf' },
      { meta: 'bgm.mp3.meta.json', expected: 'bgm.mp3' },
    ];
    for (const { meta, expected } of cases) {
      expect(resolveAssetSource(resolve(metaDir, meta), undefined)).toBe(
        resolve(metaDir, expected),
      );
    }
  });

  it('resolves an explicit source relative to its sidecar', () => {
    const metaPath = resolve(metaDir, 'foo.png.meta.json');
    expect(resolveAssetSource(metaPath, 'sub/foo.png')).toBe(resolve(metaDir, 'sub/foo.png'));
  });

  it('keeps source resolution independent of package.json and path aliases', () => {
    const metaPath = resolve(metaDir, 'foo.png.meta.json');
    expect(resolveAssetSource(metaPath, '@shared/foo.png')).toBe(
      resolve(metaDir, '@shared/foo.png'),
    );
  });
});
