import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { SkinInputs } from '../scene/skin-inputs';
import { skinDeformation } from './skin-inputs.gpu-fixture';

function world(x: number, scale: number): Mat4 {
  const value = mat4.create();
  value.set([scale, 0, 0, 0, 0, scale + 1, 0, 0, 0, 0, scale + 2, 0, x, 0, 0, 1]);
  return value;
}

it('deforms two Worlds and Skeletons in one dispatch and rejects incomplete poses before output', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const skin = new SkinInputs(inputs.arena);
  const sources = [skin.source(), skin.source()] as const;
  const inverseBinds = [world(1, 2), world(2, 3), world(3, 4)] as const;
  const otherInverseBinds = [world(8, 1), world(9, 2), world(10, 3)] as const;
  const nextInverseBinds = [world(4, 3), world(5, 4), world(6, 5)] as const;
  const flat = (values: readonly Mat4[]) => new Float32Array(values.flatMap((m) => Array.from(m)));
  const skeletons = [
    skin.skeleton(3, flat(inverseBinds)),
    skin.skeleton(3, flat(otherInverseBinds)),
  ] as const;
  for (const [i, source] of sources.entries()) {
    skin.setJoint(source, 7, world(3 + i * 10, 1));
    skin.setJoint(source, 9, world(4 + i * 10, 2));
    skin.bind(
      11 + i * 16,
      source,
      i === 0 ? skeletons[0] : skeletons[1],
      new Uint32Array([7, 7, 9]),
    );
  }
  const previous = skin.capture(); // No CPU per-Binding admission.
  const previousGpu = inputs.capture();
  const previousArena = previousGpu.buffer().unwrap();
  previousGpu.seal().unwrap();
  skin.updateSkeleton(skeletons[0], 3, flat(nextInverseBinds));
  skin.setJoint(sources[0], 7, world(11, 3));
  skin.setJoint(sources[1], 7, world(21, 3));
  const current = skin.capture();
  const currentGpu = inputs.capture();
  const arena = currentGpu.buffer().unwrap();
  currentGpu.seal().unwrap();
  expect(arena.buffer).not.toBe(previousArena.buffer);
  expect(current.historyCompatible(previous, 11)).toBe(false);
  expect(current.historyCompatible(previous, 27)).toBe(true);
  const resources: Buffer[] = [];
  try {
    const frame = device
      .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const output = device
      .createBuffer({ size: 160, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
      .unwrap();
    const readback = device
      .createBuffer({ size: 160, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    resources.push(frame, output, readback);
    device.queue
      .writeBuffer(frame, 0, new Uint32Array([current.root, previous.root, 11, 0]))
      .unwrap();
    const outputLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
    const skinLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'read-only-storage' },
          },
          { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const layout = device
      .createPipelineLayout({ bindGroupLayouts: [outputLayout, empty, skinLayout] })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: skinDeformation }).unwrap();
    const pipeline = device
      .createComputePipeline({ layout, compute: { module, entryPoint: 'probe' } })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const emptyGroup = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
    const skinGroup = device
      .createBindGroup({
        layout: skinLayout,
        entries: [
          { binding: 1, resource: { kind: 'buffer', value: { buffer: arena.buffer } } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: frame } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, outputGroup);
    pass.setBindGroup(1, emptyGroup);
    pass.setBindGroup(2, skinGroup);
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 160);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const result = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();

    // Independent CPU pre-multiplied reference, including nonuniform scales,
    // duplicate identities with different inverse binds and distinct history.
    const oracle = (a: Mat4, b: Mat4, ibms: readonly [Mat4, Mat4, Mat4]) => {
      const blend = new Float32Array(16);
      const value = mat4.create();
      for (const [index, weight] of [
        [0, 0.25],
        [1, 0.25],
        [2, 0.25],
        [0, 0.25],
      ] as const) {
        mat4.multiply(value, index === 2 ? b : a, ibms[index]);
        for (let lane = 0; lane < 16; lane++)
          blend[lane] = (blend[lane] ?? 0) + (value[lane] ?? 0) * weight;
      }
      const apply = (p: readonly number[]) =>
        Array.from({ length: 4 }, (_, row) =>
          p.reduce((sum, value, column) => sum + value * (blend[column * 4 + row] ?? 0), 0),
        );
      return {
        position: apply([1, 2, 3, 1]),
        normal: apply([0, 1, 0, 0]),
        tangent: apply([1, 0, 0, 0]),
      };
    };
    const expected = oracle(world(11, 3), world(4, 2), nextInverseBinds);
    const old = oracle(world(3, 1), world(4, 2), inverseBinds);
    const expectedOther = oracle(world(21, 3), world(14, 2), otherInverseBinds);
    const oldOther = oracle(world(13, 1), world(14, 2), otherInverseBinds);
    const values = [expected, expectedOther].flatMap((pose, index) => [
      ...pose.position,
      ...(index === 0 ? expected.position : oldOther.position),
      ...pose.normal,
      ...pose.tangent,
      ...pose.position.map((value, lane) => value * ([2, 3, 4, 1][lane] ?? 0)),
    ]);
    values.forEach((value, index) => {
      expect(result[index]).toBeCloseTo(value, 5);
    });
    expect(expected.position).not.toEqual(old.position);
    skin.removeJoint(sources[0], 9);
    const missing = skin.capture();
    const missingGpu = inputs.capture();
    try {
      const missingArena = missingGpu.buffer().unwrap();
      missingGpu.seal().unwrap();
      device.queue
        .writeBuffer(frame, 0, new Uint32Array([missing.root, previous.root, 11, 0]))
        .unwrap();
      const missingGroup = device
        .createBindGroup({
          layout: skinLayout,
          entries: [
            { binding: 1, resource: { kind: 'buffer', value: { buffer: missingArena.buffer } } },
            { binding: 2, resource: { kind: 'buffer', value: { buffer: frame } } },
          ],
        })
        .unwrap();
      const next = device.createCommandEncoder().unwrap();
      const pass = next.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, outputGroup);
      pass.setBindGroup(1, emptyGroup);
      pass.setBindGroup(2, missingGroup);
      pass.dispatchWorkgroups(2);
      pass.end();
      next.copyBufferToBuffer(output, 0, readback, 0, 160);
      device.queue.submit([next.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const rejected = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      expect(Array.from(rejected.slice(0, 20))).toEqual(Array(20).fill(0));
      values.slice(20).forEach((value, index) => {
        expect(rejected[20 + index]).toBeCloseTo(value, 5);
      });
      // An absent previous root resets motion without suppressing current geometry.
      device.queue
        .writeBuffer(frame, 0, new Uint32Array([current.root, 0xffffffff, 11, 0]))
        .unwrap();
      const reset = device.createCommandEncoder().unwrap();
      const resetPass = reset.beginComputePass();
      resetPass.setPipeline(pipeline);
      resetPass.setBindGroup(0, outputGroup);
      resetPass.setBindGroup(1, emptyGroup);
      resetPass.setBindGroup(2, skinGroup);
      resetPass.dispatchWorkgroups(2);
      resetPass.end();
      reset.copyBufferToBuffer(output, 0, readback, 0, 160);
      device.queue.submit([reset.finish().unwrap()]).unwrap();
      const resetMap = (await readback.mapAsync(1)).unwrap();
      const resetValues = new Float32Array(resetMap.getMappedRange().unwrap().slice(0));
      resetMap.unmap();
      for (let i = 0; i < 2; i++) {
        const position = i === 0 ? expected.position : expectedOther.position;
        position.forEach((value, lane) => {
          expect(resetValues[i * 20 + lane]).toBeCloseTo(value, 5);
          expect(resetValues[i * 20 + 4 + lane]).toBeCloseTo(value, 5);
        });
      }
      await device.queue.onSubmittedWorkDone();
    } finally {
      missingGpu.release();
      missing.release();
    }
  } finally {
    await device.queue.onSubmittedWorkDone();
    currentGpu.release();
    previousGpu.release();
    current.release();
    previous.release();
    skin.dispose();
    inputs.dispose();
    for (const resource of resources) device.destroyBuffer(resource).unwrap();
  }
});

async function readBuffer(device: RhiDevice, buffer: Buffer, bytes: number): Promise<Uint32Array> {
  const target = device
    .createBuffer({ size: bytes, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(buffer, 0, target, 0, bytes);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await target.mapAsync(1)).unwrap();
    const result = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return result;
  } finally {
    await device.queue.onSubmittedWorkDone();
    device.destroyBuffer(target).unwrap();
  }
}
function rowAddress(
  words: Uint32Array,
  root: number,
  space: number,
  key: number,
): number | undefined {
  let address = root;
  for (const value of [space, key])
    for (let shift = 24; shift >= 0; shift -= 8) {
      if (address === 0xffffffff) return undefined;
      const next = words[address + ((value >>> shift) & 255)];
      if (next === undefined) throw new Error('Missing physical Skin page');
      address = next;
    }
  return address === 0xffffffff ? undefined : address;
}
function translation(
  words: Uint32Array,
  root: number,
  namespace: number,
  entity: number,
): number | undefined {
  const address = rowAddress(words, root, namespace, entity);
  if (address === undefined) return undefined;
  expect(words[address]).toBe(entity);
  return new Float32Array(words.buffer)[address + 13];
}

it('owns unqueried Binding/Skeleton bytes through rebind, source retirement, growth and aborted B', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const skin = new SkinInputs(inputs.arena);
  const source = skin.source(),
    skeleton = skin.skeleton(1, world(1, 1), {
      joints: new Uint16Array([0]),
      shapes: new Float32Array([1, 2, 3, 4, 5, 6, 2]),
    });
  skin.setJoint(source, 7, world(3, 1));
  skin.setJoint(source, 8, world(4, 1));
  skin.bind(11, source, skeleton, new Uint32Array([7]));
  const a = skin.capture(); // Deliberately never query the Binding on CPU.
  // Generic Material/Mesh publication can advance after a Skin root is fixed.
  const material = inputs.allocateResource(inputs.arena.allocateDescriptor(4));
  const aGpu = inputs.capture();
  const aInput = aGpu.buffer().unwrap();
  aGpu.seal().unwrap();
  // Different upper branch leaves the old target leaf shared under an exclusive ancestor.
  skin.setJoint(source, 0x02000007, world(21, 1));
  skin.setJoint(source, 7, world(9, 1));
  skin.setJoint(source, 8, world(13, 1));
  const nextSource = skin.source(),
    nextSkeleton = skin.skeleton(1, world(2, 1), {
      joints: new Uint16Array([0]),
      shapes: new Float32Array([7, 8, 9, 10, 11, 12, 4]),
    });
  skin.unbind(11);
  skin.bind(11, nextSource, nextSkeleton, new Uint32Array([7]));
  skin.setJoint(nextSource, 7, world(20, 1));
  skin.remove(source);
  skin.remove(skeleton);
  expect(nextSource.id).not.toBe(source.id);
  expect(nextSkeleton.id).not.toBe(skeleton.id);
  for (let i = 1; i <= 64; i++) skin.setJoint(nextSource, i * 256, world(i, 1));
  const b = skin.capture(),
    bGpu = inputs.capture(),
    bInput = bGpu.buffer().unwrap();
  bGpu.seal().unwrap();
  try {
    expect(bInput.buffer).not.toBe(aInput.buffer);
    expect(bInput.byteLength).toBeGreaterThan(aInput.byteLength);
    const old = await readBuffer(device, aInput.buffer, aInput.byteLength);
    const grown = await readBuffer(device, bInput.buffer, bInput.byteLength);
    for (const bytes of [old, grown]) {
      expect(translation(bytes, a.root, source.id, 7)).toBe(3);
      expect(translation(bytes, a.root, source.id, 8)).toBe(4);
      const binding = rowAddress(bytes, a.root, 1, 11);
      if (binding === undefined) throw new Error('Missing held Skin binding');
      expect(Array.from(bytes.slice(binding, binding + 4))).toEqual([1, source.id, skeleton.id, 7]);
      const ibm = rowAddress(bytes, a.root, 0, skeleton.id);
      if (ibm === undefined) throw new Error('Missing held Skeleton');
      expect(new Float32Array(bytes.buffer)[ibm + 13]).toBe(1);
      expect(Array.from(bytes.slice(ibm + 17, ibm + 19))).toEqual([1, 0]);
      expect(Array.from(new Float32Array(bytes.buffer).slice(ibm + 19, ibm + 26))).toEqual([
        1, 2, 3, 4, 5, 6, 2,
      ]);
    }
    const nextBinding = rowAddress(grown, b.root, 1, 11);
    if (nextBinding === undefined) throw new Error('Missing rebound Skin');
    expect(Array.from(grown.slice(nextBinding, nextBinding + 4))).toEqual([
      1,
      nextSource.id,
      nextSkeleton.id,
      7,
    ]);
    const nextIbm = rowAddress(grown, b.root, 0, nextSkeleton.id);
    if (nextIbm === undefined) throw new Error('Missing replacement Skeleton');
    expect(Array.from(grown.slice(nextIbm + 17, nextIbm + 19))).toEqual([1, 0]);
    expect(Array.from(new Float32Array(grown.buffer).slice(nextIbm + 19, nextIbm + 26))).toEqual([
      7, 8, 9, 10, 11, 12, 4,
    ]);
    expect(translation(grown, b.root, nextSource.id, 7)).toBe(20);
    expect(translation(grown, b.root, source.id, 7)).toBeUndefined();
    // A detached device incarnation cold-uploads the same owning numbers.
    // Retiring it cannot dispose the CPU arena or its still-held GPU buffer.
    const candidateDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const candidate = new GpuSceneInputs(candidateDevice, (slot) => slot + 1000, inputs.arena);
    const candidateRead = candidate.capture();
    try {
      const physical = candidateRead.buffer().unwrap();
      candidateRead.seal().unwrap();
      candidate.dispose();
      const bytes = await readBuffer(candidateDevice, physical.buffer, physical.byteLength);
      expect(translation(bytes, a.root, source.id, 7)).toBe(3);
      expect(translation(bytes, b.root, nextSource.id, 7)).toBe(20);
      expect(inputs.arena.readWord(nextBinding)).toBe(1);
    } finally {
      candidateRead.release();
      candidate.dispose();
      await candidateDevice.queue.onSubmittedWorkDone();
    }
    bGpu.release();
    b.release(); // Abort does not advance or release previous A.
    skin.removeJoint(nextSource, 7);
    skin.setJoint(nextSource, 0x01000007, world(17, 1));
    const c = skin.capture();
    const cGpu = inputs.capture();
    try {
      const cInput = cGpu.buffer().unwrap();
      cGpu.seal().unwrap();
      const bytes = await readBuffer(device, cInput.buffer, cInput.byteLength);
      expect(translation(bytes, a.root, source.id, 7)).toBe(3);
      expect(translation(bytes, c.root, nextSource.id, 7)).toBeUndefined();
      expect(translation(bytes, c.root, nextSource.id, 0x01000007)).toBe(17);
    } finally {
      cGpu.release();
      c.release();
    }
  } finally {
    await device.queue.onSubmittedWorkDone();
    aGpu.release();
    bGpu.release();
    a.release();
    b.release();
    inputs.releaseResource(material);
    skin.dispose();
    inputs.dispose();
  }
});

it('uploads numeric patches from byte offsets without changing adjacent rows', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const arena = inputs.arena;
  const first = arena.allocateDescriptor(4),
    second = arena.allocateDescriptor(4);
  const data = new DataView(new ArrayBuffer(16));
  for (let lane = 0; lane < 4; lane++) data.setUint32(lane * 4, 101 + lane, true);
  arena.writeDescriptor(first, data, 4);
  for (let lane = 0; lane < 4; lane++) data.setUint32(lane * 4, 201 + lane, true);
  arena.writeDescriptor(second, data, 4);
  const initial = inputs.capture();
  const physical = initial.buffer().unwrap();
  initial.seal().unwrap();
  initial.release();
  const before = inputs.uploadBytes;
  arena.writeDescriptorWord(second, 4, 2, 12345);
  const next = inputs.capture();
  try {
    const patched = next.buffer().unwrap();
    next.seal().unwrap();
    expect(patched.buffer).toBe(physical.buffer);
    expect(inputs.uploadBytes - before).toBe(16);
    const bytes = await readBuffer(device, patched.buffer, patched.byteLength);
    expect(Array.from(bytes.slice(first, first + 4))).toEqual([101, 102, 103, 104]);
    expect(Array.from(bytes.slice(second, second + 4))).toEqual([201, 202, 12345, 204]);
  } finally {
    await device.queue.onSubmittedWorkDone();
    next.release();
    arena.releaseDescriptor(first, 4);
    arena.releaseDescriptor(second, 4);
    inputs.dispose();
  }
});
