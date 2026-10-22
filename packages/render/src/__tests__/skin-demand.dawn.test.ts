import { mat4 } from '@forgeax/engine-math';
import { rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { skinDemandLayout, writeSkinDemandConstants } from '../gpu-driven/skin-demand';
import { SKIN_DEMAND_WGSL } from '../gpu-driven/skin-demand.wgsl';
import { GpuInputArena } from '../gpu-input-arena';
import { SkinInputs } from '../scene/skin-inputs';
import { SKIN_INPUT_WGSL } from '../scene/skin-inputs.wgsl';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing native demand fixture value');
  return value;
}

function matrix(x: number) {
  const value = mat4.identity(mat4.create());
  value[12] = x;
  return value;
}
function inputFixture() {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena);
  const first = skin.source(),
    second = skin.source();
  const shortBinds = new Float32Array(48);
  for (let index = 0; index < 3; index++) shortBinds.set(matrix(index + 1), index * 16);
  const short = skin.skeleton(3, shortBinds),
    wideBinds = new Float32Array(65 * 16);
  for (let index = 0; index < 65; index++) {
    wideBinds.set(matrix(index * 0.25), index * 16);
    skin.setJoint(second, index, matrix(10 + index));
  }
  const wide = skin.skeleton(65, wideBinds);
  skin.setJoint(first, 7, matrix(3));
  skin.setJoint(first, 9, matrix(4));
  skin.bind(0, first, short, new Uint32Array([7, 7, 9]));
  skin.bind(
    2048,
    second,
    wide,
    Uint32Array.from({ length: 65 }, (_, i) => i),
  );
  skin.bind(
    4096,
    second,
    wide,
    Uint32Array.from({ length: 65 }, (_, i) => (i === 64 ? 999 : i)),
  );
  const previous = skin.capture();
  skin.setJoint(first, 7, matrix(11));
  skin.setJoint(second, 0, matrix(20));
  const current = skin.capture();
  return {
    arena,
    skin,
    first,
    second,
    short,
    previous,
    current,
    dispose() {
      current.release();
      previous.release();
      skin.dispose();
      arena.dispose();
    },
  };
}

const code = `${SKIN_INPUT_WGSL}\n${SKIN_DEMAND_WGSL}
@group(0) @binding(0) var<storage,read> skinInputs:array<u32>;
@group(0) @binding(1) var<storage,read> candidateSlots:array<u32>;
@group(0) @binding(2) var<storage,read_write> skinCounters:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> skinOutput:array<vec4<u32>>;
@group(0) @binding(5) var<storage,read_write> skinIndirect:array<u32>;
@group(0) @binding(4) var<uniform> skinDemand:SkinDemandConstants;
fn skinDemandCandidateSlot(index:u32)->u32 {return candidateSlots[index];}
`;

