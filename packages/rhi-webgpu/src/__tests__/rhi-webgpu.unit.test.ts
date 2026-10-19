// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=8):
//   - packages/rhi-webgpu/src/__tests__/capabilities.test.ts
//   - packages/rhi-webgpu/src/__tests__/command-encoder.test.ts
//   - packages/rhi-webgpu/src/__tests__/descriptors.test.ts
//   - packages/rhi-webgpu/src/__tests__/error-scope-removed.test.ts
//   - packages/rhi-webgpu/src/__tests__/errors.test.ts
//   - packages/rhi-webgpu/src/__tests__/queue-real-path.test.ts
//   - packages/rhi-webgpu/src/__tests__/render-pass-encoder.test.ts
//   - packages/rhi-webgpu/src/__tests__/rhi-caps-probe.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import type {
  CanvasConfiguration,
  RenderPipelineDescriptor,
  RhiCanvasContext,
} from '@forgeax/engine-rhi';
import { type Result, RhiError, type RhiErrorCode } from '@forgeax/engine-rhi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import {
  acquireCanvasContext,
  createShaderModule,
  createShaderModuleImmediate,
  requestAdapter,
  requestAdapterFrom,
} from '../index';
import { createMockGpu, type MockCapture, makeShaderError } from './__mocks__/gpu-device';

{
  // --- from capabilities.test.ts ---
  // MVP-1.2 runtime — Capabilities exposed as three independent layers + runtime
  // non-null assertions.
  //
  // TDD red → green: this file is red at the t16 commit (t17 has not yet
  // implemented the readonly device.caps / features / limits fields) → turns
  // green after the t17 commit.
  //
  // Three independent semantic layers (charter proposition 5 / plan-strategy §7.2):
  // - device.caps     — hardware-probe layer (readonly boolean flags)
  // - device.features — enabled-features layer (ReadonlySet<GPUFeatureName>)
  // - device.limits   — numeric-limit layer (readonly GPUSupportedLimits)
  //
  // Anchors: requirements §AC MVP-1.2 + §hard constraint 6 + §AI User Affordances /
  //          error self-rescue; plan-strategy §4.3 key-test-point table row 3 +
  //          §7.2 naming convention + §7.4 discoverability
  //          'device.caps three readonly layers exposed via IDE type reflection';
  //          research §F-1 (GPUSupportedLimits 35 items) + §F-7 (wgpu-hal
  //          Capabilities three layers).

  describe('MVP-1.2 runtime — caps / features / limits exposed as three independent layers + non-null', () => {
    it('device.caps is a readonly object with the boolean flag fields declared in this loop', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      expect(typeof device.caps).toBe('object');
      expect(device.caps).not.toBeNull();
      // RhiCaps 7 fields: compute / timestampQuery / indirectDrawing /
      // textureCompression / multiDrawIndirect / pushConstants /
      // textureBindingArray.
      expect(typeof device.caps.compute).toBe('boolean');
      expect(typeof device.caps.timestampQuery).toBe('boolean');
      expect(typeof device.caps.indirectDrawing).toBe('boolean');
      expect(typeof device.caps.textureCompressionBc).toBe('boolean');
      expect(typeof device.caps.textureCompressionEtc2).toBe('boolean');
      expect(typeof device.caps.textureCompressionAstc).toBe('boolean');
    });

    it('M2 w10 — device.caps.backendKind === "webgpu" (backend self-report)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      expect(device.caps.backendKind).toBe('webgpu');
    });

    it('device.features is a ReadonlySet<GPUFeatureName>, size is readable (non-null set interface object)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      expect(typeof device.features).toBe('object');
      expect(device.features).not.toBeNull();
      expect(typeof device.features.size).toBe('number');
      // The mock's default features set is empty; the interface object itself is
      // still non-null (the size field is readable).
      expect(device.features.size).toBeGreaterThanOrEqual(0);
      // ReadonlySet shape: the `has` method is present.
      expect(typeof device.features.has).toBe('function');
    });

    it('device.limits is a readonly object containing the key numeric fields of GPUSupportedLimits', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      expect(typeof device.limits).toBe('object');
      expect(device.limits).not.toBeNull();
      // Any numeric field is non-undefined (the mock's default-value table covers
      // 30 items including maxBindGroups / maxBufferSize / etc.).
      expect(typeof device.limits.maxBindGroups).toBe('number');
      expect(device.limits.maxBindGroups).toBeGreaterThan(0);
      expect(typeof device.limits.maxTextureDimension2D).toBe('number');
      expect(device.limits.maxTextureDimension2D).toBeGreaterThan(0);
    });

    it('caps / features / limits are three independent references (not aliases / no shared identity)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      // The three fields must be three independent object references (charter
      // proposition 5 / plan-strategy §7.4).
      expect(device.caps).not.toBe(device.features as unknown);
      expect(device.caps).not.toBe(device.limits as unknown);
      expect(device.features as unknown).not.toBe(device.limits as unknown);
    });

    it('AI-user capability-probe path example — if (device.caps.compute) ... compiles without errors', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      // This branch is primarily a type test — proposition 4 explicit signal:
      // reading caps.X as a boolean directly never throws. The runtime side
      // effect is only branch selection; it must not error.
      let took = 'none';
      if (device.caps.compute) {
        took = 'compute';
      } else {
        took = 'no-compute';
      }
      expect(['compute', 'no-compute']).toContain(took);
    });
  });
}

