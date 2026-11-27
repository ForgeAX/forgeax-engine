import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { observeSceneFieldCommands } from './gi-scene-field-commands.fixture';

const stages = ['traceProbes', 'updateProbes', 'deriveProbes'];
const code = stages.map((name) => `@compute @workgroup_size(1) fn ${name}(){}`).join('\n');
interface Descriptor {
  label: string;
  layout: object;
  compute: { module: object; entryPoint: string };
}
class Pass {
  pipeline?: object;
  setPipeline(pipeline: object) {
    this.pipeline = pipeline;
  }
  dispatchWorkgroups(_x: number, _y = 1, _z = 1) {
    expect(this.pipeline).toBeDefined();
  }
  dispatchWorkgroupsIndirect(_buffer: object, _offset: number) {
    expect(this.pipeline).toBeDefined();
  }
}
class Encoder {
  readonly pass = new Pass();
  readonly buffer = {};
  beginComputePass() {
    return this.pass;
  }
  finish() {
    return this.buffer;
  }
}
class Queue {
  last?: Iterable<object>;
  submit(buffers: Iterable<object>) {
    this.last = buffers;
    Array.from(buffers);
  }
}
class Device {
  readonly queue = new Queue();
  lastDescriptor?: Descriptor;
  lastEncoder?: Encoder;
  lastPromise?: Promise<object>;
  createShaderModule(descriptor: { code: string }) {
    return { code: descriptor.code };
  }
  createComputePipeline(descriptor: Descriptor) {
    this.lastDescriptor = descriptor;
    return {};
  }
  createComputePipelineAsync(descriptor: Descriptor) {
    this.lastDescriptor = descriptor;
    this.lastPromise = Promise.resolve({});
    return this.lastPromise;
  }
  createCommandEncoder() {
    this.lastEncoder = new Encoder();
    return this.lastEncoder;
  }
}
function submit(d: Device, module: object, groups = 1, omit = '') {
  const encoder = d.createCommandEncoder();
  const pass = encoder.beginComputePass();
  const descriptors = [];
  for (const entryPoint of stages) {
    if (entryPoint === omit) continue;
    const descriptor = {
      label: `irradiance-field.${entryPoint}`,
      layout: {},
      compute: { module, entryPoint },
    };
    descriptors.push(descriptor);
    const pipeline = d.createComputePipeline(descriptor);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(groups);
  }
  const buffers = [encoder.finish()];
  d.queue.submit(buffers);
  return { encoder, pass, descriptors, buffers };
}

it('observes actual submitted methods without replacing device, descriptors, returned objects or arguments', () => {
  const d = new Device(),
    sources: string[] = [];
  const observer = observeSceneFieldCommands(d, (sha, bytes) => {
    expect(sha).toBe(createHash('sha256').update(code).digest('hex'));
    expect(Buffer.from(bytes).toString()).toBe(code);
    sources.push(sha);
  });
  try {
    const start = observer.cursor(),
      module = d.createShaderModule({ code });
    const result = submit(d, module);
    expect(d.lastEncoder).toBe(result.encoder);
    expect(result.encoder.pass).toBe(result.pass);
    expect(d.lastDescriptor).toBe(result.descriptors.at(-1));
    expect(d.queue.last).toBe(result.buffers);
    const receipt = observer.completed(start, 112);
    expect(receipt.frameId).toBe(112);
    expect(receipt.dispatches.map((dispatch) => dispatch.pipeline?.entryPoint)).toEqual(stages);
    expect(receipt.dispatches.every((dispatch) => dispatch.groups.join(',') === '1,1,1')).toBe(
      true,
    );
    expect(sources).toHaveLength(1);
  } finally {
    observer.dispose();
  }
});

it('keeps the original async Promise and does not publish a late result after restore', async () => {
  const d = new Device(),
    sources: string[] = [];
  const original = Device.prototype.createShaderModule;
  const observer = observeSceneFieldCommands(d, (sha) => sources.push(sha));
  const module = d.createShaderModule({ code });
  const promise = d.createComputePipelineAsync({
    label: 'irradiance-field.traceProbes',
    layout: {},
    compute: { module, entryPoint: 'traceProbes' },
  });
  expect(promise).toBe(d.lastPromise);
  observer.dispose();
  await promise;
  expect(sources).toEqual([]);
  expect(Device.prototype.createShaderModule).toBe(original);
});

it('rejects absent or zero dispatches, unknown module identity, and actual Ray Query tokens', () => {
  for (const variant of ['missing', 'zero', 'unknown', 'ray-query']) {
    const d = new Device();
    const unobserved = d.createShaderModule({ code });
    const observer = observeSceneFieldCommands(d, () => {});
    try {
      const module =
        variant === 'unknown'
          ? unobserved
          : d.createShaderModule({
              code: variant === 'ray-query' ? `${code}\nvar<private> q: ray_query;` : code,
            });
      submit(d, module, variant === 'zero' ? 0 : 1, variant === 'missing' ? 'updateProbes' : '');
      expect(() => observer.completed(0, 113)).toThrow();
    } finally {
      observer.dispose();
    }
  }
});

it('never enumerates an arbitrary queue iterable twice or invents observed command buffers', () => {
  const d = new Device(),
    observer = observeSceneFieldCommands(d, () => {});
  let iterations = 0;
  function* buffers() {
    iterations++;
    yield {};
  }
  try {
    d.queue.submit(buffers());
    expect(iterations).toBe(1);
    expect(() => observer.completed(0, 114)).toThrow('Unobserved');
  } finally {
    observer.dispose();
  }
});

it('does not borrow another device pipeline or invoke a descriptor accessor a second time', () => {
  const d = new Device(),
    other = new Device();
  let reads = 0;
  const observer = observeSceneFieldCommands(d, () => {});
  try {
    const module = d.createShaderModule({
      get code() {
        reads++;
        return code;
      },
    });
    expect(reads).toBe(1);
    submit(d, module);
    submit(other, other.createShaderModule({ code }));
    expect(observer.cursor()).toBe(1);
    expect(() => observer.completed(0, 115)).toThrow();
  } finally {
    observer.dispose();
  }
});
