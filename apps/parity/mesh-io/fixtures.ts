import { prepareFidelityFixtures, type FidelityFixture } from './fidelity-fixtures';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { exportMeshes, importMeshFile } from '@forgeax/engine-mesh-io';
import { createEncoderModule } from 'draco3dgltf';

export async function prepareFixtures(root: string) {
  await mkdir(root, { recursive: true });
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const rows: FidelityFixture[] = [];
  for (const format of ['obj', 'stl', 'gltf', 'glb'] as const) {
    const bytes = (await exportMeshes([{ name: 'Box', mesh }], format)).unwrap();
    const path = resolve(root, `box.${format}`);
    await writeFile(path, bytes);
    if (format === 'obj' || format === 'stl') (await importMeshFile(path)).unwrap();
    else {
      const errors: string[] = [];
      if (await runCliGltf(['import', path], { stdoutWrite() {}, stderrWrite: (line) => errors.push(line) })) throw new Error(errors.join('\n'));
    }
    const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { subAssets: { guid: string; kind: string }[] };
    rows.push({ id: format, label: `${format.toUpperCase()} roundtrip`, guids: meta.subAssets.filter((entry) => entry.kind === 'mesh').map((entry) => entry.guid) });
  }
  const module = await createEncoderModule();
  const dracoMesh = new module.Mesh(); const builder = new module.MeshBuilder(); const encoder = new module.Encoder(); const output = new module.DracoInt8Array();
  try {
    const position = mesh.attributes.position as Float32Array;
    const normal = mesh.attributes.normal as Float32Array;
    const positionId = builder.AddFloatAttribute(dracoMesh, module.POSITION, position.length / 3, 3, position);
    const normalId = builder.AddFloatAttribute(dracoMesh, module.NORMAL, normal.length / 3, 3, normal);
    builder.AddFacesToMesh(dracoMesh, mesh.indices!.length / 3, mesh.indices!);
    encoder.SetSpeedOptions(5, 5); encoder.SetAttributeQuantization(module.POSITION, 14);
    const size = encoder.EncodeMeshToDracoBuffer(dracoMesh, output);
    const bytes = Uint8Array.from({ length: size }, (_, index) => output.GetValue(index));
    const source = {
      asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'],
      buffers: [{ byteLength: size, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }], bufferViews: [{ buffer: 0, byteLength: size }],
      accessors: [{ componentType: 5126, count: position.length / 3, type: 'VEC3' }, { componentType: 5126, count: normal.length / 3, type: 'VEC3' }, { componentType: 5123, count: mesh.indices!.length, type: 'SCALAR' }],
      meshes: [{ name: 'Box', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionId, NORMAL: normalId } } } }] }],
      nodes: [{ name: 'Box', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    };
    const path = resolve(root, 'draco.gltf'); await writeFile(path, JSON.stringify(source));
    const errors: string[] = [];
    if (await runCliGltf(['import', path], { stdoutWrite() {}, stderrWrite: (line) => errors.push(line) })) throw new Error(errors.join('\n'));
    const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { subAssets: { kind: string; guid: string }[] };
    rows.push({ id: 'draco', label: 'Draco decode', guids: meta.subAssets.filter((entry) => entry.kind === 'mesh').map((entry) => entry.guid) });
  } finally { module.destroy(output); module.destroy(encoder); module.destroy(builder); module.destroy(dracoMesh); }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path id="Ring" fill="#4bc4ad" fill-rule="evenodd" d="M0 0H10V10H0Z M3 3H7V7H3Z"/><path id="Curve" fill="none" stroke="#ffb65c" stroke-width="0.35" d="M0 5Q5 -2 10 5 A5 5 0 0 1 0 5"/></svg>';
  const svgPath = resolve(root, 'shape.svg'); await writeFile(svgPath, svg);
  const admitted = (await importMeshFile(svgPath)).unwrap();
  rows.push({ id: 'svg', label: 'SVG hole / curves / strokes', guids: admitted.subAssets.map((entry) => entry.guid) });
  return [...rows,...await prepareFidelityFixtures(root)];
}
