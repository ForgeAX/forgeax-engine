import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserProject } from '../../config/vitest-browser-project';

const packPreparation = vi.hoisted(() => ({ roots: [] as readonly string[] }));
vi.mock('@forgeax/engine-vite-plugin-pack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-vite-plugin-pack')>()),
  pluginPack: (options: { roots: readonly string[] }) => {
    packPreparation.roots = options.roots;
    return { name: 'capture-browser-pack-roots' };
  },
}));

const browserProjectSource = resolve(process.cwd(), 'config/vitest-browser-project.ts');

describe('shared browser shader manifest', () => {
  it('keeps the point-shadow engine entry in the real browser manifest owner', () => {
    const source = readFileSync(browserProjectSource, 'utf8');
    expect(source).toMatch(
      /forgeaxShader\(\{\s*engineEntries:\s*\{\s*pointShadows:\s*true,\s*hdrpSsao:\s*true\s*\},\s*materialPackages\s*\}\)/,
    );
  });
});

describe('explicit Browser Pack preparation', () => {
  const directFixtures = [
    'packages/ui-blitz/src/__tests__/browser-extension.browser.test.ts',
    'packages/ui-blitz/src/__tests__/dom.browser.test.ts',
    'packages/ui-blitz/src/__tests__/range.browser.test.ts',
    'packages/ui-blitz/src/__tests__/select.browser.test.ts',
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ];

  function rootsFor(files: string[]) {
    const argv = process.argv;
    try {
      process.argv = [process.execPath, 'vitest.mjs', 'run', ...files];
      createBrowserProject();
      return packPreparation.roots;
    } finally {
      process.argv = argv;
    }
  }

  it.each(directFixtures)('does not cook Renderer Packs for the direct fixture %s', (file) => {
    expect(rootsFor([file])).toEqual([]);
  });

  it('preserves the complete direct-fixture cohort without foreign Pack preparation', () => {
    expect(rootsFor(directFixtures)).toEqual([]);
  });

  it.each([
    { files: [] },
    { files: ['packages/ui-blitz'] },
    {
      files: [
        ...directFixtures,
        'packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts',
      ],
    },
  ])('retains ordinary Renderer roots for broad or mixed selectors $files', ({ files }) => {
    expect(rootsFor(files)).toContain(
      resolve(process.cwd(), 'apps/learn-render/1.getting-started/4.textures/assets'),
    );
  });
});
