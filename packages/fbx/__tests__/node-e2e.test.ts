// node-e2e.test.ts — real WASM init + parse end-to-end in the Node runtime.
//
// Replaces the prior "only test that parseFbx throws before init" coverage
// (AC-13): this drives the full initFbxWasm() -> parseFbx(bytes) path against
// a real sample and asserts the JSON POD has the expected top-level shape.
//
// Pre-fix (ENVIRONMENT=web glue) this is RED: the emcc glue ignores the
// Node fs / wasmBinary path and tries fetch(), which aborts. T4 switches the
// build to ENVIRONMENT=web,node so the glue self-loads the .wasm via fs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initFbxWasm, isFbxWasmReady, parseFbx, parseFbxToObject } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CUBE_FBX = join(HERE, '../../../forgeax-engine-assets/vendor/fbx-test/cube.fbx');

describe('fbx-wasm Node e2e (AC-13)', () => {
  beforeAll(async () => {
    await initFbxWasm();
  });

  it('initializes the WASM module in Node', () => {
    expect(isFbxWasmReady()).toBe(true);
  });

  it('parses cube.fbx and returns valid JSON with the POD top-level keys', () => {
    const bytes = new Uint8Array(readFileSync(CUBE_FBX));
    const json = parseFbx(bytes);
    expect(json.length).toBeGreaterThan(0);

    const pod = JSON.parse(json) as Record<string, unknown>;
    expect(pod).not.toHaveProperty('error');
    expect(pod).toHaveProperty('meshes');
    expect(pod).toHaveProperty('nodes');
    expect(Array.isArray(pod.meshes)).toBe(true);
    expect((pod.meshes as unknown[]).length).toBeGreaterThan(0);
  });

  it('parseFbxToObject returns a parsed object', () => {
    const bytes = new Uint8Array(readFileSync(CUBE_FBX));
    const pod = parseFbxToObject(bytes);
    expect(typeof pod).toBe('object');
    expect(pod).toHaveProperty('meshes');
  });
});
