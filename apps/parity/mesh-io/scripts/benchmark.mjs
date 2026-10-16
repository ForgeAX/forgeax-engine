import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { parseGltf, parseGlb, meshIrToMeshAsset } from '@forgeax/engine-gltf';
import { dracoDecoder } from '@forgeax/engine-gltf/node-importer';
import { exportMeshes, parseObj, parseStl, parseSvg } from '@forgeax/engine-mesh-io';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { createEncoderModule } from 'draco3dgltf';
const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../artifacts/mesh-io/performance');
await mkdir(destination, { recursive: true });
const results = [];
async function sample(label, count, run, facts = {}) {
  await run(); // warm initialization is excluded explicitly
  const times = [];
  const rssBefore = process.memoryUsage().rss;
  for (let i = 0; i < count; i++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  const row = { label, samples: count, p50Ms: times[Math.floor(count / 2)], p95Ms: times[Math.ceil(count * .95) - 1], rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss, ...facts };
  results.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
for (const [label, segments, count] of [['box', 1, 12], ['120k-triangles', 100, 5]]) {
  const mesh = createBoxGeometry(1, 1, 1, segments, segments, segments).unwrap();
  const items = [{ name: 'Box', mesh }];
  for (const format of ['obj', 'stl', 'gltf', 'glb']) {
    const bytes = (await exportMeshes(items, format)).unwrap();
    const text = new TextDecoder().decode(bytes);
    const facts = { triangles: mesh.indices.length / 3, inputVertices: mesh.attributes.position.length / 3, sourceBytes: bytes.length };
    await sample(`${label}/${format}/export`, count, async () => (await exportMeshes(items, format)).unwrap(), facts);
    await sample(`${label}/${format}/import`, count, async () => {
      if (format === 'obj') return parseObj(text).unwrap();
      if (format === 'stl') return parseStl(bytes).unwrap();
      const doc = (format === 'gltf' ? await parseGltf(JSON.parse(text), async () => { throw new Error('embedded'); }, 'bench.gltf') : await parseGlb(bytes.slice().buffer, 'bench.glb')).unwrap();
      return meshIrToMeshAsset(doc.meshes).unwrap();
    }, facts);
    if (format === 'obj') await sample(`${label}/obj/three-parser-only`, count, () => new OBJLoader().parse(text), facts);
    if (format === 'stl') await sample(`${label}/stl/three-parser-only`, count, () => new STLLoader().parse(bytes.slice().buffer), facts);
  }
  const module = await createEncoderModule();
  const dm = new module.Mesh(), builder = new module.MeshBuilder(), encoder = new module.Encoder(), output = new module.DracoInt8Array();
  try {
    const positionId = builder.AddFloatAttribute(dm, module.POSITION, mesh.attributes.position.length / 3, 3, mesh.attributes.position);
    const normalId = builder.AddFloatAttribute(dm, module.NORMAL, mesh.attributes.normal.length / 3, 3, mesh.attributes.normal);
    builder.AddFacesToMesh(dm, mesh.indices.length / 3, mesh.indices);
    encoder.SetSpeedOptions(5, 5); encoder.SetAttributeQuantization(module.POSITION, 14);
    const size = encoder.EncodeMeshToDracoBuffer(dm, output);
    if (size <= 0) throw new Error('Draco encoder failed');
    const bytes = Uint8Array.from({ length: size }, (_, i) => output.GetValue(i));
    const json = { asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], buffers: [{ byteLength: size, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }], bufferViews: [{ buffer: 0, byteLength: size }], accessors: [{ componentType: 5126, count: mesh.attributes.position.length / 3, type: 'VEC3' }, { componentType: 5126, count: mesh.attributes.normal.length / 3, type: 'VEC3' }, { componentType: 5125, count: mesh.indices.length, type: 'SCALAR' }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionId, NORMAL: normalId } } } }] }] };
    await sample(`${label}/draco/decode-and-bridge`, count, async () => meshIrToMeshAsset((await parseGltf(json, async () => { throw new Error('embedded'); }, 'draco.gltf', { draco: dracoDecoder })).unwrap().meshes).unwrap(), { triangles: mesh.indices.length / 3, inputVertices: mesh.attributes.position.length / 3, sourceBytes: size, uncompressedPositionNormalIndexBytes: mesh.attributes.position.byteLength + mesh.attributes.normal.byteLength + mesh.indices.byteLength });
  } finally { for (const item of [output, encoder, builder, dm]) module.destroy(item); }
}
const svg = '<svg><path fill="#f00" fill-rule="evenodd" d="M0 0H10V10H0Z M3 3H7V7H3Z"/><path fill="none" stroke="#0f0" d="M0 0Q10 20 20 0A10 10 0 0 1 40 0"/></svg>';
await sample('svg/hole-curve-stroke/import-worker', 12, async () => (await parseSvg(svg)).unwrap(), { sourceBytes: Buffer.byteLength(svg) });
const report = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(destination, '../../..'), encoding: 'utf8' }).trim(), measuredAt: new Date().toISOString(), runtime: process.version, cpu: cpus()[0]?.model, platform: `${platform()}/${arch()}`, methodology: 'Wall time, one excluded warmup, sequential operations. Worker startup is included in every SVG/glTF/GLB operation. Three parser-only excludes canonical validation, bounds, tangent derivation and packing. RSS is process-wide endpoint data, not per-operation peak or an allocation claim.', results };
await writeFile(resolve(destination, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