async function nativeFixture(
  candidateCapacity: number,
  jointCapacity: number,
  maxWorkgroups = 65535,
) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Missing native adapter');
  const transport = (await (await nullRhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const transportBuffer = transport
    .createBuffer({
      size: 4 * 1024 * 1024,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    .unwrap();
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (cause) {
    transport.destroyBuffer(transportBuffer).unwrap();
    throw cause;
  }
  const owned: GPUBuffer[] = [];
  let scope = false;
  const dispose = async () => {
    const failures: unknown[] = [];
    try {
      await device.queue.onSubmittedWorkDone();
    } catch (cause) {
      failures.push(cause);
    }
    if (scope) {
      scope = false;
      try {
        const error = await device.popErrorScope();
        if (error !== null) failures.push(error);
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const buffer of owned) {
      try {
        buffer.destroy();
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      device.destroy();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      transport.destroyBuffer(transportBuffer).unwrap();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length) throw new AggregateError(failures, 'Skin demand fixture cleanup failed');
  };
  try {
    const make = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage });
      owned.push(buffer);
      return buffer;
    };
    const layout = skinDemandLayout(candidateCapacity, jointCapacity, 2048),
      counterBase = 8;
    const arena = make(4 * 1024 * 1024, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const candidates = make(
      layout.rosterCapacity * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const counters = make(
      (counterBase + layout.counterWords) * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    const output = make(
      layout.outputBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    const header = make(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(output, 0, new Uint32Array(2048 / 4).fill(0x13572468));
    device.queue.writeBuffer(counters, 0, new Uint32Array(counterBase).fill(0x24681357));
    device.pushErrorScope('validation');
    scope = true;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ];
    const bgl = device.createBindGroupLayout({ entries });
    const finalizeBgl = device.createBindGroupLayout({
      entries: [
        ...entries,
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const finalizeLayout = device.createPipelineLayout({ bindGroupLayouts: [finalizeBgl] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const module = device.createShaderModule({ code });
    const names = [
      'clearSkinDemand',
      'resetSkinDemand',
      'claimSkinDemand',
      'finalizeSkinDemand',
      'resolveSkinDemand',
    ] as const;
    const created = await Promise.allSettled(
      names.map((entryPoint) =>
        device.createComputePipelineAsync({
          layout: entryPoint === 'finalizeSkinDemand' ? finalizeLayout : pipelineLayout,
          compute: { module, entryPoint },
        }),
      ),
    );
    const pipelineErrors = created.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (pipelineErrors.length)
      throw new AggregateError(pipelineErrors, 'Skin demand pipeline creation failed');
    const pipelines = created.map((result) => {
      if (result.status !== 'fulfilled') throw new Error('Missing settled Skin demand pipeline');
      return result.value;
    });
    const indirect = make(
      12,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
    );
    const group = device.createBindGroup({
      layout: bgl,
      entries: [arena, candidates, counters, output, header].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const finalizeGroup = device.createBindGroup({
      layout: finalizeBgl,
      entries: [arena, candidates, counters, output, header, indirect].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const bytes = new ArrayBuffer(48),
      view = new DataView(bytes);
    const counterBytes = (counterBase + layout.counterWords) * 4;
    const readback = make(
      layout.outputBytes + counterBytes + 12,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    return {
      layout,
      device,
      async run(input: GpuInputArena, current: number, previous: number, slots: Uint32Array) {
        if (input.byteLength > arena.size) throw new Error('Fixture input capacity exceeded');
        writeSkinDemandConstants(
          view,
          0,
          layout,
          current,
          previous,
          slots.length,
          counterBase,
          0,
          maxWorkgroups,
        );
        // Exercise the producer's upload capability; the CPU backing stays private.
        const upload = input.connect();
        const actual = transport.queue.writeBuffer.bind(transport.queue);
        const write = vi
          .spyOn(transport.queue, 'writeBuffer')
          .mockImplementation((buffer, offset, data, start = 0, size) => {
            const bytes =
              data instanceof ArrayBuffer
                ? new Uint8Array(data, start, size ?? data.byteLength - start)
                : new Uint8Array(
                    data.buffer,
                    data.byteOffset + start,
                    size ?? data.byteLength - start,
                  );
            device.queue.writeBuffer(arena, offset, bytes);
            return actual(buffer, offset, data, start, size);
          });
        try {
          upload.flush(transport.queue, transportBuffer, true).unwrap();
        } finally {
          write.mockRestore();
          upload.release();
        }
        if (slots.length) device.queue.writeBuffer(candidates, 0, slots);
        device.queue.writeBuffer(header, 0, bytes);
        const encoder = device.createCommandEncoder();
        const counts = [
          Math.ceil(layout.rosterCapacity / 64),
          1,
          Math.max(1, Math.ceil(slots.length / 64)),
          1,
        ];
        for (let index = 0; index < pipelines.length; index++) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(required(pipelines[index]));
          pass.setBindGroup(0, index === 3 ? finalizeGroup : group);
          if (index === 4) pass.dispatchWorkgroupsIndirect(indirect, 0);
          else {
            const count = required(counts[index]);
            pass.dispatchWorkgroups(
              Math.min(count, maxWorkgroups),
              Math.ceil(count / maxWorkgroups),
            );
          }
          pass.end();
        }
        encoder.copyBufferToBuffer(output, 0, readback, 0, layout.outputBytes);
        encoder.copyBufferToBuffer(counters, 0, readback, layout.outputBytes, counterBytes);
        encoder.copyBufferToBuffer(indirect, 0, readback, layout.outputBytes + counterBytes, 12);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new Uint32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        expect(Array.from(result.slice(0, 2048 / 4))).toEqual(Array(2048 / 4).fill(0x13572468));
        const work = result.subarray(layout.outputBytes / 4);
        expect(Array.from(work.slice(0, counterBase))).toEqual(Array(counterBase).fill(0x24681357));
        const rows = new Map<number, readonly number[]>();
        for (let index = 0; index < layout.hashCapacity; index++) {
          const base = (layout.descriptorBase + index) * 4,
            key = required(result[base]);
          if (key)
            rows.set(key - 1, [
              required(result[base + 1]),
              required(result[base + 2]),
              required(result[base + 3]),
            ]);
        }
        return {
          words: result,
          floats: new Float32Array(result.buffer),
          rows,
          dispatch: Array.from(result.slice((layout.outputBytes + counterBytes) / 4)),
          count: required(work[counterBase]),
          joints: required(work[counterBase + 1]),
          overflow: required(work[counterBase + 2]),
        };
      },
      dispose,
    };
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Skin demand fixture setup failed');
    }
    throw cause;
  }
}

it('compacts colliding repeated candidate demands and resolves each whole current/previous Binding once', async () => {
  const f = inputFixture();
  try {
    const gpu = await nativeFixture(1024, f.current.jointCapacity);
    try {
      // All three keys collide at the first bucket; zero is a valid Scene slot.
      const slots = Uint32Array.from({ length: 1024 }, (_, index) =>
        required([0, 2048, 4096, 0xffffffff][index % 4]),
      );
      const result = await gpu.run(f.arena, f.current.root, f.previous.root, slots);
      expect(result.count).toBe(3);
      expect(result.joints).toBe(133);
      expect(result.dispatch).toEqual([3, 1, 1]);
      for (let index = 0; index < slots.length; index++) {
        const hash = required(result.words[(gpu.layout.candidateBase + index) * 4]);
        if (slots[index] === 0xffffffff) expect(hash).toBe(0xffffffff);
        else
          expect(result.words[(gpu.layout.descriptorBase + hash) * 4]).toBe(
            required(slots[index]) + 1,
          );
      }
      expect(result.overflow).toBe(0);
      expect(result.rows.get(0)?.[0]).toBe(3);
      expect(result.rows.get(0)?.[2]).toBe(3);
      expect(result.rows.get(2048)?.[0]).toBe(65);
      expect(result.rows.get(2048)?.[2]).toBe(3);
      expect(result.rows.get(4096)?.[2]).toBe(0); // Missing whole pose, even if a mesh would use only joint zero.
      for (const [slot, count] of [
        [0, 3],
        [2048, 65],
      ] as const) {
        const base = required(required(result.rows.get(slot))[1]) * 4;
        for (let index = 0; index < count; index++) {
          const current =
            slot === 0 ? required([12, 13, 7][index]) : index === 0 ? 20 : 10 + index * 1.25;
          const previous = slot === 0 ? required([4, 5, 7][index]) : 10 + index * 1.25;
          expect(result.floats[base + index * 16 + 12]).toBeCloseTo(current, 5);
          expect(result.floats[base + (count + index) * 16 + 12]).toBeCloseTo(previous, 5);
          expect(result.floats[base + index * 16]).toBe(1);
          expect(result.floats[base + index * 16 + 15]).toBe(1);
        }
      }
    } finally {
      await gpu.dispose();
    }
  } finally {
    f.dispose();
  }
});

it('sparsely clears the previous demand roster and restores a missing joint without Binding rewrite or stale history', async () => {
  const f = inputFixture();
  try {
    const gpu = await nativeFixture(4, f.current.jointCapacity, 2);
    try {
      const first = await gpu.run(
        f.arena,
        f.current.root,
        f.previous.root,
        new Uint32Array([0, 2048, 4096]),
      );
      expect(first.count).toBe(3);
      expect(first.dispatch).toEqual([2, 2, 1]);
      f.skin.setJoint(f.second, 999, matrix(44));
      const restored = f.skin.capture();
      try {
        const result = await gpu.run(
          f.arena,
          restored.root,
          f.current.root,
          new Uint32Array([4096, 4096]),
        );
        expect(result.count).toBe(1);
        expect(result.overflow).toBe(0);
        expect([...result.rows.keys()]).toEqual([4096]);
        const row = required(result.rows.get(4096));
        expect(row[2]).toBe(1);
        const base = required(row[1]) * 4;
        for (let index = 0; index < 65; index++)
          for (let lane = 0; lane < 16; lane++)
            expect(result.words[base + index * 16 + lane]).toBe(
              result.words[base + (65 + index) * 16 + lane],
            );
      } finally {
        restored.release();
      }
    } finally {
      await gpu.dispose();
    }
  } finally {
    f.dispose();
  }
});

it('rejects an adversarial palette capacity and retains every claimed key for sparse cleanup on the next task', async () => {
  const f = inputFixture();
  try {
    const gpu = await nativeFixture(4, 1);
    try {
      const invalid = await gpu.run(f.arena, f.current.root, f.previous.root, new Uint32Array([0]));
      expect(invalid.overflow).toBe(1);
      expect([...invalid.rows.values()].every((row) => row[2] === 0)).toBe(true);
      f.skin.updateSkeleton(f.short, 1, matrix(1));
      f.skin.bind(0, f.first, f.short, new Uint32Array([7]));
      const next = f.skin.capture();
      try {
        const result = await gpu.run(f.arena, next.root, f.current.root, new Uint32Array([0]));
        expect(result.overflow).toBe(0);
        expect(result.count).toBe(1);
        expect(result.rows.get(0)?.[2]).toBe(1);
      } finally {
        next.release();
      }
    } finally {
      await gpu.dispose();
    }
  } finally {
    f.dispose();
  }
});

it('seeds every previous matrix from current when a finite previous pose composes to infinity', async () => {
  const f = inputFixture();
  try {
    const inverse = new Float32Array(48);
    for (let index = 0; index < 3; index++) {
      const value = matrix(0);
      value[0] = 1e20;
      inverse.set(value, index * 16);
    }
    f.skin.updateSkeleton(f.short, 3, inverse);
    const value = matrix(0);
    value[0] = 1e20;
    f.skin.setJoint(f.first, 7, value);
    f.skin.setJoint(f.first, 9, value);
    const previous = f.skin.capture();
    value[0] = 1e-20;
    f.skin.setJoint(f.first, 7, value);
    f.skin.setJoint(f.first, 9, value);
    const current = f.skin.capture();
    try {
      expect(current.historyCompatible(previous, 0)).toBe(true);
      const gpu = await nativeFixture(1, current.jointCapacity);
      try {
        const result = await gpu.run(f.arena, current.root, previous.root, new Uint32Array([0]));
        expect(result.overflow).toBe(0);
        const row = required(result.rows.get(0));
        expect(row[2]).toBe(1);
        const base = required(row[1]) * 4;
        expect(result.floats[base]).toBeCloseTo(1, 5);
        for (let index = 0; index < 48; index++) {
          expect(Number.isFinite(result.floats[base + index])).toBe(true);
          expect(result.words[base + index]).toBe(result.words[base + 48 + index]);
        }
      } finally {
        await gpu.dispose();
      }
    } finally {
      current.release();
      previous.release();
    }
  } finally {
    f.dispose();
  }
});