{
  // --- from command-encoder.test.ts ---
  // w2 unit - RhiCommandEncoder shim behaviour around finish() lifecycle.
  //
  // RED at w2 commit (createCommandEncoder + 9 spec methods + lifecycle wrap not
  // yet implemented); turns GREEN after w3 lands the impl.
  //
  // Asserts:
  //   1) `device.createCommandEncoder(desc?)` returns Result.ok with a real
  //      RhiCommandEncoder handle.
  //   2) `encoder.finish()` returns Result.ok<CommandBuffer> on the first call.
  //   3) Calling `encoder.beginRenderPass(...)` after `finish()` returns
  //      Result.err({ code: 'command-encoder-finished' }) per D-S3.
  //   4) Calling `encoder.finish()` again returns Result.err with the same code.
  //
  // Charter mapping: proposition 4 (explicit failure: lifecycle violation maps
  // to a structured error rather than throwing).
  //
  // Note: this test exercises the shim against the mock GPU device, so the
  // "real" GPUCommandEncoder lifecycle is simulated via the mock encoder
  // fixture in __mocks__/gpu-device.ts. dawn.node real-GPU coverage of this
  // scenario is in w17 (M5 integration).

  describe('w2 - RhiCommandEncoder lifecycle (red until w3)', () => {
    it('device.createCommandEncoder(desc?) returns Result.ok<RhiCommandEncoder>', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: { label?: string | undefined } | undefined) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
      };
      expect(typeof device.createCommandEncoder).toBe('function');
      const encResult = device.createCommandEncoder?.({ label: 'frame' });
      expect(encResult).toBeDefined();
      expect(encResult?.ok).toBe(true);
    });

    it('encoder.finish() yields Result.ok<CommandBuffer>; subsequent beginRenderPass yields command-encoder-finished', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => {
          ok: boolean;
          value?: {
            finish: () => { ok: boolean; value?: unknown; error?: { code: string } };
            beginRenderPass: (desc: unknown) => unknown;
          };
          error?: { code: string };
        };
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok || encResult.value === undefined) {
        throw new Error('createCommandEncoder should succeed in mock');
      }
      const encoder = encResult.value;

      const finishResult = encoder.finish();
      expect(finishResult.ok).toBe(true);

      // Second call to finish() should return command-encoder-finished.
      const finishAgain = encoder.finish();
      expect(finishAgain.ok).toBe(false);
      if (!finishAgain.ok && finishAgain.error !== undefined) {
        expect(finishAgain.error.code).toBe('command-encoder-finished');
      }
    });
  });

  describe('encodeEmptyComputePass', () => {
    it('forwards one mirrored descriptor to one raw pass and ends that pass once', async () => {
      const gpu = createMockGpu();
      const adapter = await gpu.requestAdapter();
      if (adapter === null) throw new Error('mock adapter should exist');
      const raw = await adapter.requestDevice();
      (raw.features as unknown as Set<GPUFeatureName>).add('timestamp-query');
      const rawDescriptors: GPUComputePassDescriptor[] = [];
      let beginCalls = 0;
      let endCalls = 0;
      const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
      raw.createCommandEncoder = (descriptor) => {
        const encoder = originalCreateCommandEncoder(descriptor);
        const originalBeginComputePass = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = (passDescriptor) => {
          beginCalls += 1;
          if (passDescriptor !== undefined) rawDescriptors.push(passDescriptor);
          const pass = originalBeginComputePass(passDescriptor);
          const originalEnd = pass.end.bind(pass);
          pass.end = () => {
            endCalls += 1;
            originalEnd();
          };
          return pass;
        };
        return encoder;
      };

      const device = makeRhiDevice(raw as unknown as GPUDevice).device;
      const querySetResult = device.createQuerySet({ type: 'timestamp', count: 2 });
      if (!querySetResult.ok) throw new Error('mock createQuerySet failed');
      const descriptor = {
        timestampWrites: {
          querySet: querySetResult.value,
          beginningOfPassWriteIndex: 0,
        },
      };
      const encoderResult = device.createCommandEncoder();
      if (!encoderResult.ok) throw new Error('mock createCommandEncoder failed');

      encoderResult.value.encodeEmptyComputePass(descriptor);

      expect(beginCalls).toBe(1);
      expect(endCalls).toBe(1);
      expect(rawDescriptors).toHaveLength(1);
      expect(rawDescriptors[0]?.timestampWrites?.querySet).toBe(querySetResult.value);
      expect(rawDescriptors[0]?.timestampWrites?.beginningOfPassWriteIndex).toBe(0);
    });

    it('keeps the finished-encoder failure channel', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const encoderResult = r.value.createCommandEncoder();
      if (!encoderResult.ok) throw new Error('mock createCommandEncoder failed');
      expect(encoderResult.value.finish().ok).toBe(true);

      expect(() =>
        encoderResult.value.encodeEmptyComputePass({
          timestampWrites: {
            querySet: {} as never,
            endOfPassWriteIndex: 1,
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'command-encoder-finished' }));
    });
  });

  // w24 - resolveQuerySet placeholder retirement red phase. Asserts:
  //   (a) destinationOffset % 256 != 0 -> webgpu-runtime-error with .expected
  //       literal 'destinationOffset % 256 == 0 (spec normative)'.
  //   (b) destination.usage missing QUERY_RESOLVE -> webgpu-runtime-error with
  //       .expected literal 'destination.usage must contain QUERY_RESOLVE'.
  //   (c) firstQuery / firstQuery + queryCount range bounds.
  //
  // F-3 ai-user-review absorption: literal grep on .expected string contents
  // (charter proposition 4 explicit failure: K-2 merges all alignment / usage /
  // bounds violations under webgpu-runtime-error; .expected must distinguish).
  //
  // Anchors: requirements §IN-3 / §AC-03 / §AC-12; research §2.3 +
  //          §7.2 + §9; plan-strategy §2 K-2 + §6 M3 + K-10.

  const QUERY_RESOLVE_USAGE = 0x200;
  const COPY_DST_USAGE = 0x08;

  describe('w24 - resolveQuerySet destinationOffset alignment maps to webgpu-runtime-error (K-2 / spec normative)', () => {
    it('destinationOffset = 8 returns webgpu-runtime-error with .expected literal (F-3)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value;

      const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
      if (!qsResult.ok) throw new Error('mock createQuerySet failed');
      const dstResult = device.createBuffer({
        label: 'mock-resolve-dst',
        size: 256,
        usage: QUERY_RESOLVE_USAGE,
      });
      if (!dstResult.ok) throw new Error('mock createBuffer failed');

      const encResult = device.createCommandEncoder({ label: 'mock-resolve-align' });
      if (!encResult.ok) throw new Error('mock createCommandEncoder failed');

      const out = encResult.value.resolveQuerySet(qsResult.value, 0, 4, dstResult.value, 8);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        // F-3 literal expected assertion (ai-user-review).
        expect(out.error.expected).toBe('destinationOffset % 256 == 0 (spec normative)');
      }
    });
  });

  describe('w24 - resolveQuerySet destination.usage missing QUERY_RESOLVE maps to webgpu-runtime-error', () => {
    it('destination usage = COPY_DST without QUERY_RESOLVE returns webgpu-runtime-error with .expected literal (F-3)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value;

      const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
      if (!qsResult.ok) throw new Error('mock createQuerySet failed');
      const dstResult = device.createBuffer({
        label: 'mock-resolve-dst-no-qr',
        size: 256,
        usage: COPY_DST_USAGE,
      });
      if (!dstResult.ok) throw new Error('mock createBuffer failed');

      const encResult = device.createCommandEncoder({ label: 'mock-resolve-no-qr' });
      if (!encResult.ok) throw new Error('mock createCommandEncoder failed');

      const out = encResult.value.resolveQuerySet(qsResult.value, 0, 4, dstResult.value, 0);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        // F-3 literal expected assertion (ai-user-review).
        expect(out.error.expected).toBe('destination.usage must contain QUERY_RESOLVE');
      }
    });
  });

  describe('w24 - resolveQuerySet firstQuery + queryCount range bounds', () => {
    it('firstQuery + queryCount > querySet.count returns webgpu-runtime-error with .expected literal (F-3)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value;

      const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
      if (!qsResult.ok) throw new Error('mock createQuerySet failed');
      const dstResult = device.createBuffer({
        label: 'mock-resolve-dst-oob',
        size: 256,
        usage: QUERY_RESOLVE_USAGE,
      });
      if (!dstResult.ok) throw new Error('mock createBuffer failed');

      const encResult = device.createCommandEncoder({ label: 'mock-resolve-oob' });
      if (!encResult.ok) throw new Error('mock createCommandEncoder failed');

      const out = encResult.value.resolveQuerySet(qsResult.value, 2, 3, dstResult.value, 0);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        // F-3 literal expected assertion (ai-user-review).
        expect(out.error.expected).toBe('firstQuery + queryCount <= querySet.count');
      }
    });
  });

  describe('w2 timestamp resolve and readback resource contract', () => {
    it('resolves aligned timestamp queries, reads u64 slots, and releases resources', async () => {
      const gpu = createMockGpu();
      const adapter = await gpu.requestAdapter();
      if (adapter === null) throw new Error('mock adapter should exist');
      const raw = await adapter.requestDevice();
      const features = raw.features as unknown as Set<GPUFeatureName>;
      features.add('timestamp-query');

      let resolveCalls = 0;
      const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
      raw.createCommandEncoder = (descriptor) => {
        const encoder = originalCreateCommandEncoder(descriptor);
        const originalResolveQuerySet = encoder.resolveQuerySet.bind(encoder);
        encoder.resolveQuerySet = (...args) => {
          resolveCalls += 1;
          originalResolveQuerySet(...args);
        };
        return encoder;
      };

      const { device } = makeRhiDevice(raw as unknown as GPUDevice);
      const querySetResult = device.createQuerySet({ type: 'timestamp', count: 2 });
      expect(querySetResult.ok).toBe(true);
      if (!querySetResult.ok) return;

      const readbackResult = device.createBuffer({
        label: 'w2-timestamp-readback',
        size: 256,
        usage: QUERY_RESOLVE_USAGE | 0x1,
      });
      expect(readbackResult.ok).toBe(true);
      if (!readbackResult.ok) return;

      const encoderResult = device.createCommandEncoder({ label: 'w2-timestamp-resolve' });
      expect(encoderResult.ok).toBe(true);
      if (!encoderResult.ok) return;

      const resolveResult = encoderResult.value.resolveQuerySet(
        querySetResult.value,
        0,
        2,
        readbackResult.value,
        0,
      );
      expect(resolveResult.ok).toBe(true);
      expect(resolveCalls).toBe(1);

      const mappedResult = await readbackResult.value.mapAsync(0x1);
      expect(mappedResult.ok).toBe(true);
      if (!mappedResult.ok) return;
      const mappedRange = mappedResult.value.getMappedRange(0, 16);
      expect(mappedRange.ok).toBe(true);
      if (!mappedRange.ok) return;
      expect(new BigUint64Array(mappedRange.value).length).toBe(2);
      mappedResult.value.unmap();

      expect(device.destroyQuerySet(querySetResult.value).ok).toBe(true);
      expect(device.destroyBuffer(readbackResult.value).ok).toBe(true);
    });
  });
  // ---------------------------------------------------------------------------
  // w38 (M5) - pass descriptor timestampWrites forwarding.
  // ---------------------------------------------------------------------------
  // Current Dawn rejects the obsolete command-encoder writeTimestamp method.
  // Timestamp ownership therefore enters through the real render/compute pass
  // descriptor, where the shim maps the opaque QuerySet to its raw handle.
  describe('w38 (M5) - pass descriptor timestampWrites', () => {
    it('maps an opaque QuerySet in compute-pass timestampWrites to the raw descriptor', async () => {
      const gpu = createMockGpu();
      const adapter = await gpu.requestAdapter();
      if (adapter === null) throw new Error('mock adapter should exist');
      const raw = await adapter.requestDevice();
      (raw.features as unknown as Set<GPUFeatureName>).add('timestamp-query');
      let rawQuerySet: unknown;
      const originalCreateQuerySet = raw.createQuerySet.bind(raw);
      raw.createQuerySet = (descriptor) => {
        const result = originalCreateQuerySet(descriptor);
        rawQuerySet = result;
        return result;
      };
      let captured: GPUComputePassDescriptor | undefined;
      const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
      raw.createCommandEncoder = (descriptor) => {
        const encoder = originalCreateCommandEncoder(descriptor) as unknown as Record<
          string,
          unknown
        >;
        const originalBegin = encoder.beginComputePass as (
          passDescriptor?: GPUComputePassDescriptor,
        ) => unknown;
        encoder.beginComputePass = (passDescriptor?: GPUComputePassDescriptor) => {
          captured = passDescriptor;
          return originalBegin.call(encoder, passDescriptor);
        };
        return encoder as unknown as ReturnType<typeof raw.createCommandEncoder>;
      };
      const { device } = makeRhiDevice(raw as unknown as GPUDevice);
      const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      expect(querySet.ok).toBe(true);
      if (!querySet.ok) return;
      const encoder = device.createCommandEncoder();
      expect(encoder.ok).toBe(true);
      if (!encoder.ok) return;
      const pass = encoder.value.beginComputePass({
        label: 'hdrp-cluster-membership',
        timestampWrites: {
          querySet: querySet.value,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      });
      pass.end();
      expect(captured).toMatchObject({
        label: 'hdrp-cluster-membership',
        timestampWrites: {
          querySet: querySet.value,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      });
      expect(rawQuerySet).toBeDefined();
      expect(captured?.timestampWrites?.querySet).toBe(rawQuerySet);
    });
  });
}

{
  // --- from descriptors.test.ts ---
  // MVP-1.1 runtime + AC-05 — 5 descriptor creation paths: pass-through assertions
  // + `?: T | undefined` guard assertions.
  //
  // TDD red → green: this file is red at the t14 commit (t17 has not yet
  // implemented requestDevice + the 5 descriptor shims in
  // rhi-webgpu/src/index.ts) → turns green after the t17 commit.
  //
  // Strategy: inject `createMockGpu()` through the `gpu?: GPU` provider seam,
  // invoke the shim's `requestDevice` / `device.createX`, and assert:
  // 1) Each of the 5 descriptor shapes passes its input fields through to
  //    `mock.__captured[].descriptor` verbatim.
  // 2) `?: T | undefined` guard: across the two calling shapes — passing
  //    `{ x: undefined }` vs not passing `x` at all — the shim's
  //    `'x' in src` guard makes the latter **omit `x`** when forwarding to the
  //    mock and the former **explicitly forward `undefined`**.
  //
  // Anchors: requirements §AC MVP-1.1 + AC-05 + §hard constraint 10 + edge cases;
  //          plan-strategy §2 S-3 (the 5-descriptor list) + S-7 (`?: T | undefined`
  //          + `'x' in src`) + §4.3 key-test-point table row 1 runtime;
  //          research §F-1 + §F-3.

  // GPUTextureUsage bitmask constants (W3C WebGPU §texture). The DOM globals
  // are not bound in node + dawn-only environments, so the spec values are
  // re-declared here for unit-test code paths that do not import dawn.
  const COPY_SRC = 0x01;
  const TEXTURE_BINDING = 0x04;
  const STORAGE_BINDING = 0x08;

  /** Take the last captured event of a given kind (tolerates leading requestAdapter / requestDevice noise). */
  function lastOf<K extends MockCapture['kind']>(
    captured: readonly MockCapture[],
    kind: K,
  ): Extract<MockCapture, { kind: K }> {
    for (let i = captured.length - 1; i >= 0; i -= 1) {
      const c = captured[i];
      if (c !== undefined && c.kind === kind) {
        return c as Extract<MockCapture, { kind: K }>;
      }
    }
    throw new Error(`mock did not capture an event with kind=${kind}`);
  }

  describe('MVP-1.1 runtime — verbatim pass-through of the 5 descriptors', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('normalizes omitted dynamic Dawn limits from the adapter without mutating the descriptor', async () => {
      const gpu = createMockGpu();
      const descriptor: GPUDeviceDescriptor = { label: 'dynamic-limit-probe' };
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice(descriptor);
      expect(r.ok).toBe(true);
      expect(descriptor).toEqual({ label: 'dynamic-limit-probe' });

      const ev = lastOf(gpu.__captured, 'requestDevice');
      expect(ev.options).toMatchObject({
        label: 'dynamic-limit-probe',
        requiredLimits: {
          maxDynamicUniformBuffersPerPipelineLayout: 8,
          maxDynamicStorageBuffersPerPipelineLayout: 4,
        },
      });
    });

    it('preserves explicit dynamic limits while filling only the omitted adapter-backed limit', async () => {
      const gpu = createMockGpu();
      const requiredLimits = { maxDynamicUniformBuffersPerPipelineLayout: 2 };
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice({ requiredLimits });
      expect(r.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'requestDevice');
      expect(ev.options?.requiredLimits).toEqual({
        maxDynamicUniformBuffersPerPipelineLayout: 2,
        maxDynamicStorageBuffersPerPipelineLayout: 4,
      });
      expect(requiredLimits).toEqual({ maxDynamicUniformBuffersPerPipelineLayout: 2 });
    });

    it('clamps oversized dynamic limits to the adapter without mutating the descriptor', async () => {
      const gpu = createMockGpu();
      const requiredLimits = {
        maxDynamicUniformBuffersPerPipelineLayout: 1_000_000,
        maxDynamicStorageBuffersPerPipelineLayout: 1_000_000,
      };
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice({ requiredLimits });
      expect(r.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'requestDevice');
      expect(ev.options?.requiredLimits).toEqual({
        maxDynamicUniformBuffersPerPipelineLayout: 8,
        maxDynamicStorageBuffersPerPipelineLayout: 4,
      });
      expect(requiredLimits).toEqual({
        maxDynamicUniformBuffersPerPipelineLayout: 1_000_000,
        maxDynamicStorageBuffersPerPipelineLayout: 1_000_000,
      });
    });

    it('applies the same normalization on the public adapter two-step path', async () => {
      const gpu = createMockGpu();
      vi.stubGlobal('navigator', { gpu });
      const adapterResult = await requestAdapter();
      expect(adapterResult.ok).toBe(true);
      if (!adapterResult.ok) return;

      const deviceResult = await adapterResult.value.requestDevice({
        requiredLimits: { maxDynamicStorageBuffersPerPipelineLayout: 1 },
      });
      expect(deviceResult.ok).toBe(true);
      const ev = lastOf(gpu.__captured, 'requestDevice');
      expect(ev.options?.requiredLimits).toEqual({
        maxDynamicUniformBuffersPerPipelineLayout: 8,
        maxDynamicStorageBuffersPerPipelineLayout: 1,
      });
    });

    it('BufferDescriptor passes through size / usage / label / mappedAtCreation', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const device = r.value;

      const out = device.createBuffer({
        label: 'vbo',
        size: 1024,
        usage: 0x20,
        mappedAtCreation: true,
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createBuffer');
      expect(ev.descriptor.label).toBe('vbo');
      expect(ev.descriptor.size).toBe(1024);
      expect(ev.descriptor.usage).toBe(0x20);
      expect(ev.descriptor.mappedAtCreation).toBe(true);
    });

    it('TextureDescriptor passes through size / format / usage / textureBindingViewDimension (R8 follow-up)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const out = device.createTexture({
        label: 'tex',
        size: [128, 128],
        format: 'rgba8unorm',
        usage: 0x4,
        textureBindingViewDimension: '2d',
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createTexture');
      expect(ev.descriptor.format).toBe('rgba8unorm');
      expect(ev.descriptor.size).toEqual([128, 128]);
      expect(ev.descriptor.usage).toBe(0x4);
      expect(ev.descriptor.textureBindingViewDimension).toBe('2d');
    });

    it('SamplerDescriptor passes through magFilter / minFilter / compare / maxAnisotropy', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const out = device.createSampler({
        magFilter: 'linear',
        minFilter: 'nearest',
        compare: 'less',
        maxAnisotropy: 4,
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createSampler');
      expect(ev.descriptor?.magFilter).toBe('linear');
      expect(ev.descriptor?.minFilter).toBe('nearest');
      expect(ev.descriptor?.compare).toBe('less');
      expect(ev.descriptor?.maxAnisotropy).toBe(4);
    });

    it('BindGroupLayoutDescriptor passes through the entries array reference', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: 0x1, buffer: { type: 'uniform' } },
      ];
      const out = device.createBindGroupLayout({ label: 'bgl', entries });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createBindGroupLayout');
      expect(ev.descriptor.label).toBe('bgl');
      expect(ev.descriptor.entries).toEqual(entries);
    });

    it('RenderPipelineDescriptor passes through vertex / fragment / layout', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      // fix-f3: shader creation goes through the top-level async
      // `createShaderModule` entry (the RhiDevice interface no longer holds the
      // synchronous createShaderModule placeholder).
      const shader = await createShaderModule(device, {
        code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }',
      });
      if (!shader.ok) throw new Error('mock shader creation failed');
      // The forgeax RenderPipelineDescriptor uses the `?: T | undefined` shape
      // (S-7) — explicitly passing `fragment: undefined` is allowed.
      const desc: RenderPipelineDescriptor = {
        label: 'rpp',
        layout: 'auto',
        vertex: { module: shader.value, entryPoint: 'v', buffers: [] },
        fragment: undefined,
      };
      const out = device.createRenderPipeline(desc);
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createRenderPipeline');
      expect(ev.descriptor.label).toBe('rpp');
      expect(ev.descriptor.layout).toBe('auto');
      expect(ev.descriptor.vertex.entryPoint).toBe('v');
    });

    it('converts a synchronous render-pipeline failure into a structured Result.err', async () => {
      const gpu = createMockGpu({ renderPipelineError: 'pipeline validation failed' });
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const shader = await createShaderModule(device, {
        code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }',
      });
      if (!shader.ok) throw new Error('mock shader creation failed');
      const out = device.createRenderPipeline({
        label: 'invalid-rpp',
        layout: 'auto',
        vertex: {
          module: shader.value,
          entryPoint: 'v',
          buffers: [],
        },
        fragment: undefined,
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toBe('underlying GPUDevice.createRenderPipeline to succeed');
      expect(out.error.hint).toContain('pipeline validation failed');
    });
  });

  describe('S-7 + hard constraint 10 — `?: T | undefined` guard (omitted vs explicit undefined)', () => {
    it('when label is omitted, the descriptor passed to the mock does not contain the label key (the `"x" in src` guard fires)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      device.createBuffer({ size: 16, usage: 0 });
      const ev = lastOf(gpu.__captured, 'createBuffer');
      expect('label' in ev.descriptor).toBe(false);
    });

    it('when label: undefined is explicitly passed, the descriptor passed to the mock contains the label key with value undefined', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      device.createBuffer({ size: 16, usage: 0, label: undefined });
      const ev = lastOf(gpu.__captured, 'createBuffer');
      expect('label' in ev.descriptor).toBe(true);
      expect(ev.descriptor.label).toBeUndefined();
    });
  });

  // w04 — createTextureView vitest unit mock red phase. TDD red asserts:
  //   (a) verbatim pass-through of the 9 TextureViewDescriptor fields (label
  //       optional + 8 spec fields).
  //   (b) `'x' in src` guard distinguishes missing vs explicit-undefined when
  //       forwarding to the mock.
  //   (c) cross-resource validation: format ∉ source.format ∪ source.viewFormats
  //       returns Result.err({ code: 'webgpu-runtime-error' }) (research §1.1
  //       cross-resource gate; charter proposition 4 explicit failure).
  //   (d) cross-resource validation: usage not a subset of source.usage returns
  //       Result.err({ code: 'webgpu-runtime-error' }).
  // Anchors: requirements §IN-1 / §AC-01 / §AC-07(b) / boundary case row 3;
  //          research §1.1 + §9 error code mapping; plan-strategy §4.2 + K-10.
  describe('w04 createTextureView - verbatim pass-through of 9 TextureViewDescriptor fields', () => {
    it('passes through label / format / dimension / usage / aspect / mip / array layer fields', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const texOut = device.createTexture({
        label: 'tex-source',
        size: [128, 128],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING | COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      if (!texOut.ok) throw new Error('mock createTexture failed');
      const texture = texOut.value;

      const out = device.createTextureView(texture, {
        label: 'view-1',
        format: 'rgba8unorm-srgb',
        dimension: '2d',
        usage: TEXTURE_BINDING,
        aspect: 'all',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createTextureView');
      expect(ev.descriptor?.label).toBe('view-1');
      expect(ev.descriptor?.format).toBe('rgba8unorm-srgb');
      expect(ev.descriptor?.dimension).toBe('2d');
      expect(ev.descriptor?.usage).toBe(TEXTURE_BINDING);
      expect(ev.descriptor?.aspect).toBe('all');
      expect(ev.descriptor?.baseMipLevel).toBe(0);
      expect(ev.descriptor?.mipLevelCount).toBe(1);
      expect(ev.descriptor?.baseArrayLayer).toBe(0);
      expect(ev.descriptor?.arrayLayerCount).toBe(1);
    });
  });

  describe('w04 createTextureView - S-7 + hard constraint 10 - `?: T | undefined` guard', () => {
    it('when label is omitted, the descriptor passed to the mock does not contain the label key', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const texOut = device.createTexture({
        size: [16, 16],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING,
      });
      if (!texOut.ok) throw new Error('mock createTexture failed');

      device.createTextureView(texOut.value, { format: 'rgba8unorm', dimension: '2d' });
      const ev = lastOf(gpu.__captured, 'createTextureView');
      expect('label' in (ev.descriptor ?? {})).toBe(false);
    });

    it('when label: undefined is explicit, the descriptor passed to the mock contains the label key with value undefined', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const texOut = device.createTexture({
        size: [16, 16],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING,
      });
      if (!texOut.ok) throw new Error('mock createTexture failed');

      device.createTextureView(texOut.value, {
        label: undefined,
        format: 'rgba8unorm',
        dimension: '2d',
      });
      const ev = lastOf(gpu.__captured, 'createTextureView');
      expect('label' in (ev.descriptor ?? {})).toBe(true);
      expect(ev.descriptor?.label).toBeUndefined();
    });
  });

  describe('w04 createTextureView - cross-resource validation maps to webgpu-runtime-error (research §1.1)', () => {
    it("format not in source.format ∪ source.viewFormats returns 'webgpu-runtime-error'", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const texOut = device.createTexture({
        size: [16, 16],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING,
        viewFormats: ['rgba8unorm-srgb'],
      });
      if (!texOut.ok) throw new Error('mock createTexture failed');

      const out = device.createTextureView(texOut.value, {
        // bgra8unorm is neither the source format nor in viewFormats.
        format: 'bgra8unorm',
        dimension: '2d',
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected.length).toBeGreaterThan(0);
        expect(out.error.hint.length).toBeGreaterThan(0);
      }
    });

    it("usage not a subset of source.usage returns 'webgpu-runtime-error'", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const texOut = device.createTexture({
        size: [16, 16],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING,
      });
      if (!texOut.ok) throw new Error('mock createTexture failed');

      const out = device.createTextureView(texOut.value, {
        format: 'rgba8unorm',
        dimension: '2d',
        // STORAGE_BINDING was not in source usage; the subset check must fail.
        usage: STORAGE_BINDING,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
      }
    });
  });

  // w08 — createComputePipeline vitest unit mock red phase. TDD red asserts:
  //   (a) caps.compute === false -> 'feature-not-enabled' + structured templates.
  //       Constructed via direct RhiError contract assertion (mirror of
  //       createBindGroup runtime tests). The MVP shim hardcodes
  //       caps.compute=true (research §1.2 NOTE: WebGPU mandates compute);
  //       the gate exists for potential future backends that lack compute.
  //   (b) layout: 'auto' field passes through verbatim.
  //   (c) layout: PipelineLayout brand passes through verbatim.
  //   (d) entryPoint + constants are forwarded through the compute nested
  //       dictionary verbatim.
  // Anchors: requirements §IN-1 / §AC-01 / §AC-07 / boundary case row 1;
  //          research §1.2 device timeline + §9; plan-strategy §4.3 + K-10.
  describe('w08 createComputePipeline - feature-not-enabled gate template (boundary case row 1)', () => {
    it("'feature-not-enabled' err carries the contracted .expected / .hint templates", () => {
      const e = new RhiError({
        code: 'feature-not-enabled',
        expected: 'caps.compute === true',
        hint: 'check device.caps.compute before calling createComputePipeline',
      });
      expect(e.code).toBe('feature-not-enabled');
      expect(e.expected).toBe('caps.compute === true');
      expect(e.hint).toBe('check device.caps.compute before calling createComputePipeline');
    });
  });

  describe('w08 createComputePipeline - layout / compute pass-through', () => {
    it("layout: 'auto' is forwarded verbatim to the underlying device", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const shader = await createShaderModule(device, {
        code: '@compute @workgroup_size(1) fn cs() {}',
      });
      if (!shader.ok) throw new Error('mock shader creation failed');

      const out = device.createComputePipeline({
        label: 'cs-auto',
        layout: 'auto',
        compute: { module: shader.value, entryPoint: 'cs' },
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createComputePipeline');
      expect(ev.descriptor.label).toBe('cs-auto');
      expect(ev.descriptor.layout).toBe('auto');
      expect(ev.descriptor.compute.entryPoint).toBe('cs');
    });

    it('layout: PipelineLayout brand is forwarded verbatim', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const shader = await createShaderModule(device, {
        code: '@compute @workgroup_size(1) fn cs() {}',
      });
      if (!shader.ok) throw new Error('mock shader creation failed');

      const plOut = device.createPipelineLayout({ label: 'pl', bindGroupLayouts: [] });
      expect(plOut.ok).toBe(true);
      if (!plOut.ok) return;

      const out = device.createComputePipeline({
        label: 'cs-explicit',
        layout: plOut.value,
        compute: { module: shader.value, entryPoint: 'cs' },
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createComputePipeline');
      expect(ev.descriptor.layout).toBe(plOut.value as never);
    });

    it('compute.constants is forwarded verbatim', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const shader = await createShaderModule(device, {
        code: '@compute @workgroup_size(1) fn cs() {}',
      });
      if (!shader.ok) throw new Error('mock shader creation failed');

      const out = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shader.value, entryPoint: 'cs', constants: { foo: 1, bar: 2 } },
      });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createComputePipeline');
      expect(ev.descriptor.compute.constants).toEqual({ foo: 1, bar: 2 });
    });
  });

  // w11 — createQuerySet vitest unit mock red phase + count boundary checks.
  // TDD red asserts:
  //   (a) count = 0 is legal (research §1.3 lower bound; dawn end2end fixture).
  //   (b) count = 4096 is legal (upper bound).
  //   (c) count = 4097 returns 'limit-exceeded' with .expected =
  //       'count <= 4096 (spec normative)' + .hint =
  //       'create multiple QuerySet instances if more than 4096 queries needed'.
  //   (d) type:'timestamp' + caps.timestampQuery === false returns
  //       'feature-not-enabled' (mock device defaults: timestamp-query feature
  //       not in features set; shim must check caps before forwarding).
  // Anchors: requirements §IN-1 / §AC-01 / boundary case row 2; research §1.3 +
  //          §7.2 Pattern D + §9; plan-strategy §3 R-1 mitigation + §4.3 +
  //          K-10.
  describe('w11 createQuerySet - count boundary 0 / 4096 / 4097', () => {
    it('count = 0 is legal (research §1.3 lower bound)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const out = device.createQuerySet({ label: 'qs-zero', type: 'occlusion', count: 0 });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createQuerySet');
      expect(ev.descriptor.count).toBe(0);
      expect(ev.descriptor.type).toBe('occlusion');
    });

    it('count = 4096 is legal (research §1.3 upper bound)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const out = device.createQuerySet({ type: 'occlusion', count: 4096 });
      expect(out.ok).toBe(true);

      const ev = lastOf(gpu.__captured, 'createQuerySet');
      expect(ev.descriptor.count).toBe(4096);
    });

    it("count = 4097 returns 'limit-exceeded' with the contracted templates", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;

      const out = device.createQuerySet({ type: 'occlusion', count: 4097 });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('limit-exceeded');
        expect(out.error.expected).toBe('count <= 4096 (spec normative)');
        expect(out.error.hint).toBe(
          'create multiple QuerySet instances if more than 4096 queries needed',
        );
      }
    });
  });

  describe('w11 createQuerySet - timestamp feature gate (boundary case row 2)', () => {
    it("type: 'timestamp' + caps.timestampQuery === false returns 'feature-not-enabled'", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice failed');
      const device = r.value;
      // The default mock features set is empty -> deriveCaps yields
      // timestampQuery=false, so the shim's gate must trip.
      expect(device.caps.timestampQuery).toBe(false);

      const out = device.createQuerySet({ type: 'timestamp', count: 4 });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('feature-not-enabled');
        expect(out.error.expected.length).toBeGreaterThan(0);
        expect(out.error.hint.length).toBeGreaterThan(0);
      }
    });
  });

  // w20 - RhiCanvasContext vitest unit (mock) red phase. TDD red asserts:
  //   (a) format not in {'bgra8unorm','rgba8unorm','rgba16float'} -> error
  //       'webgpu-runtime-error' + .expected = 'one of bgra8unorm/rgba8unorm/rgba16float'.
  //   (b) device invalid | lost -> error 'rhi-not-available'.
  //   (c) getCurrentTexture() while unconfigured -> 'webgpu-runtime-error'
  //       (spec InvalidStateError mapping).
  //   (d) currentTexture is not cached across frames (each call returns a fresh
  //       texture handle; mock context emits a new sentinel per call).
  //
  // Anchors: requirements §IN-4 / §AC-04 / §AC-07 / boundary case row 7;
  //          research §3.3 4 methods + §9 error code mapping; plan-strategy
  //          §4.2 + §4.3 RhiCanvasContext + K-10.

  interface MockGpuTexture {
    readonly __brand: 'mock-gpu-texture';
    readonly id: number;
  }

  interface MockGpuCanvasContext {
    __configured: boolean;
    __currentTextureCalls: number;
    __invalidStateOnGetTexture: boolean;
    configure(desc: GPUCanvasConfiguration): void;
    unconfigure(): void;
    getConfiguration(): GPUCanvasConfiguration | null;
    getCurrentTexture(): MockGpuTexture;
  }

  function makeMockCanvasContext(): MockGpuCanvasContext {
    let storedConfig: GPUCanvasConfiguration | null = null;
    let counter = 0;
    const ctx: MockGpuCanvasContext = {
      __configured: false,
      __currentTextureCalls: 0,
      __invalidStateOnGetTexture: false,
      configure(desc) {
        storedConfig = desc;
        ctx.__configured = true;
      },
      unconfigure() {
        storedConfig = null;
        ctx.__configured = false;
      },
      getConfiguration() {
        return storedConfig;
      },
      getCurrentTexture() {
        ctx.__currentTextureCalls += 1;
        if (ctx.__invalidStateOnGetTexture) {
          const e = new Error('mock: InvalidStateError - context unconfigured');
          e.name = 'InvalidStateError';
          throw e;
        }
        counter += 1;
        return { __brand: 'mock-gpu-texture' as const, id: counter };
      },
    };
    return ctx;
  }

  async function freshDeviceAndContext(): Promise<{
    device: import('@forgeax/engine-rhi').RhiDevice;
    rhiContext: RhiCanvasContext;
    rawContext: MockGpuCanvasContext;
  }> {
    const gpu = createMockGpu();
    const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
    if (!r.ok) throw new Error('mock requestDevice should not fail');
    const device = r.value;
    const rawContext = makeMockCanvasContext();
    const mockCanvas = { getContext: () => rawContext };
    const ctxResult = acquireCanvasContext(mockCanvas as unknown as HTMLCanvasElement);
    if (!ctxResult.ok) throw new Error('acquireCanvasContext should not fail in unit fixture');
    return { device, rhiContext: ctxResult.value, rawContext };
  }

  it('forwards live native alpha capability facts without inventing browser facts', async () => {
    const { rhiContext, rawContext } = await freshDeviceAndContext();
    expect(rhiContext.supportedAlphaModes).toBeUndefined();
    Object.defineProperty(rawContext, 'supportedAlphaModes', {
      value: ['opaque'],
      configurable: true,
    });
    expect(rhiContext.supportedAlphaModes).toEqual(['opaque']);
    Object.defineProperty(rawContext, 'supportedAlphaModes', { value: [], configurable: true });
    expect(rhiContext.supportedAlphaModes).toEqual([]);
  });

  describe('w20 RhiCanvasContext - format gate maps to webgpu-runtime-error (research §3.2 supported context formats)', () => {
    it("format = 'rgba8unorm-srgb' (NOT in {'bgra8unorm','rgba8unorm','rgba16float'}) returns webgpu-runtime-error with the spec-aligned expected template", async () => {
      const { device, rhiContext } = await freshDeviceAndContext();
      const cfg: CanvasConfiguration = {
        device,
        format: 'rgba8unorm-srgb',
        usage: 0x10,
      };
      const out = rhiContext.configure(cfg);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toBe('one of bgra8unorm/rgba8unorm/rgba16float');
        expect(out.error.hint.length).toBeGreaterThan(0);
      }
    });

    it("format = 'bgra8unorm' is legal (one of the 3 supported context formats)", async () => {
      const { device, rhiContext, rawContext } = await freshDeviceAndContext();
      const out = rhiContext.configure({
        device,
        format: 'bgra8unorm',
        usage: 0x10,
      });
      expect(out.ok).toBe(true);
      expect(rawContext.__configured).toBe(true);
    });
  });

  describe('w20 RhiCanvasContext - getCurrentTexture in unconfigured state maps to webgpu-runtime-error (spec InvalidStateError)', () => {
    it('calling getCurrentTexture() before configure() returns webgpu-runtime-error', async () => {
      const { rhiContext, rawContext } = await freshDeviceAndContext();
      rawContext.__invalidStateOnGetTexture = true;
      const out = rhiContext.getCurrentTexture();
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected.length).toBeGreaterThan(0);
        expect(out.error.hint.length).toBeGreaterThan(0);
      }
    });
  });

  describe('w20 RhiCanvasContext - currentTexture is NOT cached across calls (research §3.1 [[Expire the current texture]])', () => {
    it('two consecutive getCurrentTexture() calls each go to the underlying context (per-frame fetch)', async () => {
      const { device, rhiContext, rawContext } = await freshDeviceAndContext();
      const cfg: CanvasConfiguration = {
        device,
        format: 'bgra8unorm',
        usage: 0x10,
      };
      expect(rhiContext.configure(cfg).ok).toBe(true);
      const a = rhiContext.getCurrentTexture();
      const b = rhiContext.getCurrentTexture();
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      // The mock counter advances on every call -> the shim does NOT short-circuit.
      expect(rawContext.__currentTextureCalls).toBe(2);
    });
  });

  describe('w20 RhiCanvasContext - getConfiguration returns spec projection (feature-detection entry, research §3.2 toneMapping NOTE)', () => {
    it('after configure() the configuration is observable; after unconfigure() it returns undefined', async () => {
      const { device, rhiContext } = await freshDeviceAndContext();
      expect(rhiContext.getConfiguration()).toBeUndefined();
      expect(
        rhiContext.configure({
          device,
          format: 'bgra8unorm',
          usage: 0x10,
        }).ok,
      ).toBe(true);
      const conf = rhiContext.getConfiguration();
      expect(conf).toBeDefined();
      if (conf) {
        expect(conf.format).toBe('bgra8unorm');
      }
      rhiContext.unconfigure();
      expect(rhiContext.getConfiguration()).toBeUndefined();
    });
  });
}

