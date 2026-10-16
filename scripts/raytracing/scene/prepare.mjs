import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMeshDistanceField,
  createBoxGeometry,
} from '../../../packages/geometry/dist/index.mjs';
import { buildMeshCardLayout } from '../../../packages/geometry/src/mesh-card-layout.ts';
import { Materials } from '../../../packages/render/dist/index.mjs';
import { CARD_LOOKUP_WGSL } from '../../../packages/render/src/raytracing/card-lookup.ts';
import { SDF_TRACE_WGSL } from '../../../packages/render/src/raytracing/sdf-query.ts';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  cookRayMaterial,
} from '../../../packages/shader-compiler/dist/index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function prepare() {
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
  const compile = async (file, insert = {}) => {
    let code = await readFile(resolve(root, 'packages/render/src/raytracing', file), 'utf8');
    for (const [name, source] of Object.entries(insert))
      code = code.replace(`#pragma ${name}`, source);
    return (await compileShader(code, { id: file, imports })).unwrap().wgsl;
  };
  const kernel = await compile('diffuse-gi.wgsl', {
    sdf_traversal: SDF_TRACE_WGSL,
    card_lookup: CARD_LOOKUP_WGSL,
  });
  const pathKernel = (
    await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
      id: 'ray-path-tracer',
      imports,
    })
  ).unwrap().wgsl;
  const displayKernel = await compile('display.wgsl');
  const materials = [];
  for (const [name, baseColor] of Object.entries({
    white: [0.73, 0.73, 0.73, 1],
    red: [0.73, 0.045, 0.035, 1],
    blue: [0.035, 0.12, 0.73, 1],
  })) {
    const asset = Materials.standard({ baseColor, roughness: 0.7, specular: 0 });
    const card = (
      await cookRayMaterial({
        material: name,
        table: { [name]: asset },
        sources,
        context: 'card-capture',
      })
    ).unwrap();
    const ray = (
      await cookRayMaterial({ material: name, table: { [name]: asset }, sources })
    ).unwrap();
    materials.push({ name, card, ray });
  }
  const box = createBoxGeometry(2, 2, 2).unwrap();
  const positions = Array.from(box.attributes.position),
    indices = Array.from(box.indices);
  const field = (await buildMeshDistanceField(positions, indices, { resolution: 48 })).unwrap();
  return {
    kernel,
    layout: (await buildMeshCardLayout(positions, indices)).unwrap(),
    pathKernel,
    displayKernel,
    materials,
    geometry: {
      positions,
      indices,
      normals: Array.from(box.attributes.normal),
      tangents: Array.from(box.attributes.tangent),
      uvSets: [Array.from(box.attributes.uv)],
    },
    field: { ...field, bricks: Array.from(field.bricks), values: Array.from(field.values) },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'artifacts/ray-gi-scene');
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'prepared.json'), JSON.stringify(await prepare()));
  console.log(`Prepared scene at ${out}`);
}
