import type { QuerySet, TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { GraphAccess, RasterColorAttachment, RenderGraphFrame } from '../types.js';

const createDevice = async () =>
  (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

describe('admitted graph descriptors', () => {
  it.each([
    'foreign-buffer',
    'texture',
  ] as const)('returns a structured compile error when snapshotting observes a later %s handle', async (kind) => {
    const device = await createDevice();
    const builder = new RenderGraphBuilder();
    const admitted = builder.createBuffer('admitted', { size: 16 }).unwrap();
    const later =
      kind === 'foreign-buffer'
        ? new RenderGraphBuilder().createBuffer('foreign', { size: 16 }).unwrap()
        : builder
            .createTexture('texture', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
            .unwrap();
    let reads = 0;
    builder
      .addComputePass('changing-access', {
        accesses: [
          {
            get resource() {
              return ++reads === 1 ? admitted : (later as typeof admitted);
            },
            usage: 'storage-write',
          },
        ],
        encode: () => undefined,
      })
      .unwrap();
    const result = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      await result.value.retire();
      throw new Error('Expected the compile boundary to reject the later handle');
    }
    expect(result.error).toMatchObject({
      name: 'RenderGraphError',
      code: 'foreign-resource-handle',
      detail: { passName: 'changing-access' },
    });
  });

  it('keeps raster names on reused execution and preserves explicit instrumentation labels', async () => {
    const device = await createDevice();
    const builder = new RenderGraphBuilder();
    builder
      .addRasterPass('surface.capture', { accesses: [], colorAttachments: [], encode() {} })
      .unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const labels: (string | undefined)[] = [];
    for (const override of [undefined, 'capture.explicit', '', undefined]) {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (descriptor) => {
        labels.push(descriptor.label);
        return begin(descriptor);
      };
      compiled
        .execute(
          { encoder },
          undefined,
          override === undefined
            ? undefined
            : { begin: () => ({ renderPassDescriptor: (desc) => ({ ...desc, label: override }) }) },
        )
        .unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    }
    expect(labels).toEqual(['surface.capture', 'capture.explicit', '', 'surface.capture']);
    expect(compiled.inspect().passes[0]?.name).toBe('surface.capture');
    (await compiled.retire()).unwrap();
  });

  it('resolves query sets per execution across idle frames and page rotation', async () => {
    const device = await createDevice();
    type Frame = RenderGraphFrame & { querySet: QuerySet | undefined };
    const builder = new RenderGraphBuilder<Frame>();
    const first = device.createQuerySet({ type: 'occlusion', count: 1 }).unwrap();
    const second = device.createQuerySet({ type: 'occlusion', count: 1 }).unwrap();
    const frames = [undefined, first, undefined, second];
    class Pass {
      readonly accesses = [];
      readonly colorAttachments = [];
      #observed: (QuerySet | undefined)[] = [];
      occlusionQuerySet(frame: Frame) {
        this.#observed.push(frame.querySet);
        return frame.querySet;
      }
      encode() {}
      get observed() {
        return this.#observed;
      }
    }
    const descriptor = new Pass();
    builder.addRasterPass('query', descriptor).unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    descriptor.occlusionQuerySet = () => {
      throw new Error('replaced callback');
    };
    const observed: (QuerySet | undefined)[] = [];
    for (const querySet of frames) {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (input) => {
        observed.push(input.occlusionQuerySet);
        return begin(input);
      };
      compiled.execute({ encoder, querySet }).unwrap();
    }
    expect(observed).toEqual(frames);
    expect(descriptor.observed).toEqual(frames);
    (await compiled.retire()).unwrap();
    device.destroyQuerySet(first).unwrap();
    device.destroyQuerySet(second).unwrap();
  });

  it('retains copy access and callback snapshots while frame values remain dynamic', async () => {
    const device = await createDevice();
    const builder = new RenderGraphBuilder<RenderGraphFrame & { value: number }>();
    const buffer = builder.createBuffer('buffer', { size: 16 }).unwrap();
    const accesses: GraphAccess[] = [{ resource: buffer, usage: 'copy-dst' }];
    const observed: number[] = [];
    const descriptor = {
      accesses,
      encode: ({ frame }: { frame: { value: number } }) => {
        observed.push(frame.value);
      },
    };
    builder.addCopyPass('write', descriptor).unwrap();
    accesses.splice(0);
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    descriptor.encode = () => {
      throw new Error('caller replacement');
    };
    for (const value of [1, 2])
      compiled.execute({ encoder: device.createCommandEncoder().unwrap(), value }).unwrap();
    expect(observed).toEqual([1, 2]);
    expect(compiled.inspect().passes[0]?.accesses).toEqual([
      { resource: 'buffer', usage: 'copy-dst' },
    ]);
    expect(Object.isFrozen(descriptor)).toBe(false);
    (await compiled.retire()).unwrap();
  });

  it.each([
    'dict',
    'array',
  ])('owns texture/view descriptors, attachment arrays and %s clear values', async (form) => {
    const device = await createDevice();
    const builder = new RenderGraphBuilder();
    const extent = { width: 2, height: 3 };
    const viewFormats: TextureFormat[] = ['rgba8unorm'];
    const textureDescriptor = { format: 'rgba8unorm' as const, size: extent, viewFormats };
    const texture = builder.createTexture('color', textureDescriptor).unwrap();
    const viewDescriptor = { baseMipLevel: 0, mipLevelCount: 1 };
    const view = builder.view(texture, viewDescriptor).unwrap();
    const clear = form === 'dict' ? { r: 0.25, g: 0.5, b: 0.75, a: 1 } : [0.25, 0.5, 0.75, 1];
    const attachments: RasterColorAttachment<RenderGraphFrame>[] = [
      { view, loadOp: 'clear', storeOp: 'store', clearValue: clear },
    ];
    const access: GraphAccess = { resource: view, usage: 'color-attachment' };
    const descriptor = { accesses: [access], colorAttachments: attachments, encode: () => {} };
    builder.addRasterPass('raster', descriptor).unwrap();
    extent.width = 99;
    viewFormats.push('bgra8unorm');
    viewDescriptor.baseMipLevel = 4;
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    if (Array.isArray(clear)) clear[0] = 1;
    else clear.r = 1;
    attachments.length = 0;
    descriptor.accesses.length = 0;
    descriptor.encode = () => {
      throw new Error('caller replacement');
    };
    const encoder = device.createCommandEncoder().unwrap();
    const begin = encoder.beginRenderPass.bind(encoder);
    const observed: unknown[] = [];
    encoder.beginRenderPass = (input) => {
      observed.push(Array.from(input.colorAttachments)[0]?.clearValue);
      return begin(input);
    };
    compiled.execute({ encoder }).unwrap();
    expect(observed).toEqual([
      form === 'dict' ? { r: 0.25, g: 0.5, b: 0.75, a: 1 } : [0.25, 0.5, 0.75, 1],
    ]);
    expect(compiled.inspect().resources[0]?.descriptor).toMatchObject({ width: 2, height: 3 });
    expect(compiled.inspect().passes[0]?.accesses).toEqual([
      { resource: 'color', usage: 'color-attachment' },
    ]);
    expect(Object.isFrozen(clear)).toBe(false);
    (await compiled.retire()).unwrap();
  });

  it('retains compute hooks and evaluates the accepted predicate for each frame', async () => {
    const device = await createDevice();
    const builder = new RenderGraphBuilder<RenderGraphFrame & { active: boolean }>();
    const observed: string[] = [];
    const descriptor = {
      accesses: [],
      executeIf: (frame: { active: boolean }) => frame.active,
      begin: () => {
        observed.push('begin');
        return {};
      },
      encode: () => {
        observed.push('encode');
      },
      after: () => {
        observed.push('after');
      },
    };
    builder.addComputePass('compute', descriptor).unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    descriptor.executeIf = () => false;
    descriptor.begin =
      descriptor.encode =
      descriptor.after =
        () => {
          throw new Error('replaced');
        };
    for (const active of [false, true])
      compiled.execute({ encoder: device.createCommandEncoder().unwrap(), active }).unwrap();
    expect(observed).toEqual(['begin', 'encode', 'after']);
    (await compiled.retire()).unwrap();
  });
});

it.each([
  'copy',
  'compute',
  'raster',
] as const)('captures %s prototype callbacks with their receiver and private state', async (kind) => {
  const device = await createDevice();
  const builder = new RenderGraphBuilder();
  class Pass {
    readonly accesses = [];
    readonly colorAttachments = [];
    #calls = 0;
    #hooks: string[] = [];
    executeIf() {
      this.#hooks.push('predicate');
      return true;
    }
    begin() {
      this.#hooks.push('begin');
      return {};
    }
    after() {
      this.#hooks.push('after');
    }
    encode() {
      this.#calls++;
    }
    get calls() {
      return this.#calls;
    }
    get hooks() {
      return this.#hooks;
    }
  }
  const descriptor = new Pass();
  switch (kind) {
    case 'copy':
      builder.addCopyPass('class-pass', descriptor).unwrap();
      break;
    case 'compute':
      builder.addComputePass('class-pass', descriptor).unwrap();
      break;
    case 'raster':
      builder.addRasterPass('class-pass', descriptor).unwrap();
      break;
  }
  const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  descriptor.encode = () => {
    throw new Error('replaced callback');
  };
  descriptor.executeIf = () => false;
  descriptor.begin = () => {
    throw new Error('replaced begin');
  };
  descriptor.after = () => {
    throw new Error('replaced after');
  };
  compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
  expect(descriptor.calls).toBe(1);
  expect(descriptor.hooks).toEqual(
    kind === 'compute' ? ['predicate', 'begin', 'after'] : ['predicate'],
  );
  (await compiled.retire()).unwrap();
});