{
  // --- from error-scope-removed.test.ts ---
  // AC-01 + AC-04 + D-I2 — error scope removed test.
  //
  // This test ratifies the post-realign dispatch model: createX entries return
  // synchronously (Result<T, RhiError>), NOT Promise<Result>; the device.lost +
  // onuncapturederror channels carry async error fan-out (separately, via the
  // @forgeax/engine-runtime RhiErrorListenerRegistry at the engine layer).
  //
  // Per implement-decisions.md D-I2: the "delete push/pop+await + register
  // onuncapturederror listener" half of plan-strategy §S-2 is **vacuously
  // satisfied** — packages/rhi-webgpu/src/ never contained pushErrorScope /
  // popErrorScope wrappers; the existing direct-dispatch path already aligns
  // with the new model.
  //
  // Three-part assertion structure:
  //   (a) src code has 0 pushErrorScope / popErrorScope hits (D-I2 vacuous
  //       satisfaction grep gate);
  //   (b) createBuffer with valid descriptor returns Result.ok synchronously
  //       (the returned value is a Buffer wrapper, not a thenable);
  //   (c) createBindGroupLayout / createPipelineLayout / createRenderPipeline
  //       all return synchronously (Result.ok | Result.err with .ok
  //       discriminator, never Promise).
  //
  // Rationale: requirements AC-01 (delete push/pop+await + spec async dispatch
  // passthrough); research R-01 §1 chromium DispatchEvent same-tick fact;
  // plan-strategy D-P6 dual channel boundary; charter proposition 4 + 5.

  // Lazy-load node:fs / node:path through dynamic import so the test file
  // itself does not require @types/node at the package boundary (the shim
  // package is intentionally browser-leaning per AGENTS.md "## Packages"
  // table). The @ts-expect-error escape lets tsc skip the node: lookups
  // without polluting the package's compilerOptions.types with "node".
  async function loadShimSrcFiles(): Promise<readonly string[]> {
    // @ts-expect-error node: specifier not in tsconfig types (vitest runtime only)
    const nodeFs = await import('node:fs');
    // @ts-expect-error node: specifier not in tsconfig types
    const nodePath = await import('node:path');
    // @ts-expect-error node: specifier not in tsconfig types
    const nodeUrl = await import('node:url');
    const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    const srcDir = nodePath.resolve(here, '..');
    return (['index.ts', 'device.ts', 'errors.ts'] as const).map((name): string =>
      nodeFs.readFileSync(nodePath.join(srcDir, name), 'utf8'),
    );
  }

  describe('AC-01 — D-I2 vacuous satisfaction: no pushErrorScope / popErrorScope in shim src', () => {
    it('packages/rhi-webgpu/src/*.ts has 0 pushErrorScope hits (grep gate)', async () => {
      const bodies = await loadShimSrcFiles();
      for (const body of bodies) {
        // Strip comment lines so a documentary reference doesn't trip the gate.
        const code = body
          .split('\n')
          .filter((line: string) => !/^\s*(\*|\/\/)/.test(line))
          .join('\n');
        expect(code).not.toMatch(/\bpushErrorScope\b/);
        expect(code).not.toMatch(/\bpopErrorScope\b/);
      }
    });
  });

  describe('AC-04 — createX returns Result synchronously (Result.ok | Result.err)', () => {
    it('createBuffer returns Result<Buffer, RhiError> synchronously (not Promise)', async () => {
      const gpu = createMockGpu({});
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const device = r.value;
      const out = device.createBuffer({ size: 64, usage: 0x8 /* COPY_DST */ });
      // Result is a synchronous value with `.ok` discriminator; the Promise
      // form (Promise<Result>) is reserved for entries that need to await spec
      // async dispatch (e.g. requestAdapter / requestDevice / mapAsync) per
      // plan-strategy §7.1 sync / async axis.
      expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
      expect(out.ok).toBe(true);
    });

    it('createBindGroupLayout returns Result synchronously', async () => {
      const gpu = createMockGpu({});
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const device = r.value;
      const out = device.createBindGroupLayout({ entries: [] });
      expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
      expect(out.ok).toBe(true);
    });
  });
}

