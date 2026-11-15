import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { expect, it } from 'vitest';
import { workspacePackCookPlugin } from '../workspace-pack-cook';

const packageId = '01900000-0000-7000-8000-000000000051';
const textureGuid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'texture/body'));

it('prepares mixed texture and build-only material outputs with the serving project cooker', async () => {
  let called = false;
  const plugin = workspacePackCookPlugin([
    {
      key: 'cloud-material',
      cook(input: { guid: string; sourcePath: string; source: { texture: string } }) {
        called = true;
        expect(input.sourcePath).toBe('/project/clouds.pack.ts');
        expect(input.source.texture).toBe(textureGuid);
        return {
          guid: input.guid,
          payload: { kind: 'cloud-material', version: 1, texture: textureGuid },
          refs: [textureGuid],
          inputFingerprint: 'fixture-v1',
          artifacts: { shader: { mediaType: 'text/wgsl', bytes: new Uint8Array([1, 2, 3]) } },
        };
      },
    },
  ]);
  const content = await plugin.prepareContent({
    packageId,
    sourcePath: '/project/clouds.pack.ts',
    signal: new AbortController().signal,
    dependencies: {},
    outputs: {
      'texture/body': {
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        mips: { kind: 'none' },
        data: new Uint8Array([20, 40, 60, 255]),
      },
      'material/cloud': {
        kind: 'cloud-material',
        execution: 'cooked',
        source: { texture: textureGuid },
      },
    },
  });
  expect(called).toBe(true);
  expect('assets' in content.source).toBe(true);
  if (!('assets' in content.source)) return;
  expect(Object.keys(content.source.assets).sort()).toEqual(['material/cloud', 'texture/body']);
  const material = content.source.assets['material/cloud'];
  if (!material) throw new Error('Missing cooked material');
  expect(material.refs).toContain(textureGuid);
  expect(material.payload).toMatchObject({ version: 1, texture: textureGuid });
  const shader = material.artifacts?.shader;
  expect(shader).toMatchObject({
    byteLength: 3,
    mediaType: 'text/wgsl',
    integrity: { algorithm: 'sha256' },
  });
  expect(content.blobs?.[shader?.path as string]).toEqual(new Uint8Array([1, 2, 3]));
});

it('preserves missing-cooker failure and rejects cancelled candidates', async () => {
  const plugin = workspacePackCookPlugin([]);
  const input = {
    packageId,
    sourcePath: '/project/clouds.pack.ts',
    dependencies: {},
    signal: new AbortController().signal,
    outputs: {
      'material/cloud': { kind: 'cloud-material', execution: 'cooked' as const, source: {} },
    },
  };
  await expect(plugin.prepareContent(input)).rejects.toBeDefined();
  const controller = new AbortController();
  controller.abort(new Error('candidate retired'));
  await expect(plugin.prepareContent({ ...input, signal: controller.signal })).rejects.toThrow(
    'candidate retired',
  );
});

it('does not silently drop plugin siblings from mixed cooked drafts', async () => {
  await expect(
    workspacePackCookPlugin([]).prepareContent({
      packageId,
      sourcePath: '/project/mixed.pack.ts',
      signal: new AbortController().signal,
      dependencies: {},
      outputs: {
        'plugin/game': { kind: 'plugin', module: { specifier: './game.ts', export: 'default' } },
        'material/cloud': { kind: 'cloud-material', execution: 'cooked', source: {} },
      },
    }),
  ).rejects.toMatchObject({
    code: 'pack-source-output-invalid',
    detail: { sourceKey: 'plugin/game' },
  });
});

it('rejects a candidate cancelled while the project cooker is running', async () => {
  const controller = new AbortController();
  const plugin = workspacePackCookPlugin([
    {
      key: 'cloud-material',
      async cook(input: { guid: string }) {
        await Promise.resolve();
        controller.abort(new Error('candidate retired during cook'));
        return {
          guid: input.guid,
          payload: { kind: 'cloud-material' },
          refs: [],
          inputFingerprint: 'fixture-v1',
          artifacts: {},
        };
      },
    },
  ]);
  await expect(
    plugin.prepareContent({
      packageId,
      sourcePath: '/project/clouds.pack.ts',
      dependencies: {},
      signal: controller.signal,
      outputs: { 'material/cloud': { kind: 'cloud-material', execution: 'cooked', source: {} } },
    }),
  ).rejects.toThrow('candidate retired during cook');
});
