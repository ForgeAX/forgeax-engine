#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run in a separate process: mini-game hosts can return a non-callable object
// from new Function. Exercise the actual glue and WASM, including init bindings.
const input = process.argv.slice(2).find((arg) => arg !== '--all');
const pkg = input
  ? pathToFileURL(`${resolve(input)}/`)
  : new URL('../pkg/', import.meta.url);
if (process.argv.includes('--all')) {
  const encoderFactory = (await import(new URL('encode/basis_encoder.mjs', pkg).href)).default;
  const encoderModule = await encoderFactory({
    locateFile: () => new URL('encode/basis_encoder.wasm', pkg).href, print() {},
  });
  encoderModule.initializeBasis();
  const encoder = new encoderModule.BasisEncoder();
  try {
    encoder.setSliceSourceImage(0, new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 0);
    encoder.setCreateKTX2File(true);
    encoder.setFormatMode(encoderModule.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.controlThreading(false, 0);
    assert.ok(encoder.encode(new Uint8Array(4096)) > 0, 'Basis encoder produced no KTX2 bytes');
  } finally { encoder.delete(); }
  console.log('Basis encoder initialized and encoded a real 4x4 KTX2 texture');
}
let attempts = 0;
globalThis.Function = function () {
  attempts++;
  return {};
};
const factory = (await import(new URL('basis_transcoder.mjs', pkg).href)).default;
const module = await factory({ locateFile: () => new URL('basis_transcoder.wasm', pkg).href });
module.initializeBasis();
assert.equal(typeof module.KTX2File, 'function');
assert.equal(attempts, 0, 'Basis transcoder requires dynamic Function construction');
console.log('Basis transcoder initialized without dynamic Function construction');