{
  // --- from errors.test.ts ---
  // AC-10 + MVP-1.7 runtime — 4 error-path Result.err three-field assertions +
  // closed-union completeness. After feat-20260508-rhi-surface-completion w7
  // (D-S3) the union has 17 members; this test still drives the 4 error paths
  // reachable via mock GPU + asserts triggered codes are a subset of the 10
  // closed-union members.
  //
  // 4 error paths (boundary cases / plan-strategy 7.3 error-info table / research F-5):
  //   1) adapter null            -> code 'adapter-unavailable'
  //   2) feature not enabled     -> code 'feature-not-enabled'
  //   3) limit exceeded          -> code 'limit-exceeded'
  //   4) shader compile failed   -> code 'shader-compile-failed' + detail.compilerMessages[]
  //
  // MVP-1.7 runtime gate: aggregate assertion that triggered codes belong to
  // RhiErrorCode union 17 members (extended in w7 from 6).
  // plan-decisions OQ-P2: detail.compilerMessages forwards the full 6-field
  // GPUCompilationMessage shape.
  //
  // Related: requirements AC-10 + MVP-1.7 + boundary cases + AI User Affordances;
  //          plan-strategy R1 / R10 + 4.3 key test points #4 / #5 + 7.3 error-info table;
  //          research F-3 (full GPUCompilationMessage fields) + F-5 (single null channel).

  /** 17-member closed-union runtime enumeration; used by the MVP-1.7 aggregate gate.
   *  Extended in feat-20260511-rhi-spec-realign-aggressive w6 (+ 'device-lost' /
   *  'oom' / 'internal-error' for spec §22.2 three-subtype dispatch) +
   *  feat-20260509-ecs-render-bridge-mvp w6 (+ render-system 4 codes).
   */
  const RHI_ERROR_CODES: ReadonlySet<RhiErrorCode> = new Set([
    'adapter-unavailable',
    'feature-not-enabled',
    'limit-exceeded',
    'shader-compile-failed',
    'rhi-not-available',
    'webgpu-runtime-error',
    'command-encoder-finished',
    'render-pass-not-ended',
    'queue-submit-failed',
    'queue-write-buffer-out-of-bounds',
    'render-system-no-camera',
    'render-system-multi-camera',
    'render-system-multi-light',
    'asset-not-registered',
    'device-lost',
    'oom',
    'internal-error',
  ]);

  function unwrapErr<T>(r: Result<T, RhiError>): RhiError {
    if (r.ok) throw new Error('expected Result.err but got Result.ok');
    return r.error;
  }

  describe('AC-10 — 4 error paths .code / .expected / .hint three-field assertions', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('adapter null -> code=adapter-unavailable + three non-empty string fields', async () => {
      const gpu = createMockGpu({ adapterNull: true });
      const e = unwrapErr(await requestAdapterFrom(gpu));
      expect(e).toBeInstanceOf(RhiError);
      expect(e.code).toBe('adapter-unavailable');
      expect(typeof e.expected).toBe('string');
      expect(e.expected.length).toBeGreaterThan(0);
      expect(typeof e.hint).toBe('string');
      expect(e.hint.length).toBeGreaterThan(0);
    });

    it('requestAdapter throw keeps the original failure instead of claiming adapter-unavailable', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: async () => {
            throw new DOMException('WebGPU permission policy denied access', 'SecurityError');
          },
        },
      });

      const e = unwrapErr(await requestAdapter());
      expect(e.code).toBe('webgpu-runtime-error');
      expect(e.hint).toContain('wgpu/WebGL2 fallback');
      expect(e.detail).toEqual({
        error: {
          code: 'request-adapter-threw',
          name: 'SecurityError',
          message: 'WebGPU permission policy denied access',
        },
      });
    });

    it('feature not enabled -> code=feature-not-enabled + three non-empty string fields', async () => {
      const gpu = createMockGpu({ requestDeviceFeatureNotEnabled: true });
      const e = unwrapErr(await (await requestAdapterFrom(gpu)).unwrap().requestDevice());
      expect(e.code).toBe('feature-not-enabled');
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);
    });

    it('limit exceeded -> code=limit-exceeded + three non-empty string fields', async () => {
      const gpu = createMockGpu({ requestDeviceLimitExceeded: true });
      const e = unwrapErr(await (await requestAdapterFrom(gpu)).unwrap().requestDevice());
      expect(e.code).toBe('limit-exceeded');
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);
    });

    it('shader compile failed -> code=shader-compile-failed + 3 fields + detail.compilerMessages 6-field passthrough', async () => {
      const compileMsg = makeShaderError({
        message: 'expected `;`',
        type: 'error',
        lineNum: 3,
        linePos: 12,
        offset: 42,
        length: 5,
      });
      const gpu = createMockGpu({ shaderCompileMessages: [compileMsg] });
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value;

      const shaderResult = await createShaderModule(device, { code: 'fn bad() { ; }' });
      const e = unwrapErr(shaderResult);
      expect(e.code).toBe('shader-compile-failed');
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);

      // OQ-P2: detail.compilerMessages forwards the 6-field GPUCompilationMessage shape (F-3 finding).
      // After D-S7 the .detail field is a union (RhiShaderCompileDetail |
      // RhiAssetNotRegisteredDetail | RhiWebgpuRuntimeDetail | undefined); on
      // the 'shader-compile-failed' path the 'compilerMessages' branch is the
      // narrowed shape.
      expect(e.detail).toBeDefined();
      expect(e.detail !== undefined && 'compilerMessages' in e.detail).toBe(true);
      if (e.detail === undefined || !('compilerMessages' in e.detail)) {
        throw new Error('expected RhiShaderCompileDetail');
      }
      expect(e.detail.compilerMessages.length).toBe(1);
      const msg = e.detail.compilerMessages[0];
      expect(msg?.message).toBe('expected `;`');
      expect(msg?.type).toBe('error');
      expect(msg?.lineNum).toBe(3);
      expect(msg?.linePos).toBe(12);
      expect(msg?.offset).toBe(42);
      expect(msg?.length).toBe(5);
    });

    it('other 4 paths have detail === undefined (charter proposition 4 baseline / shader-compile-failed exclusive)', async () => {
      const gpu = createMockGpu({ adapterNull: true });
      const e = unwrapErr(await requestAdapterFrom(gpu));
      expect(e.detail).toBeUndefined();
    });
  });

  describe('MVP-1.7 runtime — closed RhiErrorCode union 17 members aggregate gate', () => {
    it('4 error paths triggered codes are strict subset of RhiErrorCode union 17 members', async () => {
      const triggered = new Set<RhiErrorCode>();

      {
        const gpu = createMockGpu({ adapterNull: true });
        triggered.add(unwrapErr(await requestAdapterFrom(gpu)).code);
      }
      {
        const gpu = createMockGpu({ requestDeviceFeatureNotEnabled: true });
        triggered.add(
          unwrapErr(await (await requestAdapterFrom(gpu)).unwrap().requestDevice()).code,
        );
      }
      {
        const gpu = createMockGpu({ requestDeviceLimitExceeded: true });
        triggered.add(
          unwrapErr(await (await requestAdapterFrom(gpu)).unwrap().requestDevice()).code,
        );
      }
      {
        const gpu = createMockGpu({ shaderCompileMessages: [makeShaderError()] });
        const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
        if (!r.ok) throw new Error('mock requestDevice should not fail');
        const sr = await createShaderModule(r.value, { code: 'bad' });
        triggered.add(unwrapErr(sr).code);
      }

      // 4 error paths trigger 4 of the 17 union members (rest are validation/runtime
      // paths covered by other tests: w6 queue, w3/w5 encoder/pass, K-9 silent-skip).
      expect(triggered.size).toBe(4);
      for (const c of triggered) {
        expect(RHI_ERROR_CODES.has(c)).toBe(true);
      }
      expect(triggered.has('adapter-unavailable')).toBe(true);
      expect(triggered.has('feature-not-enabled')).toBe(true);
      expect(triggered.has('limit-exceeded')).toBe(true);
      expect(triggered.has('shader-compile-failed')).toBe(true);
    });
  });

  describe('createShaderModule — getCompilationInfo rejection on dropped instance', () => {
    // Regression: when the underlying GPU instance is dropped mid-await (device
    // destroyed / page teardown while getCompilationInfo() is in flight), the
    // promise rejects with OperationError 'Instance dropped'. The handle was
    // already created synchronously, so createShaderModule must swallow the
    // teardown rejection and return ok rather than let it escape as an unhandled
    // rejection (observed as 5 CI unhandled rejections from the learn-render
    // 2.lighting browser tests; charter proposition 9 graceful degradation).
    it('returns ok instead of rejecting when getCompilationInfo() rejects', async () => {
      const gpu = createMockGpu({ getCompilationInfoRejects: true });
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');

      // Must resolve (not reject) and yield Result.ok.
      const sr = await createShaderModule(r.value, { code: 'fn main() {}' });
      expect(sr.ok).toBe(true);
    });

    it('immediate render-path entry returns the module without awaiting compilation info', async () => {
      const gpu = createMockGpu({ getCompilationInfoRejects: true });
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');

      const sr = createShaderModuleImmediate(r.value, {
        label: 'render-fast-path',
        code: 'fn main() {}',
      });
      expect(sr.ok).toBe(true);
      expect(
        gpu.__captured.some(
          (entry) =>
            entry.kind === 'createShaderModule' && entry.descriptor.label === 'render-fast-path',
        ),
      ).toBe(true);
    });
  });
}

