import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshPreviewFactRows, texturePreviewFactRows, materialPreviewFacts, materialPassStateRows } from '../packages/view-workspace-core/src/preview-facts.ts';

test('missing owner facts stay unavailable rather than acquiring zero counts or latest catalog data', () => {
  assert.ok(meshPreviewFactRows(undefined).every(row => row.value === null));
  assert.ok(texturePreviewFactRows(undefined).every(row => row.value === null));
  assert.equal(materialPreviewFacts({ meta: { kind: 'mesh' } }), undefined);
});

test('mesh rows describe the retained publication including explicit absent collision', () => {
  const binding = { publication: { generation: 1 }, meta: { kind: 'mesh', vertexCount: 24, triangleCount: 12, uvChannelCount: 2,
    submeshes: [{}, {}], materialSlots: [{}], aabb: [-1, -2, -3, 1, 2, 3], lodCount: 1,
    collision: { present: false, triangleCount: 0 } } };
  const rows = Object.fromEntries(meshPreviewFactRows(binding).map(row => [row.key, row.value]));
  assert.equal(rows.dimensions, '2 x 4 x 6');
  assert.equal(rows.collisionData, false);
  assert.equal(rows.collisionTriangles, 0);
  assert.equal(rows.triangles, 12);
});

test('texture facts distinguish authored mip policy from actual packed mip count', () => {
  const meta = { kind: 'texture', shape: { viewDimension: '3d', extent: { width: 64, height: 32, depth: 8 } },
    format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'generate' }, dataBytes: 65536 };
  const generated = texturePreviewFactRows({ meta });
  assert.equal(generated.find(row => row.key === 'depth').value, 8);
  assert.equal(generated.some(row => row.key === 'packedMips'), false);
  assert.equal(texturePreviewFactRows({ meta: { ...meta, mips: { kind: 'packed', levelCount: 3 } } }).find(row => row.key === 'packedMips').value, 3);
});

test('Equirect facts retain native source dimensions and never invent lighting prefilter mips', () => {
  const rows = Object.fromEntries(texturePreviewFactRows({ meta: {
    kind: 'equirect', shape: {viewDimension:'2d',extent:{width:256,height:128}},
    format:'rgba32float',colorSpace:'linear',mips:{kind:'none'},dataBytes:524288,
  }}).map(row => [row.key,row.value]));
  assert.equal(rows.dimensions,'256 x 128');
  assert.equal(rows.dimension,'2d');
  assert.equal(rows.format,'rgba32float');
  assert.equal(rows.mipPolicy,'none');
  assert.equal(rows.dataBytes,524288);
  assert.equal(rows.packedMips,undefined);
});

test('material state remains per pass and unknown authored defaults remain unavailable', () => {
  const rows = materialPassStateRows({ name: 'color', program: 'standard', renderState: { depthWriteEnabled: false } });
  assert.equal(rows.find(row => row.key === 'depthWriteEnabled').value, 'false');
  assert.equal(rows.find(row => row.key === 'blend').value, null);
});
