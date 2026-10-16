#!/usr/bin/env node
// build-wasm.mjs — Compile ufbx + bridge to WebAssembly via Emscripten.
//
// Prerequisites:
//   1. Install Emscripten SDK: https://emscripten.org/docs/getting_started/downloads.html
//   2. Run `emsdk activate latest` so `emcc` is on PATH
//   3. Run `pnpm fetch-ufbx` to download ufbx.h + ufbx.c
//
// Output: pkg/fbx-wasm.mjs + pkg/fbx-wasm.wasm
//
// The WASM module exports a single function `parseFbx(ptr, size) → ptr`
// that takes FBX file bytes and returns a JSON string pointer (same schema
// as @forgeax/engine-fbx binding.cc output).

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NATIVE = join(ROOT, 'src', 'native');
const PKG = join(ROOT, 'pkg');
const REPRODUCIBLE_PATH = `-ffile-prefix-map=${ROOT}=/forgeax/fbx`;

if (!existsSync(join(NATIVE, 'ufbx.c'))) {
  console.error('ufbx.c not found. Run `pnpm fetch-ufbx` first.');
  process.exit(1);
}

if (!existsSync(join(NATIVE, 'bridge.c'))) {
  console.error('bridge.c not found in src/native/.');
  process.exit(1);
}

// pkg/ is gitignored (zero-binary invariant) so a bare checkout has no such
// dir; emcc will not create the -o parent itself. Ensure it exists.
mkdirSync(PKG, { recursive: true });

// Emscripten compilation flags:
//   -O3                  : optimize for size+speed
//   -s WASM=1            : emit .wasm (not asm.js)
//   -s EXPORTED_FUNCTIONS: export malloc/free + our bridge function
//   -s EXPORTED_RUNTIME_METHODS: expose ccall/cwrap/UTF8ToString/stringToUTF8
//   -s ALLOW_MEMORY_GROWTH=1: FBX files can be large
//   -s MODULARIZE=1      : wrap in a factory function (ESM-friendly)
//   -s EXPORT_ES6=1      : emit ES6 module
//   -s ENVIRONMENT=web,node : browser + Node; the Node glue self-loads the
//                          .wasm via fs (no manual wasmBinary hand-off needed)
//   -s FILESYSTEM=0      : we use ufbx_load_memory, no FS needed
//   -s SINGLE_FILE=0     : keep .wasm separate for streaming compilation
//   -lm                  : link math library
const cmd = [
  'emcc',
  '-O3',
  REPRODUCIBLE_PATH,
  '-s WASM=1',
  '-s "EXPORTED_FUNCTIONS=[\'_parseFbxWasm\',\'_getResultPtr\',\'_getResultLen\',\'_freeResult\',\'_malloc\',\'_free\']"',
  '-s "EXPORTED_RUNTIME_METHODS=[\'ccall\',\'cwrap\',\'HEAPU8\',\'UTF8ToString\']"',
  '-s ALLOW_MEMORY_GROWTH=1',
  '-s MODULARIZE=1',
  '-s EXPORT_ES6=1',
  '-s ENVIRONMENT=web,node',
  '-s FILESYSTEM=0',
  '-s STACK_SIZE=1048576',
  '-lm',
  '-I', NATIVE,
  join(NATIVE, 'ufbx.c'),
  join(NATIVE, 'bridge.c'),
  '-o', join(PKG, 'fbx-wasm.mjs'),
].join(' ');

console.log('Building WASM...');
console.log(`  ${cmd}\n`);

try {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
  console.log('\nBuild complete:');
  console.log(`  ${join(PKG, 'fbx-wasm.mjs')}`);
  console.log(`  ${join(PKG, 'fbx-wasm.wasm')}`);
} catch (e) {
  console.error('\nEmscripten build failed. Is emcc on PATH?');
  console.error('Install: https://emscripten.org/docs/getting_started/downloads.html');
  process.exit(1);
}
