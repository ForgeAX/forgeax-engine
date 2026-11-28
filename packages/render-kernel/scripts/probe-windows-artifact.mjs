#!/usr/bin/env node
// Clean-PATH relocated runtime probe for forgeax-render-kernel.win32-x64.node on Windows.
// Loads the packed .node binary from an isolated directory without compiler/source PATH,
// verifies DX12 adapter selection, 4-BGL 3D render + pixel readback, and 60 async frames.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { filename, inspectWindowsBinary } from './windows-artifact.mjs';

const directory = resolve(process.argv[2]);
const binary = readFileSync(join(directory, filename));
const imports = inspectWindowsBinary(binary);

const script = `
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  const binding = require(process.argv[1]);
  if (!binding.nativeKernelVersion().includes('30.0.1')) {
    throw new Error('render-kernel-version-mismatch:' + binding.nativeKernelVersion());
  }
  const handle = new binding.NativeRenderKernelHandle(2, null);
  try {
    const st0 = handle.stats();
    if (st0.backendName !== 'Dx12') {
      throw new Error('render-kernel-expected-dx12-got:' + st0.backendName);
    }
    const cs = handle.registerShaderProgram(JSON.stringify({
      code: '@group(0) @binding(0) var<storage, read_write> d: array<u32>; @compute @workgroup_size(4) fn cs_main(@builtin(global_invocation_id) g: vec3<u32>) { d[g.x] = d[g.x] * 3u + 1u; }',
      computeEntryPoint: 'cs_main',
      layoutFamilyId: 0,
    }));
    const buf = handle.createBuffer(
      JSON.stringify({ size: 16, usage: 0x80 | 0x04 | 0x08 }),
      new Uint8Array(new Uint32Array([1, 2, 3, 4]).buffer),
    );
    const hdr = (op, len) => (((len & 0xffff) << 16) | (op & 0xffff)) >>> 0;
    const cmds = new Uint32Array([
      hdr(0x02, 6), 1, 1, 0 | (3 << 16), buf, 0,
      hdr(0x20, 2), 1,
      hdr(0x21, 8), cs, 1, 0, 0, 1, 1, 1,
      hdr(0x23, 1),
    ]);
    handle.beginFrame(1, 16, 16);
    handle.submitFrameSync(cmds, new Uint8Array(0));
    const rb = handle.readbackBuffer(buf, 0, 16);
    const vals = Array.from(new Uint32Array(rb.buffer, rb.byteOffset, 4));
    if (vals.join(',') !== '4,7,10,13') {
      throw new Error('render-kernel-compute-mismatch:' + vals.join(','));
    }
    for (let f = 2; f <= 61; f++) {
      handle.submitPipelinedFrameAsync(f, 16, 16, null, '[]', new Uint32Array(0), new Uint8Array(0));
    }
    handle.flush();
    const st1 = handle.stats();
    if (st1.completedFrames !== 61 || st1.inFlightFrames !== 0) {
      throw new Error('render-kernel-async-mismatch:' + JSON.stringify(st1));
    }
    console.log(JSON.stringify({
      node: process.versions.node,
      version: binding.nativeKernelVersion(),
      adapter: st1.adapterName,
      backend: st1.backendName,
      completedFrames: st1.completedFrames,
      computeValues: vals,
    }, null, 2));
  } finally {
    handle.dispose();
  }
`;

const env = {
  PATH: dirname(process.execPath),
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const result = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', script, join(directory, filename)],
  { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60000 },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({ peImportsVerified: imports.length }));
