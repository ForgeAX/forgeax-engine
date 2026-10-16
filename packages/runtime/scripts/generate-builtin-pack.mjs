// generate-builtin-pack.mjs -- Generate builtin mesh .pack.json files.
//
// Usage:
//   tsx packages/runtime/scripts/generate-builtin-pack.mjs
//
// Generates packages/runtime/assets/builtin/{cube,quad,triangle}.pack.json
// with serialized vertex/index data from procedural geometry factories.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets', 'builtin');

// Builtin GUIDs (must match packages/pack/src/builtin.ts)
const BUILTIN_GUIDS = {
  cube: 'cbe42beb-8975-5096-b3a1-3dda4cb4c077',
  triangle: '22592f07-d967-5116-b29c-fa9781929ba8',
  quad: '339338aa-a338-581c-9fc5-744267ef8a51',
};

// Import geometry factories via dynamic import so tsx resolves .ts paths.
const boxMod = await import('../src/geometry/box.ts');
const planeMod = await import('../src/geometry/plane.ts');
const { createBoxGeometry, meshFromInterleaved } = boxMod;
const { createPlaneGeometry } = planeMod;

const TRIANGLE_INTERLEAVED = new Float32Array([
  0, 0.7, 0, 0, 0, 1, 0.5, 1,
  -0.7, -0.6, 0, 0, 0, 1, 0, 0,
  0.7, -0.6, 0, 0, 0, 1, 1, 0,
]);
const TRIANGLE_INDICES = new Uint16Array([0, 1, 2]);

function buildPackFile(guid, kind, vertices, indices) {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [{ guid, kind, payload: { vertices, indices, attributes: {} }, refs: [] }],
  }, null, 2) + '\n';
}

mkdirSync(ASSETS_DIR, { recursive: true });

// Cube
const cubeRes = createBoxGeometry(1, 1, 1);
if (!cubeRes.ok) throw new Error('createBoxGeometry(1,1,1) failed');
const cube = cubeRes.value;
writeFileSync(
  resolve(ASSETS_DIR, 'cube.pack.json'),
  buildPackFile(BUILTIN_GUIDS.cube, 'mesh', Array.from(cube.vertices), Array.from(cube.indices)),
);
console.log(`[generate] cube: ${cube.vertices.length / 12}v, ${cube.indices.length}i`);

// Quad
const quadRes = createPlaneGeometry(1, 1);
if (!quadRes.ok) throw new Error('createPlaneGeometry(1,1) failed');
const quad = quadRes.value;
writeFileSync(
  resolve(ASSETS_DIR, 'quad.pack.json'),
  buildPackFile(BUILTIN_GUIDS.quad, 'mesh', Array.from(quad.vertices), Array.from(quad.indices)),
);
console.log(`[generate] quad: ${quad.vertices.length / 12}v, ${quad.indices.length}i`);

// Triangle
const tri = meshFromInterleaved(TRIANGLE_INTERLEAVED, TRIANGLE_INDICES);
writeFileSync(
  resolve(ASSETS_DIR, 'triangle.pack.json'),
  buildPackFile(BUILTIN_GUIDS.triangle, 'mesh', Array.from(tri.vertices), Array.from(tri.indices)),
);
console.log(`[generate] triangle: ${tri.vertices.length / 12}v, ${tri.indices.length}i`);

console.log(`\nWritten to ${ASSETS_DIR}`);