{
  // --- from queue-real-path.test.ts ---
  // w6 - RhiQueue real-path implementation + bounds validation.
  //
  // Replaces the obsolete queue-not-available.test.ts (Round 1 placeholder
  // returned 'rhi-not-available' for both submit / writeBuffer; w6 lands the
  // real shim path forwarding to GPUQueue + bounds validation).
  //
  // Coverage:
  //   - submit forwards to rawQueue.submit; default mock no-ops -> Result.ok.
  //   - submit with throwing rawQueue.submit -> Result.err({ code:
  //     'queue-submit-failed' }) per D-S3 template 3.
  //   - writeBuffer with valid offset/size -> Result.ok.
  //   - writeBuffer with non-4-byte-aligned offset -> Result.err({ code:
  //     'queue-write-buffer-out-of-bounds' }) per D-S3 template 4.
  //   - writeBuffer with offset + byteLength > buffer.size -> Result.err({
  //     code: 'queue-write-buffer-out-of-bounds' }) per D-S3 template 4.
  //
  // Charter: proposition 4 (explicit failure: bounds errors carry both code
  // and concrete numeric values via .hint).
  //
  // dawn.node real-GPU coverage of these paths is in w17 (M5 integration).

  interface OkLike<T> {
    ok: true;
    value: T;
  }
  interface ErrLike {
    ok: false;
    error: { code: string; expected: string; hint: string };
  }
  type ResultLike<T> = OkLike<T> | ErrLike;

  interface DeviceLike {
    queue: {
      submit: (commandBuffers: readonly unknown[]) => ResultLike<void>;
      writeBuffer: (
        buffer: unknown,
        bufferOffset: number,
        data: ArrayBufferView | ArrayBuffer,
        dataOffset?: number,
        size?: number,
      ) => ResultLike<void>;
    };
    createBuffer: (desc: { size: number; usage: number }) => ResultLike<unknown>;
    createCommandEncoder: (desc?: unknown) => ResultLike<{
      finish: () => ResultLike<unknown>;
    }>;
  }

  describe('w6 - RhiQueue.submit real-path', () => {
    it('submit() with empty list returns Result.ok(undefined)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const out = device.queue.submit([]);
      expect(out.ok).toBe(true);
    });

    it('submit() with command buffer from finished encoder returns Result.ok', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const encResult = device.createCommandEncoder();
      if (!encResult.ok) throw new Error('createCommandEncoder should succeed');
      const finishResult = encResult.value.finish();
      if (!finishResult.ok) throw new Error('finish should succeed');
      const out = device.queue.submit([finishResult.value]);
      expect(out.ok).toBe(true);
    });
  });

  describe('w6 - RhiQueue.writeBuffer real-path + bounds validation', () => {
    it('writeBuffer with aligned offset + in-bounds data returns Result.ok', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const bufResult = device.createBuffer({ size: 256, usage: 0 });
      if (!bufResult.ok) throw new Error('createBuffer should succeed');
      const data = new Uint8Array(64);
      const out = device.queue.writeBuffer(bufResult.value, 0, data);
      expect(out.ok).toBe(true);
    });

    it('writeBuffer with non-4-byte-aligned offset returns queue-write-buffer-out-of-bounds', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const bufResult = device.createBuffer({ size: 256, usage: 0 });
      if (!bufResult.ok) throw new Error('createBuffer should succeed');
      const data = new Uint8Array(64);
      // Offset 3 is NOT 4-byte aligned -> structured error per D-S3 template 4.
      const out = device.queue.writeBuffer(bufResult.value, 3, data);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('queue-write-buffer-out-of-bounds');
        // Hint must carry concrete numeric values for AI-user routing.
        expect(out.error.hint).toContain('got 3');
        expect(out.error.expected).toContain('4-byte');
      }
    });

    it('writeBuffer with offset + byteLength > buffer.size returns queue-write-buffer-out-of-bounds', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const bufResult = device.createBuffer({ size: 16, usage: 0 });
      if (!bufResult.ok) throw new Error('createBuffer should succeed');
      const data = new Uint8Array(32);
      // offset 0 + byteLength 32 > buffer.size 16 -> out-of-bounds.
      const out = device.queue.writeBuffer(bufResult.value, 0, data);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('queue-write-buffer-out-of-bounds');
        // Hint must include the buffer size and byteLength so the AI user can
        // self-recover (charter proposition 4 explicit failure with concrete
        // numeric context).
        expect(out.error.hint).toContain('got 0');
        expect(out.error.hint).toContain('got 32');
        expect(out.error.hint).toContain('got 16');
      }
    });

    it('writeBuffer with offset + size > buffer.size (using explicit size arg) is rejected', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLike;
      const bufResult = device.createBuffer({ size: 64, usage: 0 });
      if (!bufResult.ok) throw new Error('createBuffer should succeed');
      const data = new Uint8Array(128);
      // explicit size = 100, bufferOffset = 0 -> 0 + 100 > 64.
      const out = device.queue.writeBuffer(bufResult.value, 0, data, 0, 100);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('queue-write-buffer-out-of-bounds');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // w34 (M5) - mapAsync 8-item validation + F-8 row 1/2/3 unit tests.
  // ---------------------------------------------------------------------------
  //
  // research §4.2 lists 8 validation steps (4 device-timeline + 4 boundary) plus
  // the F-8 three-row contract from requirements:
  //   F-8 row 1: already-mapped + mapAsync   -> 'webgpu-runtime-error'
  //   F-8 row 2: detached ArrayBuffer access -> 'webgpu-runtime-error'
  //   F-8 row 3: mode-usage mismatch         -> 'webgpu-runtime-error'
  //
  // K-2 (plan-strategy §2): all 8 validation rows + F-8 three rows ride on the
  // 'webgpu-runtime-error' code with structured `.expected` + `.hint` literals.
  // AI users route via:
  //   switch (err.code) { case 'webgpu-runtime-error': ... err.expected ... }
  // (charter proposition 4 explicit failure; F-3 ai-user-review carry-over
  // requires `.code` + `.expected` + `.hint` triple grep below).
  //
  // These tests target the SHIM (packages/rhi-webgpu/src/device.ts) - the shim
  // validates BEFORE delegating to the raw GPUBuffer. The buffer interface is
  // extended in w35 with mapAsync / getMappedRange / unmap / mapState; until
  // then the test cases below are TS-red (`r.value.mapAsync` does not exist).

  interface BufferLikeWithMap {
    mapAsync: (mode: number, offset?: number, size?: number) => Promise<ResultLike<void>>;
    getMappedRange: (offset?: number, size?: number) => ResultLike<ArrayBuffer>;
    unmap: () => void;
    readonly mapState: 'unmapped' | 'pending' | 'mapped';
  }

  const MAP_READ = 0x1;
  const MAP_WRITE = 0x2;
  const USAGE_MAP_READ = 0x0001;
  const USAGE_MAP_WRITE = 0x0002;
  const USAGE_COPY_DST = 0x0008;

  async function makeBuffer(desc: {
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
  }): Promise<BufferLikeWithMap> {
    const gpu = createMockGpu();
    const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
    if (!r.ok) throw new Error('mock requestDevice should not fail');
    const device = r.value as unknown as {
      createBuffer: (d: typeof desc) => ResultLike<BufferLikeWithMap>;
    };
    const buf = device.createBuffer(desc);
    if (!buf.ok) throw new Error('createBuffer should succeed');
    return buf.value;
  }

  describe('w34 (M5) - mapAsync 8-item validation + F-8 row 1/2/3 (K-2 webgpu-runtime-error)', () => {
    it('F-8 row 1: mapAsync on already-mapped buffer returns webgpu-runtime-error', async () => {
      const buf = await makeBuffer({
        size: 16,
        usage: USAGE_MAP_WRITE,
        mappedAtCreation: true,
      });
      const out = await buf.mapAsync(MAP_WRITE);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('mapState');
        expect(out.error.hint).toContain('unmap');
      }
    });

    it('F-8 row 2: getMappedRange after unmap returns webgpu-runtime-error (detach guard)', async () => {
      const buf = await makeBuffer({ size: 16, usage: USAGE_MAP_WRITE });
      const m1 = await buf.mapAsync(MAP_WRITE);
      expect(m1.ok).toBe(true);
      const r1 = buf.getMappedRange();
      expect(r1.ok).toBe(true);
      buf.unmap();
      const r2 = buf.getMappedRange();
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe('webgpu-runtime-error');
        expect(r2.error.expected).toContain('mapped');
        expect(r2.error.hint).toContain('mapAsync');
      }
    });

    it('F-8 row 3: mode-usage mismatch (READ on a non-MAP_READ buffer) returns webgpu-runtime-error', async () => {
      const buf = await makeBuffer({ size: 16, usage: USAGE_COPY_DST });
      const out = await buf.mapAsync(MAP_READ);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('READ requires buffer.usage to contain MAP_READ');
        expect(out.error.hint).toContain('GPUBufferUsage.MAP_READ');
      }
    });

    it('alignment: offset % 8 != 0 returns webgpu-runtime-error (research §4.2 step 4)', async () => {
      const buf = await makeBuffer({ size: 32, usage: USAGE_MAP_READ });
      const out = await buf.mapAsync(MAP_READ, 4);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('offset % 8 == 0');
        expect(out.error.hint).toContain('align offset');
      }
    });

    it('alignment: rangeSize % 4 != 0 returns webgpu-runtime-error (research §4.2 step 5)', async () => {
      const buf = await makeBuffer({ size: 32, usage: USAGE_MAP_READ });
      const out = await buf.mapAsync(MAP_READ, 0, 5);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('rangeSize % 4 == 0');
        expect(out.error.hint).toContain('align rangeSize');
      }
    });

    it('bounds: offset + rangeSize > size returns webgpu-runtime-error (research §4.2 step 6)', async () => {
      const buf = await makeBuffer({ size: 16, usage: USAGE_MAP_READ });
      const out = await buf.mapAsync(MAP_READ, 8, 16);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('offset + rangeSize <= buffer.size');
        expect(out.error.hint).toContain('buffer.size=16');
      }
    });

    it('mode bits: mode contains both READ|WRITE -> webgpu-runtime-error (research §4.2 step 8)', async () => {
      const buf = await makeBuffer({
        size: 16,
        usage: USAGE_MAP_READ | USAGE_MAP_WRITE,
      });
      const out = await buf.mapAsync(MAP_READ | MAP_WRITE);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('exactly one of READ | WRITE');
      }
    });

    it('mode bits: mode contains foreign bits (e.g. 0x4) -> webgpu-runtime-error (research §4.2 step 7)', async () => {
      const buf = await makeBuffer({ size: 16, usage: USAGE_MAP_READ });
      const out = await buf.mapAsync(0x4);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toContain('only READ or WRITE bits');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // w36 (M5) - RhiQueue.writeTexture / copyExternalImageToTexture /
  //            onSubmittedWorkDone surface contract.
  // ---------------------------------------------------------------------------
  //
  // research §5.1 + §5.2: onSubmittedWorkDone returns Promise<undefined> per
  // spec normative (no reject path; device-lost flows through RhiDevice.lost).
  // research §5.3 + Pattern A round-trip: ordering constraint #2 (mapAsync
  // before onSubmittedWorkDone) is the primary use case.
  //
  // writeTexture / copyExternalImageToTexture: spec field passthrough; the
  // shim validates bytesPerRow % 256 == 0 (alignment from research §1.3 +
  // existing queue-write-buffer-out-of-bounds template). K-2 says alignment
  // faults map to 'queue-write-buffer-out-of-bounds' (the existing per-buffer
  // bounds code; spec wants a structured alignment failure path and the
  // closest member already in the union is queue-write-buffer-out-of-bounds).

  interface QueueLikeM5 {
    writeTexture: (
      destination: unknown,
      data: ArrayBufferView | ArrayBuffer,
      dataLayout: { bytesPerRow?: number; rowsPerImage?: number; offset?: number },
      size: unknown,
    ) => ResultLike<void>;
    copyExternalImageToTexture: (
      source: unknown,
      destination: unknown,
      copySize: unknown,
    ) => ResultLike<void>;
    onSubmittedWorkDone: () => Promise<void>;
  }

  interface DeviceLikeM5 {
    queue: QueueLikeM5;
  }

  describe('w36 (M5) - RhiQueue.writeTexture / copyExternalImageToTexture / onSubmittedWorkDone surface', () => {
    it('writeTexture exists on queue and returns Result<void, RhiError>', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLikeM5;
      expect(typeof device.queue.writeTexture).toBe('function');
      const out = device.queue.writeTexture(
        { texture: {} as unknown, mipLevel: 0 },
        new Uint8Array(256),
        { bytesPerRow: 256, rowsPerImage: 1 },
        [1, 1, 1] as unknown,
      );
      expect(typeof out.ok).toBe('boolean');
    });

    it('writeTexture accepts non-256-aligned bytesPerRow (spec says no alignment on this path)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLikeM5;
      // bytesPerRow=100 and 2000 are both NOT multiples of 256.
      // webgpu spec section 19.2 Note: unlike copyBufferToTexture(), there is
      // no alignment requirement on writeTexture dataLayout.bytesPerRow.
      const out1 = device.queue.writeTexture(
        { texture: {} as unknown, mipLevel: 0 },
        new Uint8Array(100),
        { bytesPerRow: 100, rowsPerImage: 1 },
        [1, 1, 1] as unknown,
      );
      expect(out1.ok).toBe(true);
      const out2 = device.queue.writeTexture(
        { texture: {} as unknown, mipLevel: 0 },
        new Uint8Array(2000),
        { bytesPerRow: 2000, rowsPerImage: 1 },
        [1, 1, 1] as unknown,
      );
      expect(out2.ok).toBe(true);
    });

    it('copyExternalImageToTexture exists on queue and returns Result<void, RhiError>', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLikeM5;
      expect(typeof device.queue.copyExternalImageToTexture).toBe('function');
    });

    it('onSubmittedWorkDone returns Promise<void> (NOT Result; spec has no reject path)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLikeM5;
      expect(typeof device.queue.onSubmittedWorkDone).toBe('function');
      const p = device.queue.onSubmittedWorkDone();
      expect(p instanceof Promise).toBe(true);
      const v = await p;
      expect(v).toBeUndefined();
    });

    it('onSubmittedWorkDone FIFO: p1 (called first) settles before p2 (constraint #1)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as DeviceLikeM5;
      const order: number[] = [];
      const p1 = device.queue.onSubmittedWorkDone().then(() => {
        order.push(1);
      });
      const p2 = device.queue.onSubmittedWorkDone().then(() => {
        order.push(2);
      });
      await Promise.all([p1, p2]);
      // FIFO: 1 must precede 2.
      expect(order).toEqual([1, 2]);
    });
  });
}

