import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer } from 'vite';
import { installPackProject } from './helpers/pack-project';

export async function startOrdinaryLitDepthServer() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ordinary-lit-depth-'));
  await installPackProject(root, ['pack', 'types']);
  const assets = join(root, 'assets');
  await mkdir(assets);
  const packageId = '019a0000-0000-7000-8000-000000000159';
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok) throw parsed.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'material/main'));
  await writeFile(
    join(assets, 'lit-depth.wgsl'),
    `#define_import_path game::ordinary_lit_depth
#import forgeax_view::common::{view, meshes, instances}
#import forgeax_material::lighting_inputs::{skySh}
#import forgeax_pbr::sky_sh_polynomial::{evaluateSkyPolynomial}
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
struct VertexOut { @builtin(position) position: vec4<f32> }
@vertex fn vs_main(@location(0) p: vec3<f32>, @builtin(instance_index) idx: u32) -> VertexOut {
 let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(p, 1.0);
 return VertexOut(view.worldViewProj * world);
}
@fragment fn fs_main(v: VertexOut) -> @location(0) vec4<f32> {
 let depth = textureLoad(sceneDepth, vec2<i32>(v.position.xy), 0);
 let ambient = evaluateSkyPolynomial(skySh, vec3<f32>(0,1,0)).r;
 return vec4<f32>(select(1.0, 0.0, depth > 0.0), select(0.0, 1.0, depth > 0.0), ambient * .001, 1.0);
}
`,
  );
  const material = {
    kind: 'material',
    parameters: [],
    values: {},
    passes: [
      {
        name: 'Forward',
        program: {
          module: 'game::ordinary_lit_depth',
          bindings: 'render-lit-material-and-scene-depth',
          sceneDepth: 'before-pass',
        },
        renderState: {
          tags: { LightMode: 'Forward' },
          queue: 3000,
          depthWriteEnabled: false,
          cullMode: 'none',
        },
      },
    ],
  };
  await writeFile(
    join(assets, 'lit-depth.pack.ts'),
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'), build() { return ok({ 'material/main': ${JSON.stringify(material)} }); } });`,
  );
  const binding = createStandaloneRuntimeAssetBinding('ordinary-lit-depth');
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
  if (!url) throw new Error('ordinary lit depth fixture has no HTTP listener');
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
