import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, definePackageId, PackageId } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { afterEach, expect, it } from 'vitest';
import { createDefaultCloudCookers } from '../cloud-cookers.js';
import { createViteConfig } from '../host.js';
import { type WorkspacePackCookPlugin, workspacePackCookPlugin } from '../workspace-pack-cook.js';

const roots: string[] = [];
const packageId = '019a50a5-0000-7000-8000-000000000001';
const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'cloud'));
const parameters = { density: { kind: 'scalar', unit: 'm^-1', default: 0.00012 } };
const source = { version: 1, model: { kind: 'program', source: 'cloud.wgsl' }, parameters };
const program = `fn evaluateCloudMedium(context: CloudMediumContext, parameters: CloudParameters) -> CloudMediumSample {
  return CloudMediumSample(parameters.density, vec3f(0.8), vec3f(0.0), 1.0);
}`;

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-cloud-cook-')));
  roots.push(root);
  const sourcePath = resolve(root, 'cloud.pack.ts');
  await writeFile(sourcePath, '// Pack source');
  await writeFile(resolve(root, 'cloud.wgsl'), program);
  return { root, sourcePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('cooks the shipped Render example in the ordinary dev host without a project build root', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-cloud-example-')));
  roots.push(root);
  const example = resolve(import.meta.dirname, '../../../render/examples/volumetric-clouds');
  await cp(example, root, { recursive: true });
  const sourcePath = resolve(root, 'cloud.pack.ts');
  await symlink(
    resolve(import.meta.dirname, '../../../..', 'node_modules'),
    resolve(root, 'node_modules'),
    'dir',
  );
  const packageJson = { type: 'module', dependencies: { '@forgeax/engine': 'workspace:*' } };
  await writeFile(resolve(root, 'package.json'), JSON.stringify(packageJson));
  const definition = (await loadScriptablePack(sourcePath)).unwrap();
  const built = await definition.build({
    packageId: definition.packageId,
    values: {},
    readByGuid: async () => {
      throw new Error('The cloud example is self-contained');
    },
  });
  if (!built.ok) throw built.error;
  const config = await createViteConfig(
    {
      root,
      id: 'cloud-fixture',
      name: 'Cloud fixture',
      packageJson,
      assetRoots: ['.'],
      assetLibraries: [],
      roots: {},
    },
    'serve',
  );
  const plugins = (config.plugins ?? []) as Array<{
    name: string;
    closeBundle?: () => Promise<void>;
  }>;
  try {
    const cook = plugins.find(
      (plugin) => plugin.name === 'forgeax:workspace-pack-cook',
    ) as WorkspacePackCookPlugin;
    const content = await cook.prepareContent({
      packageId: PackageId.format(definition.packageId),
      sourcePath,
      dependencies: {},
      signal: new AbortController().signal,
      outputs: built.value,
    });
    if (!('assets' in content.source)) throw new Error('Expected direct Pack');
    const assets = content.source.assets;
    expect(assets.cloud?.payload).toMatchObject({
      variants: [
        { staticValues: { detail: false }, renderer: expect.any(Object) },
        { staticValues: { detail: true }, renderer: expect.any(Object) },
      ],
    });
    const materialGuid = AssetGuid.format(AssetGuid.derive(definition.packageId, 'cloud'));
    expect(assets.light?.refs).toContain(materialGuid);
    expect(assets.light?.payload).toMatchObject({ overrides: { density: 0.00022, detail: false } });
    expect(assets.dense?.refs).toContain(materialGuid);
    expect(assets.dense?.payload).toMatchObject({ overrides: { density: 0.0012, detail: true } });
  } finally {
    await plugins.find((plugin) => plugin.name === 'forgeax:project-session')?.closeBundle?.();
  }
}, 30_000);

it('publishes cloud material and instance artifacts through the ordinary Pack producer', async () => {
  const { sourcePath } = await fixture();
  const content = await workspacePackCookPlugin(createDefaultCloudCookers()).prepareContent({
    packageId,
    sourcePath,
    outputs: {
      cloud: { kind: 'cloud-material', execution: 'cooked', source },
      instance: {
        kind: 'cloud-material-instance',
        execution: 'cooked',
        source: {
          version: 1,
          material: guid,
          parameters,
          overrides: { density: 0.0002 },
        },
      },
    },
    dependencies: {},
    signal: new AbortController().signal,
  });
  if (!('assets' in content.source)) throw new Error('Expected direct Pack');
  const material = content.source.assets.cloud;
  expect(material?.payload).toMatchObject({ variants: [{ renderer: expect.any(Object) }] });
  expect(Object.keys(material?.artifacts ?? {})).toEqual(['renderer-0.wgsl', 'program-0.wgsl']);
  expect(content.source.assets.instance?.refs).toContain(guid);
  expect(content.source.assets.instance?.payload).toMatchObject({ overrides: { density: 0.0002 } });
});

it('recooks WGSL-only edits and reads a supplied source snapshot for every shader input', async () => {
  const { root, sourcePath } = await fixture();
  const inputs = new Map<string, string>();
  const [captured] = createDefaultCloudCookers(async (path) => {
    let text = inputs.get(path);
    if (text === undefined) {
      text = await readFile(path, 'utf8');
      inputs.set(path, text);
    }
    return text;
  });
  const input = { guid, sourcePath, source };
  const first = await captured.cook(input);
  const wgsl = resolve(root, 'cloud.wgsl');
  expect(first.sourceDependencies).toContain(wgsl);
  expect([...inputs.keys()].some((path) => path.endsWith('cloud/medium.wgsl'))).toBe(true);
  await writeFile(wgsl, program.replace('vec3f(0.8)', 'vec3f(0.4)'));
  expect((await captured.cook(input)).inputFingerprint).toBe(first.inputFingerprint);
  const [current] = createDefaultCloudCookers();
  const changed = await current.cook(input);
  expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
  expect(changed.artifacts['renderer-0.wgsl']?.bytes).not.toEqual(
    first.artifacts['renderer-0.wgsl']?.bytes,
  );
});

it('rejects missing, invalid and symlink-escaped sources without hiding the original cause', async () => {
  const { root, sourcePath } = await fixture();
  const [cooker] = createDefaultCloudCookers();
  const input = { guid, sourcePath, source };
  await rm(resolve(root, 'cloud.wgsl'));
  await expect(cooker.cook(input)).rejects.toThrow('ENOENT');
  await writeFile(resolve(root, 'cloud.wgsl'), 'fn evaluateCloudMedium(');
  await expect(cooker.cook(input)).rejects.toThrow('cloud-program-invalid');
  const outside = await fixture();
  await rm(resolve(root, 'cloud.wgsl'));
  await symlink(resolve(outside.root, 'cloud.wgsl'), resolve(root, 'cloud.wgsl'));
  await expect(cooker.cook(input)).rejects.toThrow('Cloud WGSL must stay beside its Pack source');
});