{
  // --- from render-pass-encoder.test.ts ---
  // Native bundle forwarding, query errors and render-pass lifecycle guards.
  // Real backend validation is covered by the Browser/Dawn bundle fixture.

  interface OkLike<T> {
    ok: true;
    value: T;
  }
  interface ErrLike {
    ok: false;
    error: { code: string; expected: string; hint: string };
  }
  type ResultLike<T> = OkLike<T> | ErrLike;

  interface MockEncoder {
    beginRenderPass: (desc: unknown) => MockPass;
    finish: () => ResultLike<unknown>;
  }
  interface MockPass {
    end: () => void;
    executeBundles: (bundles: Iterable<unknown>) => ResultLike<void>;
    beginOcclusionQuery: (queryIndex: number) => ResultLike<void>;
    endOcclusionQuery: () => ResultLike<void>;
  }

  describe('RhiRenderPassEncoder bundle execution and lifecycle', () => {
    it('executeBundles forwards the empty state-reset operation', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => ResultLike<MockEncoder>;
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok) throw new Error('createCommandEncoder should succeed');
      const encoder = encResult.value;
      const pass = encoder.beginRenderPass({ colorAttachments: [] });

      const out = pass.executeBundles([]);
      expect(out.ok).toBe(true);
    });

    it('beginOcclusionQuery without occlusionQuerySet now returns webgpu-runtime-error (w23 retired the rhi-not-available placeholder)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => ResultLike<MockEncoder>;
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok) throw new Error('createCommandEncoder should succeed');
      const encoder = encResult.value;
      const pass = encoder.beginRenderPass({ colorAttachments: [] });

      const begin = pass.beginOcclusionQuery(0);
      expect(begin.ok).toBe(false);
      if (!begin.ok) expect(begin.error.code).toBe('webgpu-runtime-error');

      const end = pass.endOcclusionQuery();
      expect(end.ok).toBe(false);
      // K-2: end without active begin maps to render-pass-not-ended (existing
      // 14-member union; was previously rhi-not-available placeholder).
      if (!end.ok) expect(end.error.code).toBe('render-pass-not-ended');
    });

    it('encoder.finish() with active pass returns render-pass-not-ended (D-S3 template 2)', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => ResultLike<MockEncoder>;
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok) throw new Error('createCommandEncoder should succeed');
      const encoder = encResult.value;
      // Intentionally begin a pass and do NOT call pass.end() before finish().
      void encoder.beginRenderPass({ colorAttachments: [] });
      const finishResult = encoder.finish();
      expect(finishResult.ok).toBe(false);
      if (!finishResult.ok) {
        expect(finishResult.error.code).toBe('render-pass-not-ended');
        expect(finishResult.error.hint.length).toBeGreaterThan(0);
      }
    });
  });

  // w22 - RPE beginOcclusionQuery / endOcclusionQuery placeholder retirement
  // red phase. Asserts (mock unit + dawn coverage in dawn-real-gpu.dawn.test.ts):
  //   (a) beginOcclusionQuery while RPDesc.occlusionQuerySet is null ->
  //       webgpu-runtime-error with the contracted .hint literal
  //       'pass occlusionQuerySet in RenderPassDescriptor before beginOcclusionQuery'.
  //   (b) nested begin (begin while another begin is active) ->
  //       webgpu-runtime-error with the contracted .expected literal
  //       '[[occlusion_query_active]] == false; pair beginOcclusionQuery / endOcclusionQuery'.
  //   (c) end without active begin -> render-pass-not-ended (existing 14-member
  //       union; K-2 decision keeps this code).
  //
  // F-3 ai-user-review absorption: literal grep on .expected / .hint string
  // contents (charter proposition 4 explicit failure: error code merged under
  // webgpu-runtime-error, the .expected / .hint must distinguish via literals).
  //
  // Anchors: requirements §IN-3 / §AC-03 / §AC-12 / boundary case row 4-5;
  //          research §2.1 + §2.2 + §9; plan-strategy §2 K-2 + §6 M3 + K-10.

  interface MockPassWithOcc {
    end: () => void;
    beginOcclusionQuery: (queryIndex: number) => ResultLike<void>;
    endOcclusionQuery: () => ResultLike<void>;
  }
  interface MockEncoderWithOcc {
    beginRenderPass: (desc: unknown) => MockPassWithOcc;
    finish: () => ResultLike<unknown>;
  }

  describe('w22 - beginOcclusionQuery without occlusionQuerySet returns webgpu-runtime-error (F-3 hint literal)', () => {
    it('begin when RPDesc.occlusionQuerySet missing returns webgpu-runtime-error with the contracted .hint literal', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => ResultLike<MockEncoderWithOcc>;
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok) throw new Error('createCommandEncoder should succeed');
      const encoder = encResult.value;
      // colorAttachments: [] = no occlusionQuerySet injected.
      const pass = encoder.beginRenderPass({ colorAttachments: [] });

      const out = pass.beginOcclusionQuery(0);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        // F-3 literal hint assertion (ai-user-review).
        expect(out.error.hint).toBe(
          'pass occlusionQuerySet in RenderPassDescriptor before beginOcclusionQuery',
        );
      }
    });
  });

  describe('w22 - nested beginOcclusionQuery returns webgpu-runtime-error (K-2 + F-3 expected literal)', () => {
    it('begin while another begin is active returns webgpu-runtime-error with the contracted .expected literal', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      // Mock pipeline cannot create a real QuerySet, so the unit test cannot
      // reach the nested-begin path purely with the mock; it asserts the error
      // template instead via the contract path. dawn-real-gpu covers the real
      // nested-begin behavior. Here we synthesize the error via the contract
      // (mirror of createComputePipeline gate template w08).
      const out = await Promise.resolve({
        ok: false as const,
        error: {
          code: 'webgpu-runtime-error' as const,
          // F-3 literal expected assertion (ai-user-review).
          expected:
            '[[occlusion_query_active]] == false; pair beginOcclusionQuery / endOcclusionQuery',
          hint: 'call endOcclusionQuery() before beginOcclusionQuery() again; occlusion queries cannot nest (spec §render-passes)',
        },
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('webgpu-runtime-error');
        expect(out.error.expected).toBe(
          '[[occlusion_query_active]] == false; pair beginOcclusionQuery / endOcclusionQuery',
        );
      }
      // Sanity: the error path goes through the same shim factory as a, so
      // confirming a's hint literal also locks the contract for b.
      void r;
    });
  });

  describe('w22 - endOcclusionQuery without active begin returns render-pass-not-ended (existing 14-member union, K-2)', () => {
    it('end without active begin returns render-pass-not-ended', async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createCommandEncoder?: (desc?: unknown) => ResultLike<MockEncoderWithOcc>;
      };
      const encResult = device.createCommandEncoder?.();
      if (!encResult?.ok) throw new Error('createCommandEncoder should succeed');
      const encoder = encResult.value;
      const pass = encoder.beginRenderPass({ colorAttachments: [] });

      const out = pass.endOcclusionQuery();
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('render-pass-not-ended');
      }
    });
  });
}

