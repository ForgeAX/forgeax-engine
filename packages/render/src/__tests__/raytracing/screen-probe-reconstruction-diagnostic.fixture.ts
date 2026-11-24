import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onTestFailed } from 'vitest';

/** Intrusive phase observation only; original deadlines and operations are unchanged. */
export function reconstructionPhase(stage: string, detail?: unknown) {
  const directory = process.env.FORGEAX_SCREEN_RECONSTRUCTION_DIAGNOSTIC_DIR;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    `${directory}/phases.jsonl`,
    `${JSON.stringify({ stage, atMs: performance.now(), detail })}\n`,
  );
}

export function observeReconstructionFailure(kind: string) {
  if (process.env.FORGEAX_SCREEN_RECONSTRUCTION_DIAGNOSTIC_DIR === undefined) return;
  onTestFailed(({ task }) => {
    reconstructionPhase('onTestFailed', {
      kind,
      errors: task.result?.errors?.map((error) => ({
        name: error.name,
        message: error.message,
        cause: error.cause === undefined ? null : String(error.cause),
      })),
    });
  });
}

/** Opt-in observation of this raw WebGPU fixture. These local object IDs are
 * JS reference identities, not RHI tape handles or native backend IDs. Every
 * action still uses the original device, descriptors, buffers and submissions.
 */
export function reconstructionDiagnostic(device: GPUDevice, wgsl: string) {
  const directory = process.env.FORGEAX_SCREEN_RECONSTRUCTION_DIAGNOSTIC_DIR;
  const events: unknown[] = [];
  const scoped: Promise<{ readonly stage: string; readonly validation: string | null }>[] = [];
  const ids = new WeakMap<object, number>();
  let sequence = 0;
  const id = (object: object) => {
    let value = ids.get(object);
    if (value === undefined) {
      value = ++sequence;
      ids.set(object, value);
    }
    return value;
  };
  const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const scope = <T>(stage: string, action: () => T): T => {
    if (directory === undefined) return action();
    reconstructionPhase(`${stage}:before`);
    device.pushErrorScope('validation');
    try {
      return action();
    } finally {
      reconstructionPhase(`${stage}:after`);
      scoped.push(
        device.popErrorScope().then((error) => ({ stage, validation: error?.message ?? null })),
      );
    }
  };
  const binding = (entry: GPUBindGroupEntry) => {
    const resource = entry.resource;
    if ('buffer' in resource)
      return {
        binding: entry.binding,
        buffer: id(resource.buffer),
        offset: resource.offset ?? 0,
        size: resource.size ?? resource.buffer.size - (resource.offset ?? 0),
      };
    return { binding: entry.binding, viewOrSampler: id(resource) };
  };
  return {
    scope,
    buffer(buffer: GPUBuffer, data: Uint8Array) {
      if (directory !== undefined)
        events.push({
          op: 'buffer',
          id: id(buffer),
          size: buffer.size,
          usage: buffer.usage,
          initialSha256: sha(data),
        });
    },
    layout(stage: string, descriptor: GPUBindGroupLayoutDescriptor) {
      const value = scope(`${stage}:layout`, () => device.createBindGroupLayout(descriptor));
      if (directory !== undefined)
        events.push({
          op: 'bindGroupLayout',
          stage,
          id: id(value),
          entries: Array.from(descriptor.entries),
        });
      return value;
    },
    pipeline(
      stage: string,
      descriptor: GPUComputePipelineDescriptor,
      layouts: readonly GPUBindGroupLayout[],
    ) {
      const value = scope(`${stage}:pipeline`, () => device.createComputePipeline(descriptor));
      if (directory !== undefined)
        events.push({
          op: 'computePipeline',
          stage,
          id: id(value),
          entryPoint: descriptor.compute.entryPoint,
          layouts: layouts.map(id),
          shaderSha256: sha(wgsl),
        });
      return value;
    },
    group(stage: string, descriptor: GPUBindGroupDescriptor) {
      const value = scope(`${stage}:bindGroup`, () => device.createBindGroup(descriptor));
      if (directory !== undefined)
        events.push({
          op: 'bindGroup',
          stage,
          id: id(value),
          layout: id(descriptor.layout),
          entries: Array.from(descriptor.entries, binding),
        });
      return value;
    },
    read(stage: string, source: GPUBuffer, staging: GPUBuffer, actual: Uint8Array) {
      if (directory === undefined) return;
      mkdirSync(directory, { recursive: true });
      const file = `${events.length}-${stage}.bin`;
      writeFileSync(`${directory}/${file}`, actual);
      events.push({
        op: 'copy-submit-map-read',
        stage,
        source: id(source),
        destination: id(staging),
        sourceOffset: 0,
        destinationOffset: 0,
        size: source.size,
        file,
        sha256: sha(actual),
        firstFloats: Array.from(
          new Float32Array(actual.buffer, actual.byteOffset, Math.min(24, actual.byteLength / 4)),
        ),
      });
    },
    async finish(errors: string[]) {
      if (directory === undefined) return;
      mkdirSync(directory, { recursive: true });
      const validationScopes = await Promise.all(scoped);
      for (const result of validationScopes)
        if (result.validation !== null && !errors.includes(result.validation))
          errors.push(result.validation);
      writeFileSync(
        `${directory}/raw-observation.json`,
        JSON.stringify(
          {
            scope: 'Original raw WebGPU fixture observation; no RHI tape',
            shaderSha256: sha(wgsl),
            errors,
            validationScopes,
            events,
          },
          null,
          2,
        ),
      );
    },
  };
}

/** Only this opt-in local diagnostic selects exact hardware. Portable Dawn
 * tests retain their original adapter contract and do not execute this guard.
 */
export function guardReconstructionAdapter(adapter: GPUAdapter) {
  const directory = process.env.FORGEAX_SCREEN_RECONSTRUCTION_DIAGNOSTIC_DIR;
  if (directory === undefined) return;
  const info = adapter.info as GPUAdapterInfo & { readonly backend?: unknown };
  const actual = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    backend: info.backend,
    isFallbackAdapter: 'isFallbackAdapter' in adapter ? adapter.isFallbackAdapter : null,
  };
  const require = createRequire(import.meta.url);
  const path = fileURLToPath(
    new URL(
      '../../../../rhi-wgpu-native/native/forgeax-rhi-wgpu-native.win32-x64.node',
      import.meta.url,
    ),
  );
  const loaded = require.cache[require.resolve(path)]?.loaded === true;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/adapter-before-device.json`,
    JSON.stringify(
      {
        beforeRequestDevice: true,
        pid: process.pid,
        parentPid: process.ppid,
        actual,
        native: { path, sha256, loaded },
      },
      null,
      2,
    ),
  );
  assert(loaded, 'The qualified native addon must be loaded before requestDevice');
  assert.equal(sha256, 'f76dd9aa7f73ec91c37adfa3cb7c0d462b2ee1ad4144836d63f4377070e0c54d');
  assert.deepEqual(actual, {
    vendor: '0x10de',
    architecture: '',
    device: 'NVIDIA GeForce RTX 4080',
    description: '32.0.16.1742 ()',
    backend: 'Dx12',
    isFallbackAdapter: false,
  });
}
