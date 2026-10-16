import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meshIrToMeshAsset, toMaterialAsset } from '@forgeax/engine-gltf';
import { parseGltfFromFile } from '@forgeax/engine-gltf/node';
import { parseImage } from '@forgeax/engine-image/parse-image';
import { deriveTextureColorSpace } from '../../../packages/gltf/src/image-color-space.ts';
import { cookGltfMeshCards } from '../../../packages/gltf/src/mesh-cards.ts';
import { mat4 } from '../../../packages/math/dist/index.mjs';
import { buildRaySurfaceScene } from '../../../packages/render/dist/internal.mjs';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  cookRayMaterial,
} from '../../../packages/shader-compiler/dist/index.mjs';
import { toShared } from '../../../packages/types/dist/index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(process.argv[2] ?? 'artifacts/ray-sponza');
const source = resolve(
  process.argv[3] ?? 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf',
);
await mkdir(out, { recursive: true });
const document = (await parseGltfFromFile(source)).unwrap();
const meta = JSON.parse(await readFile(`${source}.meta.json`, 'utf8'));
const textureHandles = new Map((document.textures ?? []).map((t, i) => [i, toShared(t.source)]));
const samplerHandles = new Map((document.samplers ?? []).map((_, i) => [i, toShared(i)]));
const directory = resolve(root, 'packages/shader/src');
const sources = buildMaterialSourceCatalog(
  await collectMaterialSources([directory], [directory]),
).unwrap();
const imports = Object.fromEntries(
  [
    'forgeax_material::ray_abi',
    'forgeax_ray::traversal',
    'forgeax_pbr::ray_bsdf',
    'forgeax_pbr::brdf',
    'forgeax_pbr::ibl_shared',
    'forgeax_pbr::lighting_attenuation',
    'forgeax_view::common',
    'forgeax_view::tonemap',
    'forgeax_view::output_encoding',
  ].map((id) => [id, sources.get(id).unwrap().source]),
);
const kernel = (
  await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
    id: 'gltf-path',
    imports,
  })
).unwrap().wgsl;
const displayKernel = (
  await compileShader(
    await readFile(resolve(root, 'packages/render/src/raytracing/display.wgsl'), 'utf8'),
    { id: 'ray-display', imports },
  )
).unwrap().wgsl;
const materials = [];
for (const [id, material] of document.materials.entries()) {
  const asset = toMaterialAsset(material, { textureHandles, samplerHandles });
  materials.push({
    id,
    ...(await cookRayMaterial({ material: String(id), table: { [id]: asset }, sources })).unwrap(),
  });
}
const instances = [],
  cardMeshes = [];
let repairedTangentVertices = 0;
const visit = (index, parent, ancestors = new Set()) => {
  if (ancestors.has(index)) throw new Error('Cyclic glTF node hierarchy');
  const node = document.nodes[index];
  if (!node) throw new Error(`Missing node ${index}`);
  if (node.skinIndex !== null || node.morphWeights || node.instancing)
    throw new Error('Frozen rigid reference requires explicit deformation/instancing projection');
  const t = node.transform,
    local = mat4.compose(mat4.create(), t.translation, t.rotation, t.scale),
    world = mat4.multiply(mat4.create(), parent, local);
  for (const [geometryId, mesh] of document.meshes.entries()) {
    if (mesh.meshIndex !== node.meshIndex) continue;
    if (mesh.materialIndex === null || mesh.morphTargets)
      throw new Error('Missing material or unsupported morph geometry');
    const cooked = meshIrToMeshAsset([mesh]).unwrap();
    if (mesh.tangents) {
      for (let v = 0; v < mesh.tangents.length; v += 4)
        if ([0, 1, 2, 3].some((c) => mesh.tangents[v + c] !== cooked.attributes.tangent[v + c]))
          repairedTangentVertices++;
    }
    const uvSets = [];
    for (let slot = 0; slot < 8; slot++) {
      const uv = mesh[`texcoord${slot}`];
      if (uv === undefined) continue;
      if (slot !== uvSets.length)
        throw new Error(`Sparse UV slots require an explicit projection: ${slot}`);
      uvSets.push(uv);
    }
    instances.push({
      instanceId: instances.length,
      geometryId,
      materialId: mesh.materialIndex,
      mask: 255,
      positions: cooked.attributes.position,
      indices:
        cooked.indices ?? Uint32Array.from({ length: mesh.positions.length / 3 }, (_, i) => i),
      transform: world,
      normals: cooked.attributes.normal,
      tangents: cooked.attributes.tangent,
      colors: mesh.colors0,
      uvSets,
    });
  }
  if (process.argv.includes('--cards') && node.meshIndex !== null) {
    const primitives = document.meshes.filter((mesh) => mesh.meshIndex === node.meshIndex);
    const mesh = meshIrToMeshAsset(primitives).unwrap();
    cardMeshes.push({
      instanceId: index,
      geometryId: node.meshIndex,
      transform: world,
      mesh,
      primitives,
    });
  }
  for (const child of node.children) visit(child, world, new Set([...ancestors, index]));
};
for (const index of document.scenes[document.defaultSceneIndex].nodes)
  visit(index, mat4.identity(mat4.create()));