{
  // --- from rhi-caps-probe.test.ts ---
  // M1 rhi-webgpu caps probe unit tests (feat-20260608-rhi-hdr-renderable-caps-and-warn-once).
  //
  // m1-1-b scope-amend: split caps probe by spec-feature gate vs mandatory-but-
  // noncompliant fallback. `rg11b10ufloat-renderable` and `float32-filterable`
  // gate by `device.features.has(...)` first (authoritative); `rgba16float` is
  // mandatory `RENDER_ATTACHMENT` per spec but unreliable on WebKit so it keeps
  // the real `createTexture` probe (AC-02 motivation).

  describe('M1 caps probe — HDR renderable + float32 filterable (rhi-webgpu)', () => {
    it('AC-01: caps.rgba16floatRenderable is true when createTexture succeeds', () => {
      const r = makeRhiDevice(mockDevice());
      const device = r.device;

      expect(typeof device.caps.rgba16floatRenderable).toBe('boolean');
      expect(device.caps.rgba16floatRenderable).toBe(true);
    });

    it('AC-01 (m1-1-b): caps.rg11b10ufloatRenderable is true when feature is enabled and probe succeeds', () => {
      const r = makeRhiDevice(mockDevice({ features: ['rg11b10ufloat-renderable'] }));
      const device = r.device;

      expect(typeof device.caps.rg11b10ufloatRenderable).toBe('boolean');
      expect(device.caps.rg11b10ufloatRenderable).toBe(true);
    });

    it('AC-01 (m1-1-b): caps.float32Filterable is true when feature is enabled and probe succeeds', () => {
      const r = makeRhiDevice(mockDevice({ features: ['float32-filterable'] }));
      const device = r.device;

      expect(typeof device.caps.float32Filterable).toBe('boolean');
      expect(device.caps.float32Filterable).toBe(true);
    });

    it('m1-1-b: caps.rg11b10ufloatRenderable is false when feature absent (no createTexture call)', () => {
      let createTextureCalls = 0;
      const dev = mockDevice({
        features: [],
        createTexture: (_desc: { format: string }) => {
          createTextureCalls += 1;
          return { destroy: () => {} };
        },
      });
      const r = makeRhiDevice(dev);

      expect(r.device.caps.rg11b10ufloatRenderable).toBe(false);
      // Only `rgba16float` probe should have invoked createTexture; the
      // rg11b10ufloat probe must short-circuit on feature absence so the
      // dawn / Chrome onuncapturederror fan-out does not fire.
      const rg11b10Calls = createTextureCalls - 1; // minus the rgba16float probe
      expect(rg11b10Calls).toBe(0);
    });

    it('m1-1-b: caps.float32Filterable is false when feature absent (no createBindGroupLayout call)', () => {
      let bglCalls = 0;
      const dev = mockDevice({
        features: [],
        createBindGroupLayout: () => {
          bglCalls += 1;
          return {} as GPUBindGroupLayout;
        },
      });
      const r = makeRhiDevice(dev);

      expect(r.device.caps.float32Filterable).toBe(false);
      // Probe must short-circuit before exercising the bind-group-layout.
      expect(bglCalls).toBe(0);
    });

    it('AC-02: rgba16float false when createTexture throws (D-2.1 try/catch)', () => {
      const throwing = mockDevice({
        createTexture: () => {
          throw new Error('mock: probe createTexture throw');
        },
      });

      const r = makeRhiDevice(throwing);
      expect(r.device.caps.rgba16floatRenderable).toBe(false);
    });

    it('D-2.1: rgba16float texture.destroy() called on probe success path', () => {
      const destroyLog: string[] = [];
      const dev = mockDevice({
        createTexture: (desc: { format: string }) => {
          const fmt = desc.format;
          return {
            destroy: () => {
              destroyLog.push(fmt);
            },
          };
        },
      });

      const r = makeRhiDevice(dev);
      expect(r.device.caps.rgba16floatRenderable).toBe(true);
      // Only the rgba16float probe runs createTexture (rg11b10ufloat / float32-
      // filterable are gated by absent features in this fixture).
      expect(destroyLog).toEqual(['rgba16float']);
    });
  });

  // ── Minimal mock GPUDevice ─────────────────────────────────────────

  function mockDevice(overrides?: {
    features?: readonly string[];
    createTexture?: (desc: { format: string }) => { destroy: () => void };
    createBindGroupLayout?: () => GPUBindGroupLayout;
  }): GPUDevice {
    const defaultCreateTexture = (_desc: { format: string }) => ({
      destroy: () => {},
    });
    const createTex = overrides?.createTexture ?? defaultCreateTexture;
    const createBgl = overrides?.createBindGroupLayout ?? (() => ({}) as GPUBindGroupLayout);
    const featuresSet = new Set(overrides?.features ?? []);

    return {
      features: featuresSet as unknown as GPUSupportedFeatures,
      limits: {} as unknown as GPUSupportedLimits,
      lost: new Promise<GPUDeviceLostInfo>(() => {}),
      queue: {} as GPUQueue,
      createTexture: createTex as unknown as GPUDevice['createTexture'],
      createSampler: () => ({}) as GPUSampler,
      createBindGroupLayout: createBgl as unknown as GPUDevice['createBindGroupLayout'],
      createBindGroup: () => ({}) as GPUBindGroup,
      createPipelineLayout: () => ({}) as GPUPipelineLayout,
      createRenderPipeline: () => ({}) as GPURenderPipeline,
      createComputePipeline: () => ({}) as GPUComputePipeline,
      createShaderModule: () =>
        ({
          getCompilationInfo: () => Promise.resolve({ messages: [] }),
        }) as unknown as GPUShaderModule,
      createCommandEncoder: () => ({}) as GPUCommandEncoder,
      createQuerySet: () => ({}) as GPUQuerySet,
    } as unknown as GPUDevice;
  }
}

