import { createHash } from 'node:crypto';
import { assert } from 'vitest';

/** Mechanical output-tail observation only. Every byte through the actual
 * traceWorld call is retained; this is not a second traversal implementation. */
export function screenWorldHitObservation(source: string) {
  const marker = ' let status=hit.state.x;';
  const at = source.indexOf(marker);
  assert(at >= 0 && source.indexOf(marker, at + 1) === -1 && source.endsWith('\n}\n'));
  const prefix = source.slice(0, at);
  return {
    prefix,
    source: `${prefix}
 rays[i]=ProbeRay(vec3f(hit.metrics.xy,bitcast<f32>(hit.state.y|(hit.state.x<<24u))),hit.state.w,hit.position.xyz,length(hit.position.xyz-probe.position));
}
`,
  };
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function guardDiagnosticWrites(device: GPUDevice) {
  const writeBuffer = device.queue.writeBuffer,
    writeTexture = device.queue.writeTexture;
  let frozen: GPUBuffer | undefined,
    replayWrites = 0;
  device.queue.writeBuffer = function (...args) {
    if (frozen !== undefined) {
      assert(args[0] === frozen, 'No query uniform or storage upload during diagnostic replay');
      replayWrites++;
    }
    return Reflect.apply(writeBuffer, this, args);
  };
  device.queue.writeTexture = function (...args) {
    assert(frozen === undefined, 'No texture upload during diagnostic replay');
    return Reflect.apply(writeTexture, this, args);
  };
  return {
    begin(buffer: GPUBuffer) {
      assert(frozen === undefined);
      frozen = buffer;
      replayWrites = 0;
    },
    end() {
      frozen = undefined;
      return replayWrites;
    },
    dispose() {
      device.queue.writeBuffer = writeBuffer;
      device.queue.writeTexture = writeTexture;
    },
  };
}

async function readBuffers(
  device: GPUDevice,
  buffers: readonly { binding: number; buffer: GPUBuffer; offset: number; size: number }[],
) {
  const total = buffers.reduce((sum, row) => sum + row.size, 0);
  const read = device.createBuffer({ size: total, usage: 9 });
  try {
    const encoder = device.createCommandEncoder();
    let offset = 0;
    for (const row of buffers) {
      assert((row.buffer.usage & 4) !== 0, 'Actual recorder-owned query input must be readable');
      encoder.copyBufferToBuffer(row.buffer, row.offset, read, offset, row.size);
      offset += row.size;
    }
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const bytes = read.getMappedRange().slice(0);
    offset = 0;
    return buffers.map((row) => {
      const data = new Uint8Array(bytes.slice(offset, offset + row.size));
      offset += row.size;
      return { ...row, data };
    });
  } finally {
    read.destroy();
  }
}

/** Capture public Native calls without changing descriptors, returned modules,
 * pipelines or Promise identities. Diagnostic dispatch is explicit and later. */
export function observeScreenWorldHit(device: GPUDevice) {
  const writes = guardDiagnosticWrites(device);
  const createModule = device.createShaderModule,
    createPipeline = device.createComputePipelineAsync;
  const createGroup = device.createBindGroup,
    createEncoder = device.createCommandEncoder;
  let sources = new WeakMap<GPUShaderModule, string>();
  let pipelines = new WeakMap<GPUComputePipeline, GPUComputePipelineDescriptor>();
  let groups = new WeakMap<GPUBindGroup, GPUBindGroupDescriptor>();
  let world:
    | {
        descriptor: GPUComputePipelineDescriptor;
        group?: GPUBindGroup;
        dispatch?: readonly [number, number, number];
      }
    | undefined;
  device.createShaderModule = function (...args) {
    const value = Reflect.apply(createModule, this, args);
    sources.set(value, args[0].code);
    return value;
  };
  device.createComputePipelineAsync = function (...args) {
    const promise = Reflect.apply(createPipeline, this, args);
    void promise.then(
      (value) => pipelines.set(value, args[0]),
      () => undefined,
    );
    return promise;
  };
  device.createBindGroup = function (...args) {
    const value = Reflect.apply(createGroup, this, args);
    groups.set(value, args[0]);
    return value;
  };
  device.createCommandEncoder = function (...args) {
    const encoder = Reflect.apply(createEncoder, this, args),
      begin = encoder.beginComputePass;
    encoder.beginComputePass = function (...passArgs) {
      const pass = Reflect.apply(begin, this, passArgs);
      if (passArgs[0]?.label !== 'screen-probe.trace-world') return pass;
      const setPipeline = pass.setPipeline,
        setGroup = pass.setBindGroup,
        dispatch = pass.dispatchWorkgroups;
      pass.setPipeline = function (...values) {
        const result = Reflect.apply(setPipeline, this, values),
          descriptor = pipelines.get(values[0]);
        assert(descriptor?.compute.entryPoint === 'traceWorldProbes');
        world = { descriptor };
        return result;
      };
      pass.setBindGroup = function (
        ...values: [number, GPUBindGroup | null | undefined, ...unknown[]]
      ) {
        const result = Reflect.apply(setGroup, this, values);
        const group = values[1];
        assert(world && values[0] === 0);
        if (group === null || group === undefined) delete world.group;
        else {
          assert(groups.has(group));
          world.group = group;
        }
        return result;
      };
      pass.dispatchWorkgroups = function (x, y = 1, z = 1) {
        const result = Reflect.apply(dispatch, this, [x, y, z]);
        assert(world);
        world.dispatch = [x, y, z];
        return result;
      };
      return pass;
    };
    return encoder;
  };
  return {
    async dispatch(beforeWorld: ArrayBuffer, productionAfterWorld: ArrayBuffer) {
      const captured = world;
      assert(captured?.group && captured.dispatch && captured.descriptor.layout !== 'auto');
      const source = sources.get(captured.descriptor.compute.module),
        group = groups.get(captured.group);
      assert(source && group);
      const observation = screenWorldHitObservation(source);
      const buffers = Array.from(group.entries).flatMap((entry) => {
        if (!('buffer' in entry.resource)) return [];
        const { buffer, offset = 0, size = buffer.size - offset } = entry.resource;
        return [{ binding: entry.binding, buffer, offset, size }];
      });
      const rays = buffers.find((row) => row.binding === 7);
      assert(rays && rays.offset === 0 && rays.size === beforeWorld.byteLength);
      assert(productionAfterWorld.byteLength === rays.size);
      const inputs = buffers.filter((row) => [0, 1, 2, 3, 4, 8, 9].includes(row.binding));
      assert(inputs.length === 7);
      writes.begin(rays.buffer);
      try {
        const first = await readBuffers(device, inputs);
        const module = Reflect.apply(createModule, device, [
          { label: 'test.screen-world-hit-output', code: observation.source },
        ]);
        const descriptor = {
          ...captured.descriptor,
          label: 'test.screen-world-hit-output',
          compute: { ...captured.descriptor.compute, module },
        };
        const pipeline = await Reflect.apply(createPipeline, device, [descriptor]);
        device.queue.writeBuffer(rays.buffer, 0, beforeWorld);
        const encoder = Reflect.apply(createEncoder, device, []),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, captured.group);
        pass.dispatchWorkgroups(...captured.dispatch);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const output = (await readBuffers(device, [rays]))[0];
        assert(output);
        device.queue.writeBuffer(rays.buffer, 0, productionAfterWorld);
        const restored = (await readBuffers(device, [rays]))[0];
        assert(restored);
        assert(
          sha(restored.data) === sha(new Uint8Array(productionAfterWorld)),
          'Production ray bytes must be restored before any further draw',
        );
        const last = await readBuffers(device, inputs);
        const facts = first.map((row, i) => {
          assert(
            sha(row.data) === sha(last[i]?.data ?? new Uint8Array()),
            'Actual World query input changed',
          );
          return {
            binding: row.binding,
            offset: row.offset,
            size: row.size,
            sha256: sha(row.data),
          };
        });
        assert(writes.end() === 2, 'Exactly one replay and one production-ray restoration upload');
        return {
          bytes: output.data,
          inputs: first,
          metadata: {
            scope:
              'Diagnostic re-dispatch of frozen real production inputs, not direct original-frame Hit readback',
            sourceSHA256: sha(source),
            prefixSHA256: sha(observation.prefix),
            diagnosticSHA256: sha(observation.source),
            beforeWorldSHA256: sha(new Uint8Array(beforeWorld)),
            dispatch: captured.dispatch,
            extraDispatches: 1,
            extraBindings: 0,
            inputs: facts,
            productionRaysRestoredSHA256: sha(restored.data),
            timeValidation: 'not-qualified',
            queryInputKinds: 'Five storage bindings 0/2/3/4/8 and two uniform bindings 1/9',
            inputIsolation:
              'Same captured PL/BG/dispatch; all seven query buffers hashed before/after; no texture or other buffer writes during replay',
            radianceResources:
              'Card settings binding 10 and atlas textures belong to the replaced radiance tail, not the retained query prefix; original frame resources remain in its RHI tape',
          },
          source,
          diagnosticSource: observation.source,
        };
      } finally {
        writes.end();
      }
    },
    dispose() {
      device.createShaderModule = createModule;
      device.createComputePipelineAsync = createPipeline;
      device.createBindGroup = createGroup;
      device.createCommandEncoder = createEncoder;
      writes.dispose();
      sources = new WeakMap();
      pipelines = new WeakMap();
      groups = new WeakMap();
      world = undefined;
    },
  };
}
