import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { build, type Plugin } from 'vite';
import { afterEach, expect, it } from 'vitest';
import { discoverPluginAssets } from '../plugin-assets.js';
import { pluginProgramsBuild, pluginRuntimeProjection } from '../plugin-programs.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function playerBuild(source: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-boundary-'));
  roots.push(root);
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  await writeFile(resolve(root, 'entry.js'), source);
  const inventory = await discoverPluginAssets({ root, assetRoots: [] });
  return build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      pluginProgramsBuild({
        projectRoot: root,
        roots: {},
        inventory: async () => inventory,
        binding: createStandaloneRuntimeAssetBinding('test'),
        // No virtual program module is requested: the production bundle guard
        // must still validate the page and Worker graph it is attached to.
        pack: {} as PluginPack,
      }),
    ],
    build: { write: false, minify: false, target: 'esnext', rollupOptions: { input: 'entry.js' } },
  });
}

it('delivers the browser runtime producer through the existing player bundle guard', async () => {
  const output = await playerBuild(
    "import { RuntimePackProducer } from '@forgeax/engine/import'; globalThis.Producer = RuntimePackProducer;",
  );
  if (Array.isArray(output) || !('output' in output)) throw new Error('missing bundle');
  const chunks = output.output.flatMap((item) => (item.type === 'chunk' ? [item] : []));
  expect(chunks.some((chunk) => chunk.code.includes('RuntimePackProducer'))).toBe(true);
  expect(chunks.flatMap((chunk) => Object.keys(chunk.modules))).toContainEqual(
    expect.stringContaining('/import/dist/browser.mjs'),
  );
});

it('rejects a Node import even when Vite has replaced it with a browser stub', async () => {
  await expect(
    playerBuild("import fs from 'node:fs'; globalThis.read = () => fs.readFileSync('asset');"),
  ).rejects.toThrow(/Node dependency/);
});

it('accepts late resolved inputs, hashes authored bytes, and rejects later source changes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-source-fence-'));
  roots.push(root);
  // Vite reports canonical module IDs on macOS, where /var is a symlink to
  // /private/var. Match the real project root and source snapshot identities
  // produced by readProjectFacts/discoverPluginAssets.
  const canonicalRoot = await realpath(root);
  const entry = resolve(canonicalRoot, 'entry.js');
  const resolved = resolve(canonicalRoot, 'dist/modules/command-executor.mjs');
  const entrySource =
    "import { value } from './dist/modules/command-executor.mjs'; globalThis.pluginValue = value; globalThis.rawPluginValue = 1;";
  const resolvedSource = 'export const value = 1;';
  await mkdir(resolve(canonicalRoot, 'dist/modules'), { recursive: true });
  await writeFile(resolved, resolvedSource);
  await writeFile(entry, entrySource);
  const digest = (source: string | Uint8Array) =>
    `sha256:${createHash('sha256').update(source).digest('hex')}`;
  const sourceInputs = new Map([[entry, digest(await readFile(entry))]]);
  const captureResolvedInputs = {
    name: 'fixture:late-resolved-input-capture',
    buildStart() {
      sourceInputs.set(resolved, digest(resolvedSource));
    },
  };
  const compile = (transform?: Plugin) =>
    build({
      root: canonicalRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        captureResolvedInputs,
        ...(transform ? [transform] : []),
        pluginRuntimeProjection(canonicalRoot, sourceInputs),
      ],
      build: { write: false, minify: false, target: 'esnext', rollupOptions: { input: entry } },
    });
  const output = await compile();
  if (Array.isArray(output) || !('output' in output)) throw new Error('missing bundle');
  expect(
    output.output.some((item) => item.type === 'chunk' && item.code.includes('pluginValue = 1')),
  ).toBe(true);
  const transformed = await compile({
    name: 'fixture-prior-transform',
    enforce: 'pre',
    transform(code: string, id: string) {
      return id.split('?')[0]?.replaceAll('\\', '/').endsWith('/entry.js')
        ? code.replace('rawPluginValue = 1', 'rawPluginValue = 3')
        : null;
    },
  });
  if (Array.isArray(transformed) || !('output' in transformed))
    throw new Error('missing transformed bundle');
  expect(
    transformed.output.some(
      (item) => item.type === 'chunk' && item.code.includes('rawPluginValue = 3'),
    ),
  ).toBe(true);
  await writeFile(
    entry,
    "import { value } from './dist/modules/command-executor.mjs'; globalThis.pluginValue = value; globalThis.rawPluginValue = 2;",
  );
  await expect(compile()).rejects.toThrow(/source changed/);
});
