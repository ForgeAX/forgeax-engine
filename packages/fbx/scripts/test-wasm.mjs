#!/usr/bin/env node
// test-wasm.mjs — quick smoke test for the compiled fbx-wasm module.
// Runs in Node.js (not the browser) using the compiled .mjs + .wasm.
//
// Usage: node scripts/test-wasm.mjs <path-to-fbx>
//   e.g.: node scripts/test-wasm.mjs ../../forgeax-engine-assets/vendor/fbx-test/cube.fbx

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');

// Emscripten builds with ENVIRONMENT=web, but we can make it work in Node
// by providing a locateFile that resolves the .wasm correctly.
const wasmPath = resolve(pkgDir, 'pkg', 'fbx-wasm.wasm');
const wasmBinary = readFileSync(wasmPath);

// Dynamic import of the Emscripten module (Windows needs file:// URLs)
import { pathToFileURL } from 'node:url';
const modulePath = pathToFileURL(resolve(pkgDir, 'pkg', 'fbx-wasm.mjs')).href;
const createModule = (await import(modulePath)).default;

const mod = await createModule({
  wasmBinary,
});

// Read the FBX file
const fbxPath = process.argv[2];
if (!fbxPath) {
  console.error('Usage: node scripts/test-wasm.mjs <path-to-fbx>');
  process.exit(1);
}

const verifying = fbxPath === '--verify';
const fbxBytes = verifying ? Buffer.from(`; FBX 7.4.0 project file
FBXHeaderExtension: { FBXHeaderVersion: 1003
FBXVersion: 7400
}
Objects: { Model: 1, "Model::Probe", "Null" { } }
Connections: { }
`) : readFileSync(resolve(fbxPath));
console.log(`Parsing: ${fbxPath} (${fbxBytes.length} bytes)`);

const ptr = mod._malloc(fbxBytes.length);
mod.HEAPU8.set(fbxBytes, ptr);
mod._parseFbxWasm(ptr, fbxBytes.length);
mod._free(ptr);

const resultPtr = mod._getResultPtr();
const resultLen = mod._getResultLen();

if (!resultPtr || !resultLen) {
  console.error('WASM returned empty result');
  mod._freeResult();
  process.exit(1);
}

const json = mod.UTF8ToString(resultPtr, resultLen);
mod._freeResult();

const parsed = JSON.parse(json);

if (parsed.error) {
  console.error('Parse error:', parsed.error);
  process.exit(1);
}
if (verifying) assert.ok(parsed.nodes?.some((node) => node.name === 'Probe'), 'FBX probe node missing');

console.log('\n=== FBX Parse Result ===');
console.log(`Meshes:     ${parsed.meshes?.length ?? 0}`);
console.log(`Nodes:      ${parsed.nodes?.length ?? 0}`);
console.log(`Materials:  ${parsed.materials?.length ?? 0}`);
console.log(`Skeletons:  ${parsed.skeletons?.length ?? 0}`);
console.log(`Skins:      ${parsed.skins?.length ?? 0}`);
console.log(`Clips:      ${parsed.clips?.length ?? 0}`);

if (parsed.meshes?.length > 0) {
  const m = parsed.meshes[0];
  console.log(`\nFirst mesh: "${m.name ?? '(unnamed)'}"`);
  console.log(`  vertices: ${m.vertices.length / 3} positions`);
  console.log(`  indices:  ${m.indices?.length ?? 0}`);
  console.log(`  polygons: ${m.polygonCount}`);
  console.log(`  attrs:    ${Object.keys(m.attributes).join(', ')}`);
}

if (parsed.skeletons?.length > 0) {
  const s = parsed.skeletons[0];
  console.log(`\nSkeleton: ${s.jointCount} joints`);
  console.log(`  jointPaths: ${s.jointPaths.slice(0, 5).join(', ')}${s.jointCount > 5 ? '...' : ''}`);
}

if (parsed.clips?.length > 0) {
  const c = parsed.clips[0];
  console.log(`\nFirst clip: "${c.name ?? '(unnamed)'}" (${c.duration.toFixed(3)}s, ${c.channels.length} channels)`);
}

console.log('\n✅ WASM FBX parsing test passed!');