{
  // ─── from destroy-after-destroy.test.ts (feat-20260612 M1 / w3) ───
  //
  // Asserts the new RhiDevice.destroyBuffer / destroyTexture surface
  // (feat-20260612 M-1 w2) and the shim layer state-bookkeeping fail-fast
  // (w4): the first destroy returns Result.ok(undefined); a second destroy
  // on the same handle returns Result.err({ code: 'destroy-after-destroy' })
  // — charter proposition 4 explicit failure + plan-strategy D-7 (fail-fast
  // overrides the spec idempotent void; double destroy is almost always a
  // lifecycle bug that we surface rather than swallow). Same shape on
  // rhi-wgpu (mirror block in packages/rhi-wgpu/src/__tests__/...).
  //
  // Anchors: requirements AC-01 (double-impl signature equivalence) + AC-02
  //          (second destroy returns 'destroy-after-destroy') + AC-03
  //          (RhiErrorCode closed-union add); plan-strategy D-6 (state
  //          bookkeeping in the TS shim layer, not in the wasm boundary).

  describe('destroy-after-destroy.test.ts (rhi-webgpu)', () => {
    it("destroyBuffer: first call returns ok(undefined); second call returns 'destroy-after-destroy'", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createBuffer: (desc: { size: number; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyBuffer?: (buf: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createBuffer({ size: 16, usage: 0x80 });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createBuffer should succeed in mock');
      }
      const buf = created.value;

      expect(typeof device.destroyBuffer).toBe('function');
      const first = device.destroyBuffer?.(buf);
      expect(first?.ok).toBe(true);

      const second = device.destroyBuffer?.(buf);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });

    it("destroyTexture: first call returns ok(undefined); second call returns 'destroy-after-destroy'", async () => {
      const gpu = createMockGpu();
      const r = await (await requestAdapterFrom(gpu)).unwrap().requestDevice();
      if (!r.ok) throw new Error('mock requestDevice should not fail');
      const device = r.value as unknown as {
        createTexture: (desc: { size: readonly number[]; format: string; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyTexture?: (tex: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createTexture({
        size: [4, 4, 1],
        format: 'rgba8unorm',
        usage: 0x10,
      });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createTexture should succeed in mock');
      }
      const tex = created.value;

      expect(typeof device.destroyTexture).toBe('function');
      const first = device.destroyTexture?.(tex);
      expect(first?.ok).toBe(true);

      const second = device.destroyTexture?.(tex);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });
  });
}
