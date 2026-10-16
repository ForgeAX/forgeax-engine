import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { Context, startPluginAsset } from '@forgeax/engine-plugin';
import { ok } from '@forgeax/engine-types';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

const namespace = '01900000-0000-7000-8000-000000008201';
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(definePackageId(namespace), key));

async function createEmptyWorkerProject(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-bootstrap-'));
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  await mkdir(resolve(root, 'assets'));
  await mkdir(resolve(root, 'docs'));
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(repositoryRoot, 'packages/engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'junction',
  );
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'worker-bootstrap',
        name: 'Worker Bootstrap',
        schemaVersion: '3.0.0',
        roots: { host: guid('backend'), frontend: guid('ui'), engine: guid('probe') },
      }),
    ),
    writeFile(
      resolve(root, 'assets/programs.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: namespace,
        assets: Object.fromEntries(
          ['backend', 'ui', 'probe'].map((key) => [
            key,
            {
              kind: 'plugin',
              payload: { module: { specifier: `./${key}.ts` } },
            },
          ]),
        ),
      }),
    ),
    writeFile(
      resolve(root, 'package.json'),
      '{"name":"worker-bootstrap","type":"module","dependencies":{"@forgeax/engine":"workspace:*"}}',
    ),
    writeFile(resolve(root, 'README.md'), '# Worker Bootstrap\n'),
    writeFile(resolve(root, 'docs/feedback.md'), '# Feedback\n'),
    writeFile(
      resolve(root, 'assets/backend.ts'),
      `import 'node:fs'; throw new Error('backend must not execute in a browser');`,
    ),
    writeFile(resolve(root, 'assets/ui.ts'), `export default { name: 'browser-ui', apply() {} };`),
    writeFile(
      resolve(root, 'assets/probe.ts'),
      `import { Context } from '@forgeax/engine/plugin';
const child = {
  name: 'production-probe-child',
  inject: ['probeDependency'],
  apply(ctx) { ctx.provide('productionProbe', typeof Context === 'function' && ctx.probeDependency); },
};
export default {
  name: 'production-probe',
  apply(ctx) { ctx.plugin(child); },
};\n`,
    ),
  ]);
  return root;
}

