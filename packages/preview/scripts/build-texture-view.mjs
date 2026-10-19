import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createTextureViewMaterial } from '../src/texture-view.ts';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/texture-view.wgsl', root), 'utf8');
const output = new URL('dist/texture-view/', root);
await mkdir(output, { recursive: true });
for (const [dimension, guid] of Object.entries({
  '2d': '019e7600-0000-7000-8000-000000000001',
  '2d-array': '019e7600-0000-7000-8000-000000000002',
  '3d': '019e7600-0000-7000-8000-000000000003',
})) {
  const name = dimension.replaceAll('-', '_');
  const load = dimension === '2d' ? 'textureLoad(sourceTexture, p, mip)'
    : dimension === '2d-array' ? 'textureLoad(sourceTexture, p, i32(material.display.y), mip)'
    : 'textureLoad(sourceTexture, vec3<i32>(p, i32(material.display.y)), mip)';
  await writeFile(new URL(`${dimension}.wgsl`, output), source.replaceAll('__DIMENSION__', name).replace('__LOAD__', load));
  const pack = { schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [{
    guid, kind: 'material', sourceKey: `${dimension}.wgsl`,
    payload: createTextureViewMaterial(dimension), refs: [],
  }] };
  await writeFile(new URL(`${dimension}.pack.json`, output), JSON.stringify(pack, null, 2) + '\n');
}
