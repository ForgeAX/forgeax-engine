import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { generatedPlayerQueries } from './generated-player-queries.js';

describe('generated Worker startup URLs', () => {
  it.each([
    ['/', 'https://game.test/', 'https://game.test/shaders/manifest.json'],
    ['./', 'https://game.test/', 'https://game.test/shaders/manifest.json'],
    [
      './',
      'https://game.test/play/frontline/',
      'https://game.test/play/frontline/shaders/manifest.json',
    ],
    [
      '/play/frontline/',
      'https://game.test/play/frontline/',
      'https://game.test/play/frontline/shaders/manifest.json',
    ],
    [
      'https://cdn.test/frontline/',
      'https://game.test/play/frontline/',
      'https://cdn.test/frontline/shaders/manifest.json',
    ],
  ])('preserves deployment base %s from %s across realms', async (base, documentUrl, manifestUrl) => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-urls-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"name":"worker-urls","type":"module"}');
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'worker-urls',
          name: 'Worker URLs',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      );
      const facts = await readProjectFacts(root);
      if (!facts.ok) throw facts.error;
      const config = await createViteConfig(facts.value, 'build', base);
      const generated = await readFile(resolve(config.root ?? '', 'main.ts'), 'utf8');
      const setupStart = generated.indexOf('const assetCatalog = createCatalogSource(');
      const setupEnd = generated.indexOf('const assetPreparation =', setupStart);
      const callStart = generated.indexOf('const result = await createApp(');
      const callEnd = generated.indexOf('if (!result.ok)', callStart);
      expect(setupStart).toBeGreaterThan(0);
      expect(setupEnd).toBeGreaterThan(setupStart);
      expect(callStart).toBeGreaterThan(setupEnd);
      expect(callEnd).toBeGreaterThan(callStart);

      // Build the real virtual adapter through Vite's BASE_URL transform. Only
      // its resolve/load hooks are needed; this URL gate does not cook shaders.
      const shader = forgeaxShader() as unknown as {
        resolveId(id: string): string | null;
        load(id: string): string | null;
      };
      const entry = resolve(root, 'adapter-entry.ts');
      await writeFile(entry, "export { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';");
      const output = await viteBuild({
        configFile: false,
        root,
        base,
        logLevel: 'silent',
        plugins: [
          {
            name: 'worker-url-adapter',
            resolveId: (id) => shader.resolveId(id),
            load: (id) => shader.load(id),
          },
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry, name: 'Adapter', formats: ['iife'] },
        },
      });
      const bundle = Array.isArray(output) ? output[0] : output;
      if (bundle === undefined || !('output' in bundle))
        throw new Error('expected one Vite output');
      const chunk = bundle.output.find((entry) => entry.type === 'chunk');
      if (chunk?.type !== 'chunk') throw new Error('adapter chunk missing');
      const moduleUrl = new URL('assets/main.js', new URL(base, documentUrl)).href;
      const source = `${chunk.code}\nconst forgeaxBundlerAdapter = Adapter.forgeaxBundlerAdapter;
        (async () => {
          ${generatedPlayerQueries(generated)}
          ${generated.slice(setupStart, setupEnd)}
          ${generated.slice(callStart, callEnd)}
          return { ...result, assetCatalog };
        })()`
        .replaceAll('import.meta.env.DEV', 'false')
        .replaceAll('import.meta.hot', 'undefined')
        .replaceAll('import.meta.url', JSON.stringify(moduleUrl));
      const executionWorkers = { engine: true, render: true, kernels: false };
      // One generated player and one built adapter serve every query. Changing
      // the lane must not change Worker selection or any startup resource URL.
      for (const search of [
        '',
        '?forgeax-geometry-lane=automatic',
        '?forgeax-geometry-lane=direct',
        '?forgeax-geometry-lane=invalid',
      ]) {
        const captured = await runInNewContext(source, {
          URL,
          URLSearchParams,
          location: new URL(search, documentUrl),
          bootstrapRoot: 'project-bootstrap',
          document: { baseURI: documentUrl, body: {}, querySelector: () => null },
          canvas: {},
          animation: {},
          workerExecution: true,
          executionWorkers,
          runtimeScopeBinding: { scopeId: 'url-test', catalogUrl: '/__pack/catalog.json' },
          programDeliveryChannel: 'url-test',
          gameChannel: undefined,
          pointerLockAllowed: undefined,
          createCatalogSource: (options: unknown) => options,
          createApp: (_canvas: unknown, options: unknown, bundler: unknown) => ({
            options,
            bundler,
          }),
        });
        expect(captured.options.execution.workers).toBe(executionWorkers);
        expect(captured.options).not.toHaveProperty('geometryLane');
        if (search === '?forgeax-geometry-lane=direct')
          expect(captured.options.execution.diagnostics).toHaveProperty('geometryLane', 'direct');
        else expect(captured.options.execution.diagnostics).not.toHaveProperty('geometryLane');
        expect(captured.bundler.shaderManifestUrl).toBe(manifestUrl);
        expect(captured.bundler.importTransport).toBeUndefined();
        expect(captured.options.execution.bootstrap.href).toBe(
          new URL('execution-bootstrap.ts', moduleUrl).href,
        );
        expect(captured.options.execution.assetCatalog.url).toBe(
          new URL('pack-index.json', documentUrl).href,
        );
        expect(captured.assetCatalog.url).toBe(captured.options.execution.assetCatalog.url);
        // A nested Engine or Render Worker must fetch the same resource identity.
        expect(
          new URL(
            captured.bundler.shaderManifestUrl,
            new URL('assets/render-worker.js', documentUrl),
          ).href,
        ).toBe(manifestUrl);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
