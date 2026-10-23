import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EngineContent } from '@forgeax/engine-content';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

const engineRoot = resolve(import.meta.dirname, '../../../engine');
const contentAssets = resolve(import.meta.dirname, '../../../content/assets');
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project with the workspace Engine installed and one bare-name library under node_modules. */
async function project(assetLibraries?: readonly string[]): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-asset-libraries-'));
  roots.push(root);
  const kit = resolve(root, 'node_modules/studio-kit');
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await mkdir(resolve(kit, 'kit'), { recursive: true });
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engineRoot, resolve(root, 'node_modules/@forgeax/engine'), 'dir');
  await Promise.all([
    writeFile(resolve(root, 'package.json'), '{"name":"library-game","type":"module"}'),
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'library-game',
        name: 'Library game',
        roots: {},
        ...(assetLibraries === undefined ? {} : { assetLibraries }),
      }),
    ),
    writeFile(
      resolve(kit, 'package.json'),
      JSON.stringify({ name: 'studio-kit', forgeax: { library: { assetRoot: 'kit' } } }),
    ),
    writeFile(
      resolve(kit, 'kit/kit.pack.ts'),
      `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
       import { ok } from '@forgeax/engine/types';
       export default definePack({ schemaVersion: '2.0.0', name: 'Kit',
         packageId: definePackageId('019fc0e7-3000-7000-8000-000000000001'),
         build: () => ok({ 'sampler/kit': { kind: 'sampler', magFilter: 'linear' } }) });`,
    ),
  ]);
  return root;
}

async function catalogRows(
  root: string,
): Promise<readonly { readonly guid: string; readonly sourcePath?: string }[]> {
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw facts.error;
  let server: ViteDevServer | undefined;
  try {
    const config = await createViteConfig(facts.value, 'serve', '/', {
      server: { port: await allocateLoopbackPort(), strictPort: true },
    });
    server = await createServer(config);
    await server.listen();
    const producer = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:pack',
    ) as unknown as {
      ready(): Promise<void>;
      catalogSnapshot(): readonly { readonly guid: string; readonly sourcePath?: string }[];
    };
    await producer.ready();
    return producer.catalogSnapshot();
  } finally {
    await server?.close();
  }
}

const contentGuids = [
  ...Object.values(EngineContent.meshes),
  EngineContent.textures.checker,
  EngineContent.samplers.checker,
  EngineContent.materials.default,
];

describe('forge.json assetLibraries', () => {
  it('resolves Engine facades and bare packages to their declared library roots', async () => {
    const root = await project(['@forgeax/engine/content', 'studio-kit']);
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    expect(facts.value.assetLibraries).toEqual([
      { specifier: '@forgeax/engine/content', root: await realpath(contentAssets) },
      {
        specifier: 'studio-kit',
        root: await realpath(resolve(root, 'node_modules/studio-kit/kit')),
      },
    ]);
  });

  it('reports unresolved and non-library specifiers as structured project failures', async () => {
    for (const [specifier, code] of [
      ['@forgeax/engine/does-not-exist', 'project-asset-library-unresolved'],
      ['missing-kit', 'project-asset-library-unresolved'],
      ['@forgeax/engine/geometry', 'project-asset-library-invalid'],
    ] as const) {
      const result = await readProjectFacts(await project([specifier]));
      expect(result, specifier).toMatchObject({
        ok: false,
        error: { code, detail: { specifier } },
      });
    }
  });

  it('catalogs mounted library assets under their specifier identities only when declared', async () => {
    const mounted = await catalogRows(await project(['@forgeax/engine/content', 'studio-kit']));
    for (const guid of contentGuids) {
      const row = mounted.find((entry) => entry.guid === guid);
      expect(row?.sourcePath, guid).toMatch(/^@forgeax\/engine\/content\/[a-z-]+\.pack\.ts$/);
    }
    expect(mounted.some((entry) => entry.sourcePath === 'studio-kit/kit.pack.ts')).toBe(true);

    const plain = await catalogRows(await project());
    expect(plain.filter((entry) => contentGuids.includes(entry.guid))).toEqual([]);
    expect(plain.some((entry) => entry.sourcePath?.startsWith('studio-kit/'))).toBe(false);
  }, 120_000);
});
