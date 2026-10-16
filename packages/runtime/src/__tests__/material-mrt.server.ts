import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer } from 'vite';

export async function startMaterialMrtServer() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-mrt-'));
  const assets = join(root, 'assets');
  await mkdir(assets);
  const packageId = '019a0000-0000-7000-8000-000000000155';
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok) throw parsed.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'material/main'));
  await writeFile(
    join(assets, 'mrt.wgsl'),
    `#define_import_path game::mrt
#import forgeax_view::common::{view, meshes}
#import forgeax_material::parameters::{material}
struct Outputs {
 @location(0) color: vec4<f32>, @location(1) id: u32,
 @location(2) mask: vec4<f32>, @location(3) data: vec4<f32>,
}
@vertex fn vs_main(@location(0) p: vec3<f32>, @builtin(instance_index) idx: u32) -> @builtin(position) vec4<f32> {
 return view.worldViewProj * meshes[idx].worldFromLocal * vec4<f32>(p, 1.0);
}
@fragment fn fs_main() -> Outputs {
 return Outputs(vec4<f32>(0.25, 0.5, 0.75, 1.0), material.objectId, vec4<f32>(0.75, 0.0, 0.0, 1.0), vec4<f32>(-2.0, 0.125, 4.0, 1.0));
}
`,
  );
  const material = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'game::mrt' },
        outputs: [
          {
            name: 'color',
            format: 'rgba16float',
            blend: {
              color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
            },
          },
          { name: 'objectId', format: 'r32uint' },
          { name: 'mask', format: 'rgba8unorm', writeMask: 1 },
          { name: 'data', format: 'rgba16float' },
        ],
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    parameters: [{ name: 'objectId', type: 'u32', default: 123456789 }],
    values: { objectId: 123456789 },
  };
  await writeFile(
    join(assets, 'mrt.pack.ts'),
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'), build() { return ok({ 'material/main': ${JSON.stringify(material)} }); } });`,
  );
  const binding = createStandaloneRuntimeAssetBinding('material-mrt');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      pluginPack({
        roots: [assets],
        runtimeBinding: binding,
        producerReadiness: 'on-demand',
        cookers: [createMaterialPackCooker([assets])],
        ddc: { projectDdcRoot: join(root, '.ddc') },
      }),
    ],
    server: { host: '127.0.0.1', port: 0, cors: true },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('MRT fixture has no HTTP listener');
  return {
    guid,
    binding: {
      ...binding,
      catalogUrl: new URL(binding.catalogUrl, url).href,
      importUrlBase: new URL(binding.importUrlBase, url).href,
    },
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
