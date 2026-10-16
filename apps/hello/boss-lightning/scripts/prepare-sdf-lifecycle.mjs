import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { attachMeshDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { cookMeshDistanceFieldProduct, prepareRuntimePackContent } from '@forgeax/engine-import';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { loadVfxGpuEffect } from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { SDF_MODULES } from '../assets/sdf-programs.ts';

// Pure preparation: no Device, Renderer, GPU lease or native simulation.
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const output = resolve(
  process.env.FORGEAX_SDF_PREPARED ?? resolve(here, '../artifacts/sdf-prepared'),
);
mkdirSync(output, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  const input =
    typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
  const url = new URL(input, 'http://127.0.0.1');
  if (url.hostname === '127.0.0.1') {
    const path = resolve(dist, url.pathname.slice(1));
    assert(path.startsWith(`${dist}/`) && existsSync(path), path);
    return new Response(readFileSync(path));
  }
  return originalFetch(request, init);
};
const assets = new AssetRegistry(new ShaderRegistry({}));
const assembly = createAssetRuntimeAssembly(assets, {
  catalogSource: createCatalogSource({ url: '/pack-index.json' }),
}).unwrap();
const context = await createWorldContext(new World(), []);
const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'sdf-lifecycle-preparation' });
assets.setCatalogSource(runtime.catalog, runtime.fetcher);
const publication = (name, facts) => {
  const bytes = Buffer.from(JSON.stringify(runtime.producer.snapshot()));
  writeFileSync(resolve(output, `${name}.runtime-pack.json`), bytes);
  return { ...facts, file: `${name}.runtime-pack.json`, bytes: bytes.length, sha256: sha(bytes) };
};
try {
  const packageId = '019fcaf0-0015-7000-8000-000000000002';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'mesh/box'));
  const rows = [];
  for (const [label, width] of [
    ['baseline', 2],
    ['replacement', 2.4],
  ]) {
    const plain = createBoxGeometry(width, 2, 2).unwrap();
    const cooked = await cookMeshDistanceFieldProduct(plain, guid, { resolution: 32 }, [0]);
    const mesh = (
      await attachMeshDistanceField(
        plain,
        cooked.payload,
        cooked.artifacts['distance-field.bin'].bytes,
      )
    ).unwrap();
    const content = (await prepareRuntimePackContent(packageId, { 'mesh/box': mesh })).unwrap();
    if (label === 'replacement') runtime.producer.withdraw(packageId);
    const receipt = (await runtime.producer.admit(content)).unwrap();
    assert.equal(receipt.rows[0].guid, guid);
    assets.invalidate(guid);
    const loaded = (await assets.loadByGuid(assets.parseGuid(guid))).unwrap();
    assert(loaded.distanceField.values instanceof Float32Array);
    assert.equal(loaded.aabb[3], Math.fround(width / 2));
    rows.push(
      publication(label, {
        label,
        width,
        guid,
        publication: receipt.publication,
        field: loaded.distanceField.artifact,
        policy: loaded.distanceField.policy,
      }),
    );
  }
  assert.notEqual(rows[0].publication.digest, rows[1].publication.digest);
  runtime.producer.withdraw(packageId);

  const basePackage = definePackageId('019fcaf0-0015-7000-8000-000000000001');
  const material = AssetGuid.format(AssetGuid.derive(basePackage, 'material/particle'));
  let entry = SDF_MODULES['sdf-free.vfx.wgsl'].entry.replace(
    '\n',
    '\n#import forgeax_vfx::data::camera\n#import forgeax_vfx::data::scene_depth\n',
  );
  entry = entry.replace(
    /fn vfx_update\([\s\S]*$/,
    `fn vfx_update(ctx:VfxUpdateContext,particle:ptr<function,VfxParticle>){
    (*particle).velocity.y-=forgeax_vfx_parameters.gravity*ctx.delta;
    let previous=(*particle).position;vfx_integrate(ctx,particle);
    let clip=forgeax_vfx_camera*vec4f((*particle).position,1.0);
    if(clip.w<=0.0){return;}
    let ndc=clip.xyz/clip.w;let uv=vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5);
    if(any(uv<vec2f(0))||any(uv>=vec2f(1))){return;}
    let size=textureDimensions(forgeax_vfx_scene_depth);
    let depth=textureLoad(forgeax_vfx_scene_depth,vec2i(uv*vec2f(size)),0);
    if(depth>0.0 && ndc.z<depth){(*particle).position=previous;(*particle).velocity=vec3f(0);(*particle).color=vec4f(0.2,1,0.1,1);}
  }`,
  );
  const depthPackage = '019fcaf0-0015-7000-8000-000000000003';
  const source = {
    schemaVersion: 3,
    emitters: [
      {
        id: 'collision-0',
        capacity: 1024,
        backend: { required: 'gpu' },
        space: 'world',
        bounds: { kind: 'aabb', min: [-4, -4, -4], max: [4, 4, 4] },
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [{ time: 0, count: 1024 }] },
        program: { module: 'depth-control.vfx.wgsl' },
        renderers: [{ kind: 'billboard', capacity: 1024, material }],
      },
    ],
  };
  const cooked = (
    await cookParticleCodeEffect(source, { 'depth-control.vfx.wgsl': { entry } })
  ).unwrap();
  (await assets.loadByGuid(assets.parseGuid(material))).unwrap();
  const materialRow = (await assets.enumerateCatalog())
    .unwrap()
    .find((row) => row.guid === material);
  assert(materialRow);
  const digest = materialRow.publication.outputs.find((row) => row.guid === material).digest;
  const content = (
    await prepareRuntimePackContent(
      depthPackage,
      { 'effect/depth-control': cooked.asset },
      { dependencies: { [material]: digest } },
    )
  ).unwrap();
  const receipt = (await runtime.producer.admit(content)).unwrap();
  const effectGuid = receipt.rows[0].guid;
  const effect = (await loadVfxGpuEffect(assets, effectGuid)).unwrap();
  const requirements = effect.program.emitters[0].reflection.dataInterfaces;
  assert.deepEqual(
    requirements.map((row) => row.kind),
    ['camera', 'scene-depth'],
  );
  assert(!effect.program.emitters[0].wgsl.includes('vfx_sdf_collide'));
  const depth = publication('depth-control', {
    guid: effectGuid,
    packageId: depthPackage,
    requirements,
    publication: receipt.publication,
  });
  writeFileSync(resolve(output, 'depth-control.vfx.wgsl'), entry);
  writeFileSync(
    resolve(output, 'manifest.json'),
    JSON.stringify(
      {
        scope:
          'Canonical cook and durable Runtime Pack snapshots prepared without GPU admission; native tests remain required',
        republication: { packageId, guid, rows },
        depth,
      },
      null,
      2,
    ),
  );
  console.log('PASS: same-GUID mesh snapshots and cooked camera/depth negative control prepared');
} finally {
  assets.clearCatalogSource();
  await context.fiber.dispose();
  assembly.dispose();
  globalThis.fetch = originalFetch;
}
