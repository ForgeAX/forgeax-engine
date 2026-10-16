import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoots = ['packages/pack/src', 'packages/vite-plugin-pack/src', 'packages/render/src'];

describe('Surface consumer census', () => {
  it('keeps the runtime and Pack consumers on the existing MaterialAsset wire', async () => {
    const sources = await Promise.all(
      packageRoots.map(async (root) => {
        const path = resolve(process.cwd(), root, 'index.ts');
        try {
          return await readFile(path, 'utf8');
        } catch {
          return '';
        }
      }),
    );
    const source = sources.join('\n');
    expect(source).not.toContain('SurfaceAsset');
    expect(source).not.toContain('surfaceModule');
    expect(source).not.toContain('shadingModel');
  });
});