console.log(
  `Building full scene: ${instances.length} instances, ${instances.reduce((n, i) => n + i.indices.length / 3, 0)} triangles`,
);
const scene = buildRaySurfaceScene(instances).unwrap();
for (const key of ['triangles', 'nodes', 'attributes'])
  await writeFile(resolve(out, `${key}.bin`), scene[key]);
const colorSpaces = deriveTextureColorSpace({
  imageCount: document.images?.length ?? 0,
  textures: document.textures,
  materials: document.materials,
});
const images = [];
for (const [id, image] of (document.images ?? []).entries()) {
  if (!image.uri || image.uri.startsWith('data:'))
    throw new Error('This file carrier requires external image sources');
  const bytes = await readFile(resolve(dirname(source), image.uri));
  const mime = image.uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const decoded = parseImage(bytes, mime, { colorSpace: colorSpaces.get(id) ?? 'linear' }).unwrap();
  const sub = meta.subAssets.find((s) => s.kind === 'texture' && s.sourceIndex === id);
  if (!sub) throw new Error(`Missing image GUID ${id}`);
  await writeFile(resolve(out, `image-${id}.bin`), decoded.bytes);
  images.push({
    id,
    guid: sub.guid,
    uri: image.uri,
    width: decoded.width,
    height: decoded.height,
    colorSpace: decoded.colorSpace,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
if (process.argv.includes('--cards')) {
  const cardMaterials = [];
  for (const { id, asset } of materials) {
    cardMaterials.push({
      id,
      ...(
        await cookRayMaterial({
          material: String(id),
          table: { [id]: asset },
          sources,
          context: 'card-capture',
        })
      ).unwrap(),
    });
  }
  const cardSources = [],
    buildMeasurements = [];
  for (const { instanceId, geometryId, transform, mesh, primitives } of cardMeshes) {
    const start = performance.now();
    const cooked = (
      await cookGltfMeshCards(mesh, primitives, document.materials, {
        resolution: 16,
        maxCards: 24,
      })
    ).unwrap();
    const layout = cooked.cardLayout;
    const indices =
      cooked.indices ??
      Uint32Array.from({ length: cooked.attributes.position.length / 3 }, (_, i) => i);
    const uvSets = [];
    for (let set = 0; set < 8; set++) {
      const uv = cooked.attributes[set === 0 ? 'uv' : `uv${set}`];
      if (uv === undefined) continue;
      if (set !== uvSets.length) throw new Error(`Sparse UV set ${set}`);
      uvSets.push(uv);
    }
    let offset = 0;
    const sections = cooked.submeshes.map((section, i) => {
      const indexOffset = cooked.indices ? section.indexOffset : offset;
      const indexCount = cooked.indices ? section.indexCount : section.vertexCount;
      offset += indexCount;
      const material = cardMaterials.find((m) => m.id === primitives[i].materialIndex);
      if (!material) throw new Error(`Missing card material for section ${i}`);
      return {
        indexOffset,
        indexCount,
        material,
        textureContentKey: JSON.stringify(images.map((i) => i.sha256)),
      };
    });
    cardSources.push({
      instance: {
        instanceId,
        geometryId,
        mask: 255,
        transform,
        positions: cooked.attributes.position,
        indices,
        normals: cooked.attributes.normal,
        tangents: cooked.attributes.tangent,
        colors: cooked.attributes.color,
        uvSets,
      },
      layout,
      sections,
    });
    buildMeasurements.push({
      instanceId,
      geometryId,
      sections: sections.length,
      milliseconds: performance.now() - start,
      cards: layout.cards.length,
      sampling: layout.sampling,
    });
    console.log(`Cards ${geometryId}: ${layout.cards.length} across ${sections.length} sections`);
  }
  await writeFile(
    resolve(out, 'cards.json'),
    JSON.stringify(
      {
        sources: cardSources,
        buildMeasurements,
        scope:
          'Whole-mesh layouts from the ordinary glTF card producer; explicit frozen GPU capture',
      },
      (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v),
    ),
  );
}
const report = {
  source: source.slice(root.length),
  sourceSha256: createHash('sha256')
    .update(await readFile(source))
    .digest('hex'),
  instances: instances.length,
  triangles: scene.triangleCount,
  inactiveTriangles: Array.from({ length: scene.triangleCount }, (_, i) =>
    new DataView(
      scene.triangles.buffer,
      scene.triangles.byteOffset,
      scene.triangles.byteLength,
    ).getUint32(i * 80 + 64, true),
  ).filter((mask) => mask === 0).length,
  repairedTangentVertices,
  materials: materials.length,
  maskedMaterials: materials.filter((m) => m.asset.values.alphaCutoff > 0).map((m) => m.id),
  images: images.length,
};
await writeFile(
  resolve(out, 'prepared.json'),
  JSON.stringify({
    kernel,
    displayKernel,
    materials,
    images,
    samplers: document.samplers,
    scene: {
      triangleCount: scene.triangleCount,
      instanceAttributes: [...scene.instanceAttributes],
    },
    report,
  }),
);
console.log(JSON.stringify(report, null, 2));