describe('generated Engine Worker bootstrap production bundle', () => {
  it('executes the production bootstrap and its dynamic plugin imports without DOM globals', async () => {
    const root = await createEmptyWorkerProject();
    const outDir = resolve(root, 'dist');
    try {
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'build', '/', {
        outDir,
        sourcemap: 'hidden',
      });
      expect(config.build?.sourcemap).toBe('hidden');
      const generatedRoot = config.root;
      if (generatedRoot === undefined) throw new Error('generated root is missing');
      const generatedHost = await readFile(resolve(generatedRoot, 'main.ts'), 'utf8');
      const generatedBootstrap = await readFile(
        resolve(generatedRoot, 'execution-bootstrap.ts'),
        'utf8',
      );
      const identityJson = /ssrIdentity: (\{[^\n]+\}),/.exec(generatedBootstrap)?.[1];
      if (identityJson === undefined) throw new Error('generated SSR identity missing');
      const identity = JSON.parse(identityJson);
      expect(identity.sourceHead).toBe('project:worker-bootstrap');
      expect(generatedHost).toContain("'./execution-bootstrap.js'");
      expect(generatedHost).toContain('virtual:forgeax/plugin-programs/frontend');
      expect(generatedHost).not.toMatch(/import\([^)]*assets\/backend\.ts/);
      expect(generatedHost).toContain('virtual:forgeax/plugin-programs/engine');

      // Exercise the same generated bootstrap as a regular Rollup entry. The
      // page graph is intentionally omitted here so this regression remains a
      // focused, bounded production packaging check; createViteConfig above
      // still supplies the exact generated source and output contract.
      await viteBuild({
        configFile: false,
        root: generatedRoot,
        logLevel: 'warn',
        plugins: config.plugins ?? [],
        ...(config.resolve === undefined ? {} : { resolve: config.resolve }),
        build: {
          ...config.build,
          target: 'esnext',
          outDir,
          emptyOutDir: true,
          rollupOptions: {
            preserveEntrySignatures: 'strict',
            input: { 'execution-bootstrap': resolve(generatedRoot, 'execution-bootstrap.ts') },
            output: { entryFileNames: 'assets/execution-bootstrap.js' },
          },
        },
      });

      const files = await readdir(resolve(outDir, 'assets'));
      const sources = await Promise.all(
        files
          .filter((file) => /\.(?:js|mjs|ts)$/i.test(file))
          .map(
            async (file) =>
              [file, await readFile(resolve(outDir, 'assets', file), 'utf8')] as const,
          ),
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.some(([, source]) => source.includes('data:video/mp2t'))).toBe(false);
      expect(sources.some(([, source]) => source.includes('import type '))).toBe(false);
      expect(sources.some(([, source]) => /\bsatisfies\s+PluginCatalog/.test(source))).toBe(false);
      expect(sources.some(([, source]) => /from ['"]@forgeax\//.test(source))).toBe(false);
      expect(sources.every(([, source]) => !source.includes('sourceMappingURL='))).toBe(true);
      const probe = sources.find(([, source]) => source.includes('productionProbe'));
      expect(probe).toBeDefined();
      if (probe === undefined) throw new Error('authored probe was not emitted');
      const probeMap = JSON.parse(
        await readFile(resolve(outDir, 'assets', `${probe[0]}.map`), 'utf8'),
      );
      const offset = probe[1].indexOf('productionProbe');
      const before = probe[1].slice(0, offset).split('\n');
      const mapped = new SourceMap(probeMap).findEntry(
        before.length - 1,
        before.at(-1)?.length ?? 0,
      );
      if (!('originalSource' in mapped))
        throw new Error('authored probe source mapping is missing');
      expect(mapped.originalSource).toMatch(/\/assets\/probe\.ts$/);
      expect(mapped.originalLine).toBe(4);
      const authored = (await readFile(resolve(root, 'assets/probe.ts'), 'utf8')).split('\n')[4];
      if (authored === undefined) throw new Error('authored probe line is missing');
      expect(
        Math.abs(mapped.originalColumn - authored.indexOf('productionProbe')),
      ).toBeLessThanOrEqual(1);
      const bootstrap = sources.find(([file]) => file === 'execution-bootstrap.js');
      expect(bootstrap).toBeDefined();
      if (bootstrap === undefined) return;

      // Import the emitted module in Node and call its real default export;
      // source-shape assertions alone would not catch an entry that was
      // copied as raw TypeScript or tree-shaken into an empty chunk.
      const module = await import(pathToFileURL(resolve(outDir, 'assets', bootstrap[0])).href);
      const value = await module.default?.();
      expect(value?.ssrIdentity).toEqual(identity);
      expect(value?.plugins).toHaveLength(4);
      expect(value?.plugins).toContainEqual(expect.objectContaining({ name: 'forgeax:game-vfx' }));
      expect(value?.root?.guid).toBe(guid('probe'));
      const context = new Context();
      try {
        const inventory = await discoverPluginAssets(facts.value);
        context.provide('pluginPrograms', value.pluginPrograms);
        const readPluginDefinition = async (id: string) => {
          const definition = inventory.assets.get(id)?.definition;
          if (!definition) throw new Error('fixture definition missing');
          // The emitted program table owns the publication tuple for its payload.
          return ok({ ...definition, evidence: value.pluginPrograms.definitions.get(id) });
        };
        context.provide('assets', { readPluginDefinition });
        context.provide('probeDependency', true);
        const started = await startPluginAsset(context, value.root.guid);
        if (!started.ok) throw started.error;
        expect(context.get('productionProbe')).toBe(true);
      } finally {
        await context.fiber.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);

  it.each([
    {},
    { engine: true, render: false, kernels: false },
  ])('derives the production page and Worker entries from policy %j', async (workers) => {
    const root = await createEmptyWorkerProject();
    const previousTier = process.env.FORGEAX_EXECUTION_WORKERS;
    process.env.FORGEAX_EXECUTION_WORKERS = JSON.stringify(workers);
    try {
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) throw new Error(JSON.stringify(facts.error));
      const config = await createViteConfig(facts.value, 'build', './', {
        outDir: resolve(root, 'dist'),
      });
      const generatedRoot = config.root;
      if (generatedRoot === undefined) throw new Error('generated root is missing');
      const generatedHost = await readFile(resolve(generatedRoot, 'main.ts'), 'utf8');
      const generatedIndex = await readFile(resolve(generatedRoot, 'index.html'), 'utf8');
      expect(generatedIndex).toContain('id="forgeax-loading"');
      expect(generatedHost).toContain(`const executionWorkers = ${JSON.stringify(workers)}`);
      expect(generatedHost).toContain(
        "import.meta.env.DEV ? './execution-bootstrap.ts' : './execution-bootstrap.js'",
      );
      expect(config.build?.rollupOptions?.preserveEntrySignatures).toBe('strict');
      expect(config.build?.rollupOptions?.input).toEqual({
        index: resolve(generatedRoot, 'index.html'),
        'execution-bootstrap': resolve(generatedRoot, 'execution-bootstrap.ts'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousTier === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
      else process.env.FORGEAX_EXECUTION_WORKERS = previousTier;
    }
  });
});
