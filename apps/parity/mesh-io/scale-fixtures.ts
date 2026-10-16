import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import type { FidelityFixture } from './fidelity-fixtures';

/** A fixed-area triangle grid avoids multiplying covered pixels with asset size. */
export async function prepareScaleFixtures(root: string, imagePath: string): Promise<FidelityFixture[]> {
  await mkdir(root, { recursive: true });
  const image = await readFile(imagePath);
  const rows: FidelityFixture[] = [];
  for (const triangles of [12, 10000, 120000]) {
    const vertices = triangles * 3;
    const columns = Math.ceil(Math.sqrt(triangles / 2));
    const lines = Math.ceil(triangles / (2 * columns));
    for (const [layout, stride] of [['tight', 12], ['strided', 16]] as const) {
      const bytes = new Uint8Array(vertices * (stride + 8));
      const view = new DataView(bytes.buffer);
      for (let face = 0; face < triangles; face++) {
        const cell = Math.floor(face / 2), column = cell % columns, line = Math.floor(cell / columns);
        const corners = face % 2 === 0 ? [[0, 0], [1, 0], [1, 1]] : [[0, 0], [1, 1], [0, 1]];
        for (let corner = 0; corner < 3; corner++) {
          const u = (column + corners[corner]![0]!) / columns;
          const v = (line + corners[corner]![1]!) / lines;
          const vertex = face * 3 + corner;
          view.setFloat32(vertex * stride, 1.6 * u - .8, true);
          view.setFloat32(vertex * stride + 4, 1.2 * v - .6, true);
          view.setFloat32(vertices * stride + vertex * 8, u, true);
          view.setFloat32(vertices * stride + vertex * 8 + 4, v, true);
        }
      }
      const source = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
        nodes: [{ name: 'Grid', mesh: 0 }, { name: 'Camera', camera: 0, translation: [0, 0, 3] }],
        cameras: [{ type: 'perspective', perspective: { yfov: 1.1, aspectRatio: 4 / 3, znear: .2, zfar: 20 } }],
        buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
        bufferViews: [{ buffer: 0, byteLength: vertices * stride, ...(stride === 16 ? { byteStride: 16 } : {}) }, { buffer: 0, byteOffset: vertices * stride, byteLength: vertices * 8 }],
        accessors: [{ bufferView: 0, type: 'VEC3', componentType: 5126, count: vertices }, { bufferView: 1, type: 'VEC2', componentType: 5126, count: vertices }],
        meshes: [{ name: 'Grid', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
        images: [{ uri: `data:image/png;base64,${image.toString('base64')}` }], textures: [{ source: 0 }],
      };
      const id = `scale-${triangles}-${layout}`, path = resolve(root, `${id}.gltf`);
      await writeFile(path, JSON.stringify(source));
      const errors: string[] = [];
      if (await runCliGltf(['import', path], { stdoutWrite() {}, stderrWrite: line => errors.push(line) })) throw new Error(errors.join('\n'));
      const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { subAssets: { kind: string; guid: string }[] };
      rows.push({ id, label: `${triangles} triangles / ${layout}`, guids: meta.subAssets.filter(row => row.kind === 'mesh').map(row => row.guid), sceneGuid: meta.subAssets.find(row => row.kind === 'scene')!.guid, lightIntensity: 3 });
    }
  }
  return rows;
}
