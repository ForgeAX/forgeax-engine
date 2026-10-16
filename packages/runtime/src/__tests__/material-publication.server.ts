import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding, type MaterialAsset } from '@forgeax/engine-types';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer } from 'vite';

/** Real disk -> registered cooker -> Vite HTTP producer for both GPU backends. */
export async function startMaterialPublicationServer() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-publication-'));
  const assets = join(root, 'assets');
  await mkdir(assets);
  const source = (
    module: string,
    color: string,
    dependency = false,
  ) => `#define_import_path ${module}
#import forgeax_view::common::{view, meshes}
#import forgeax_material::parameters::{material}
${dependency ? '#import game::color::{shade}' : ''}
@vertex fn vs_main(@location(0) pos: vec3<f32>, @builtin(instance_index) idx: u32) -> @builtin(position) vec4<f32> {
  return view.worldViewProj * meshes[idx].worldFromLocal * vec4<f32>(pos, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return ${dependency ? 'shade()' : `vec4<f32>(${color})`} * vec4<f32>(vec3<f32>(material.factor), 1.0); }
`;
  const update = (value: 'red' | 'blue' | 'broken') =>
    writeFile(
      join(assets, 'color.wgsl'),
      `#define_import_path game::color\nfn shade() -> vec4<f32> { ${value === 'broken' ? 'broken' : `return vec4<f32>(${value === 'red' ? '1.0, 0.0, 0.0, 1.0' : '0.0, 0.0, 1.0, 1.0'});`} }\n`,
    );
  await update('red');
  await writeFile(join(assets, 'first.wgsl'), source('game::first', '', true));
  await writeFile(join(assets, 'overlay.wgsl'), source('game::overlay', '0.0, 1.0, 0.0, 1.0'));
  await writeFile(join(assets, 'other.wgsl'), source('game::other', '1.0, 1.0, 0.0, 1.0'));
  const guids: string[] = [];
  for (const [index, name] of ['first', 'other'].entries()) {
    const packageId = `019a0000-0000-7000-8000-00000000010${index}`;
    const parsed = PackageId.parse(packageId);
    if (!parsed.ok) throw parsed.error;
    guids.push(AssetGuid.format(AssetGuid.derive(parsed.value, 'material/main')));
    if (index === 0) guids.push(AssetGuid.format(AssetGuid.derive(parsed.value, 'material/child')));
    const passes = [
      {
        name: 'Forward',
        program: { module: `game::${name}`, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
      ...(index === 0
        ? [
            {
              name: 'Overlay',
              program: {
                module: 'game::overlay',
                vertexEntry: 'vs_main',
                fragmentEntry: 'fs_main',
              },
              renderState: { tags: { LightMode: 'Overlay' } },
            },
            {
              name: 'ShadowCaster',
              program: { module: 'forgeax::default-shadow-caster', vertexEntry: 'vs_main' },
              renderState: { tags: { LightMode: 'ShadowCaster' } },
            },
          ]
        : []),
    ];
    await writeFile(
      join(assets, `${name}.pack.ts`),
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'),
build() { return ok({ 'material/main': ${JSON.stringify({ kind: 'material', passes, parameters: [{ name: 'factor', type: 'f32', default: 1 }], values: { factor: 1 } })}
${index === 0 ? `, 'material/child': { kind: 'material', parent: new Uint8Array(${JSON.stringify([...AssetGuid.derive(parsed.value, 'material/main')])}), values: {} }` : ''}
}); } });\n`,
    );
  }
  const particlePackageId = '019a0000-0000-7000-8000-000000000130';
  const particlePackage = PackageId.parse(particlePackageId);
  if (!particlePackage.ok) throw particlePackage.error;
  const particleGuid = (key: string) =>
    AssetGuid.format(AssetGuid.derive(particlePackage.value, key));
  guids.push(particleGuid('material/particle'), particleGuid('effect/particle'));
  await writeFile(
    join(assets, 'particle.wgsl'),
    `#define_import_path game::published-particle
#import forgeax_view::common::{view}
// forgeax-vfx-particle-input heat: f32 fragment lane=0
struct Input { @location(0) position: vec3<f32>, @location(4) center: vec3<f32>, @location(10) heat: vec4<f32>, }
struct Output { @builtin(position) position: vec4<f32>, @location(0) heat: f32, }
@vertex fn vs_main(input: Input) -> Output {
  return Output(view.worldViewProj * vec4<f32>(input.center + input.position, 1.0), input.heat.x);
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let a = textureSampleLevel(firstTexture, firstTexture_sampler, vec2<f32>(0.5), 0.0);
  let b = textureSampleLevel(secondTexture, secondTexture_sampler, vec2<f32>(0.5), 0.0);
  let c = textureSampleLevel(thirdTexture, thirdTexture_sampler, vec2<f32>(0.5), 0.0);
  // White fallback or swapped textures must produce black.
  let textures = a.r * (1.0 - a.g) * b.g * (1.0 - b.b) * c.b * (1.0 - c.r);
  return material.tint * vec4<f32>(vec3<f32>(textures * input.heat), 1.0);
}
`,
  );
  const particleInputs = [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }];
  const particleMaterial = {
    kind: 'material',
    passes: [
      {
        name: 'particle-mesh',
        program: { module: 'game::published-particle' },
        renderState: { cullMode: 'none', depthWriteEnabled: false },
      },
    ],
    particleInputs,
    parameters: [
      { name: 'tint', type: 'vec4' },
      ...['first', 'second', 'third'].map((name) => ({ name: `${name}Texture`, type: 'texture' })),
    ],
    values: {
      tint: [1, 0, 1, 1],
      ...Object.fromEntries(
        ['first', 'second', 'third'].map((name) => [
          `${name}Texture`,
          { texture: particleGuid(`texture/${name}`) },
        ]),
      ),
    },
  };
  await writeFile(
    join(assets, 'particle.pack.ts'),
    `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${particlePackageId}'),
async build() {
  const effect = await cookParticleCodeEffect({ schemaVersion: 3, emitters: [{
    id: 'published', capacity: 4, backend: { required: 'gpu' }, space: 'world',
    bounds: { kind: 'sphere', center: [0,0,0], radius: 4 },
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] }, program: { module: 'particle.vfx.wgsl' },
    renderers: [{ kind: 'mesh', mesh: '${particleGuid('mesh/particle')}', material: '${particleGuid('material/particle')}', materialInputs: ['heat'] }],
  }] }, { 'particle.vfx.wgsl': { entry: \`
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxCustom { heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>, custom: ptr<function,VfxCustom>) {
  (*p).position = vec3<f32>(0.0); (*p).lifetime = 100.0;
  (*p).mesh_orientation = vec4<f32>(0.0,0.0,0.0,1.0); (*p).mesh_scale = vec3<f32>(1.0);
  (*custom).heat = 1.0;
}
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>, custom: ptr<function,VfxCustom>) {}
\` } }, { '${particleGuid('material/particle')}': ${JSON.stringify(particleInputs)} });
  if (!effect.ok) return effect;
  const texture = data => ({ kind: 'texture', shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'none' }, data: new Uint8Array([...data,...data,...data,...data]) });
  return ok({ 'material/particle': ${JSON.stringify(particleMaterial)},
    'mesh/particle': createBoxGeometry(1,1,1).unwrap(), 'effect/particle': effect.value.asset,
    'texture/first': texture([255,0,0,255]), 'texture/second': texture([0,255,0,255]), 'texture/third': texture([0,0,255,255]) });
} });
`,
  );
  const binding = createStandaloneRuntimeAssetBinding('material-publication');
  const plugin = pluginPack({
    roots: [assets],
    runtimeBinding: binding,
    producerReadiness: 'on-demand',
    cookers: [createMaterialPackCooker([assets])],
    ddc: { projectDdcRoot: join(root, '.ddc') },
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, cors: true },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (baseUrl === undefined) throw new Error('Vite has no HTTP listener');
  return {
    binding: {
      ...binding,
      catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
      importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    },
    guids,
    update,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type SurfaceMaterialPublicationValue =
  | 'baseline'
  | 'revised'
  | 'recovered'
  | 'schema'
  | 'broken'
  | 'incomplete';

/**
 * Real authored Surface Pack -> material cooker -> Vite watch publication.
 *
 * The GUID is stable across every update. `broken` corrupts the authored WGSL
 * and `incomplete` names an unpublished Surface module, so both failures cross
 * the same producer boundary as a game edit instead of mutating runtime state.
 */
export async function startSurfaceMaterialPublicationServer() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-surface-publication-'));
  const assets = join(root, 'assets');
  await mkdir(assets);
  const packageId = '019a0000-0000-7000-8000-000000000120';
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok) throw parsed.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'material/water'));
  const sourceFor = (value: SurfaceMaterialPublicationValue): string => {
    if (value === 'broken') {
      return `#define_import_path game::surface_hmr\nfn evaluate_surface() { broken }\n`;
    }
    const strength =
      value === 'schema'
        ? ' * event.strength'
        : value === 'recovered'
          ? ' * 0.75'
          : value === 'revised'
            ? ' * 0.65'
            : '';
    return `#define_import_path game::surface_hmr
#import forgeax_material::parameters::{material}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}

fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  var eventFoam = 0.0;
  let eventCount = min(input.eventRangeCount, 4u);
  for (var eventOffset = 0u; eventOffset < eventCount; eventOffset += 1u) {
    let event = read_waterEvents(input.eventRangeStart + eventOffset);
    let age = input.frameTime - event.time;
    let lifetime = select(0.0, 1.0 - age / 4.0, age >= 0.0 && age <= 4.0);
    eventFoam += lifetime * clamp(1.0 - distance(input.positionWS, event.position), 0.0, 1.0)${strength};
  }
  return SingleLayerMediumSurfaceData(
    input.geometricNormalWS,
    material.roughness,
    material.coverage,
    material.foamBase + clamp(eventFoam, 0.0, 1.0) * material.foamScale,
    material.absorption,
    material.scattering,
    material.ior,
    material.phaseG,
    material.maxDistanceMeters,
  );
}
`;
  };
  const materialFor = (value: SurfaceMaterialPublicationValue): MaterialAsset => ({
    kind: 'material',
    surface: {
      model: 'single-layer-medium',
      module: value === 'incomplete' ? 'game::missing_surface' : 'game::surface_hmr',
      dynamicInput: {
        name: 'waterEvents',
        fields: [
          { name: 'position', type: 'vec3<f32>' },
          { name: 'time', type: 'f32' },
          { name: 'eventId', type: 'u32' },
          ...(value === 'schema' ? [{ name: 'strength', type: 'f32' as const }] : []),
        ],
        maxRecords: 8,
        maxDomains: 2,
        maxPageBytes: 256,
        maxBindings: 1,
        maxEventsPerSample: 4,
      },
    },
    passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
    parameters: [
      { name: 'roughness', type: 'f32' },
      { name: 'coverage', type: 'f32' },
      { name: 'foamBase', type: 'f32' },
      { name: 'foamScale', type: 'f32' },
      { name: 'absorption', type: 'vec3' },
      { name: 'scattering', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'phaseG', type: 'f32' },
      { name: 'maxDistanceMeters', type: 'f32' },
    ],
    values: {
      roughness: 0.12,
      coverage: 1,
      foamBase:
        value === 'revised' ? 0.9 : value === 'recovered' ? 0.72 : value === 'schema' ? 0.3 : 0.02,
      foamScale: value === 'schema' ? 0.65 : 0.2,
      absorption: value === 'revised' ? [0.02, 0.25, 0.45] : [0.4, 0.08, 0.02],
      scattering: value === 'revised' ? [0.35, 0.04, 0.01] : [0.01, 0.08, 0.3],
      ior: 1.333,
      phaseG: 0.1,
      maxDistanceMeters: 32,
    },
  });
  const packFor = (value: SurfaceMaterialPublicationValue): string =>
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'),
build() { return ok({ 'material/water': ${JSON.stringify(materialFor(value))} }); } });\n`;
  const update = async (value: SurfaceMaterialPublicationValue): Promise<void> => {
    await writeFile(join(assets, 'surface-hmr.wgsl'), sourceFor(value));
    await writeFile(join(assets, 'surface.pack.ts'), packFor(value));
  };
  await update('baseline');
  const binding = createStandaloneRuntimeAssetBinding('surface-material-publication');
  const plugin = pluginPack({
    roots: [assets],
    runtimeBinding: binding,
    producerReadiness: 'before-consume',
    cookers: [createMaterialPackCooker([assets])],
    ddc: { projectDdcRoot: join(root, '.ddc') },
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, cors: true },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (baseUrl === undefined) throw new Error('Vite has no HTTP listener');
  return {
    binding: {
      ...binding,
      catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
      importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    },
    baseUrl,
    hmrToken: server.config.webSocketToken,
    guid,
    update,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
