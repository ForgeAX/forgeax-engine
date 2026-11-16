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

  function rootsFor(files: string[], entry = 'vitest.mjs') {
    const argv = process.argv;
    try {
      process.argv = [process.execPath, entry, 'run', ...files];
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

  it('preserves exact Browser selection through the maintained project runner', () => {
    const entry = resolve(process.cwd(), 'scripts/ci/run-vitest-projects.mjs');
    expect(rootsFor(directFixtures, entry)).toEqual([]);
  });

  it('keeps the maintained project runner optimizer scoped to its actual target', () => {
    const argv = process.argv;
    const file = 'packages/runtime/src/__tests__/forward-gtao-webgl2.browser.test.ts';
    try {
      process.argv = [
        process.execPath,
        resolve(process.cwd(), 'scripts/ci/run-vitest-projects.mjs'),
        'run',
        '--project=browser',
        file,
      ];
      const project = createBrowserProject();
      expect(project.test.include).toEqual([file]);
      expect(project.optimizeDeps.entries).not.toContain(
        'apps/parity/color-lighting/src/compare/lighting-reference.ts',
      );
      expect(project.optimizeDeps.include).not.toContain('ajv/dist/2020.js');
    } finally {
      process.argv = argv;
    }
  });

  it('does not interpret unrelated runner arguments as Browser selection', () => {
    const entry = resolve(process.cwd(), 'scripts/ci/unrelated-runner.mjs');
    expect(rootsFor(directFixtures, entry)).toContain(
      resolve(process.cwd(), 'apps/learn-render/1.getting-started/4.textures/assets'),
    );
  });

  it('includes the referenced Water recipe and terrain closure in the Surface-only scope', async () => {
    const previous = process.env.FORGEAX_BROWSER_SURFACE_ONLY;
    const argv = process.argv;
    try {
      process.env.FORGEAX_BROWSER_SURFACE_ONLY = '1';
      process.argv = [
        process.execPath,
        'vitest.mjs',
        'run',
        'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts',
      ];
      vi.resetModules();
      const { createBrowserProject: createSurfaceProject } = await import(
        '../../config/vitest-browser-project'
      );
      createSurfaceProject();
      expect(packPreparation.roots).toEqual(
        [
          'templates/game-3d/assets/materials.pack.ts',
          'apps/preview/assets/surface-standard-evidence.pack.ts',
          'apps/preview/assets/surface-water-splash-material.pack.json',
          'apps/preview/assets/surface-water-splash.pack.json',
          'apps/preview/assets/water-r0-recipes.pack.ts',
          'apps/preview/assets/water-r0-base-terrain.pack.ts',
        ].map((path) => resolve(process.cwd(), path)),
      );
    } finally {
      process.argv = argv;
      if (previous === undefined) delete process.env.FORGEAX_BROWSER_SURFACE_ONLY;
      else process.env.FORGEAX_BROWSER_SURFACE_ONLY = previous;
    }
  });

  it.each([
    { files: [] },
    { files: ['packages/ui-blitz'] },
    {
      files: [
        ...directFixtures,
        'apps/learn-render/1.getting-started/4.textures/src/__tests__/onerror-gate.browser.test.ts',
      ],
    },
  ])('retains ordinary Renderer roots for broad or mixed selectors $files', ({ files }) => {
    expect(rootsFor(files)).toContain(
      resolve(process.cwd(), 'apps/learn-render/1.getting-started/4.textures/assets'),
    );
  });
});
