import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type {
  CompiledRenderGraph,
  GraphResourceResolver,
  RenderGraphFrame,
  RenderGraphNativePass,
  SubgraphPass,
} from '../types.js';

type Frame = RenderGraphFrame & { child?: CompiledRenderGraph<Frame> };
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};
const surfaceSize = { width: 8, height: 4 };
const device = async () => (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const compile = (builder: RenderGraphBuilder<Frame>, gpu: RhiDevice) =>
  builder.compile({ device: gpu, surfaceSize }).unwrap();
const frame = (gpu: RhiDevice): Frame => ({ encoder: gpu.createCommandEncoder().unwrap() });

function fixture(gpu: RhiDevice) {
  const parent = new RenderGraphBuilder<Frame>();
  const data = parent.createBuffer('shared', { size: 16 }).unwrap();
  const color = parent.createTexture('color', { format: 'rgba8unorm', size: 'surface' }).unwrap();
  const view = parent.view(color).unwrap();
  parent
    .addCopyPass('seed', {
      accesses: [{ resource: data, usage: 'copy-dst' }],
      encode: () => {},
    })
    .unwrap();
  parent
    .addRasterPass('clear', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => {},
    })
    .unwrap();
  const child = (
    resources: GraphResourceResolver,
    options: {
      omitBuffer?: boolean;
      privateBuffer?: boolean;
      usage?: 'storage-read' | 'storage-write';
      extent?: number;
      wrongView?: boolean;
      fail?: boolean;
      reads?: number[];
      textureReads?: number[];
      viewReads?: number[];
    } = {},
  ) => {
    const graph = new RenderGraphBuilder<Frame>();
    const source = required(resources.bufferSource)(data).unwrap();
    const target = required(resources.textureViewSource)(view).unwrap();
    const buffer = options.privateBuffer
      ? gpu.createBuffer({ size: 16, usage: 0x80 }).unwrap()
      : source.buffer;
    const input = graph
      .importBuffer('input', source.descriptor, () => {
        options.reads?.push(1);
        return buffer;
      })
      .unwrap();
    const texture = graph
      .importTexture(
        'target',
        {
          ...target.descriptor,
          ...(options.extent === undefined ? {} : { size: { width: options.extent, height: 4 } }),
        },
        () => {
          options.textureReads?.push(1);
          return target.texture;
        },
      )
      .unwrap();
    const importedView = graph
      .importView(texture, target.viewDescriptor, () => {
        options.viewReads?.push(1);
        return options.wrongView ? gpu.createTextureView(target.texture, {}).unwrap() : target.view;
      })
      .unwrap();
    graph
      .addComputePass('child-compute', {
        accesses: options.omitBuffer
          ? []
          : [{ resource: input, usage: options.usage ?? 'storage-write' }],
        encode: ({ pass, resources }) => {
          if (!options.omitBuffer) expect(resources.buffer(input).unwrap()).toBe(buffer);
          if (options.fail) throw new Error('child failed');
          pass.dispatchWorkgroups(1);
        },
      })
      .unwrap();
    graph
      .addRasterPass('child-raster', {
        accesses: [{ resource: importedView, usage: 'color-attachment' }],
        colorAttachments: [{ view: importedView, loadOp: 'load', storeOp: 'store' }],
        encode: ({ resources }) =>
          expect(resources.textureView(importedView).unwrap()).toBe(target.view),
      })
      .unwrap();
    return compile(graph, gpu);
  };
  return { parent, data, view, child };
}

describe('graph-native subgraph ports', () => {
  it('retains ordinary graph ordinals when an earlier pass is disabled', async () => {
    const gpu = await device(),
      builder = new RenderGraphBuilder<Frame>();
    builder
      .addComputePass('disabled', { accesses: [], executeIf: () => false, encode: () => {} })
      .unwrap();
    builder.addCopyPass('active', { accesses: [], encode: () => {} }).unwrap();
    const graph = compile(builder, gpu),
      indices: number[] = [];
    graph
      .execute(frame(gpu), undefined, {
        begin: (pass) => {
          indices.push(pass.executionIndex);
          return undefined;
        },
      })
      .unwrap();
    expect(indices).toEqual([1]);
    await graph.retire();
  });
  it('orders parent writes, child scopes and parent reads on one encoder with original instrumentation', async () => {
    const gpu = await device(),
      f = fixture(gpu),
      names: string[] = [],
      observed: string[] = [],
      indices: number[] = [],
      reads: number[] = [],
      textureReads: number[] = [],
      viewReads: number[] = [];
    f.parent
      .addSubgraphPass('slot', {
        accesses: [
          { resource: f.data, usage: 'storage-read-write' },
          { resource: f.view, usage: 'color-attachment' },
        ],
        child: (_frame, resources) => f.child(resources, { reads, textureReads, viewReads }),
      })
      .unwrap();
    f.parent
      .addComputePass('after', {
        accesses: [{ resource: f.data, usage: 'storage-read' }],
        encode: () => {},
      })
      .unwrap();
    const graph = compile(f.parent, gpu),
      current = frame(gpu);
    expect(graph.inspect().passes.at(-1)?.dependencies).toContain('slot');
    expect(
      graph.execute(
        current,
        (pass, encode) => {
          names.push(pass.name);
          encode();
        },
        {
          begin: (pass) => {
            observed.push(pass.name);
            indices.push(pass.executionIndex);
            return undefined;
          },
        },
      ).ok,
    ).toBe(true);
    expect(names).toEqual(['seed', 'clear', 'slot', 'child-compute', 'child-raster', 'after']);
    expect(observed).toEqual(['seed', 'clear', 'child-compute', 'child-raster', 'after']);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
    expect(reads).toEqual([1]);
    expect(textureReads).toEqual([1]);
    expect(viewReads).toEqual([1]);
    expect(current.encoder.finish().ok).toBe(true);
    await graph.retire();
  });

  it('selects new child imports each frame without resolving getters again for validation or encoding', async () => {
    const gpu = await device(),
      a = gpu.createBuffer({ size: 16, usage: 0x80 }).unwrap(),
      b = gpu.createBuffer({ size: 16, usage: 0x80 }).unwrap();
    let selected = a,
      reads = 0;
    const child = new RenderGraphBuilder<Frame>();
    const input = child
      .importBuffer('private', { size: 16, usage: 0x80 }, () => {
        reads++;
        const result = selected;
        selected = result === a ? b : a;
        return result;
      })
      .unwrap();
    const seen: Buffer[] = [];
    child
      .addComputePass('private-work', {
        accesses: [{ resource: input, usage: 'storage-read' }],
        encode: ({ resources }) => {
          seen.push(resources.buffer(input).unwrap());
        },
      })
      .unwrap();
    const parent = new RenderGraphBuilder<Frame>();
    parent
      .addSubgraphPass('slot', { accesses: [], child: (current) => required(current.child) })
      .unwrap();
    const graph = compile(parent, gpu),
      first = compile(child, gpu);
    expect(graph.execute({ ...frame(gpu), child: first }).ok).toBe(true);
    expect(graph.execute({ ...frame(gpu), child: first }).ok).toBe(true);
    const replacement = new RenderGraphBuilder<Frame>();
    replacement.addCopyPass('replacement', { accesses: [], encode: () => {} }).unwrap();
    expect(graph.execute({ ...frame(gpu), child: compile(replacement, gpu) }).ok).toBe(true);
    expect(reads).toBe(2);
    expect(seen).toEqual([a, b]);
    await graph.retire();
  });

  it.each([
    'missing',
    'usage',
    'view',
    'extent',
    'failure',
  ] as const)('rejects %s and never executes later parent work', async (kind) => {
    const gpu = await device(),
      f = fixture(gpu);
    let later = false;
    f.parent
      .addSubgraphPass('slot', {
        accesses: [
          ...(kind === 'missing'
            ? []
            : [
                {
                  resource: f.data,
                  usage:
                    kind === 'usage' ? ('storage-read' as const) : ('storage-read-write' as const),
                },
              ]),
          { resource: f.view, usage: 'color-attachment' },
        ],
        child: (_frame, resources) => {
          // Missing ports must also prevent obtaining their resource through the callback.
          if (kind === 'missing') {
            expect(required(resources.bufferSource)(f.data).ok).toBe(false);
            const bad = new RenderGraphBuilder<Frame>();
            const texture = gpu
              .createTexture({ format: 'rgba8unorm', size: { width: 8, height: 4 }, usage: 0x10 })
              .unwrap();
            const t = bad
              .importTexture(
                'unadvertised',
                { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
                () => texture,
              )
              .unwrap();
            const v = bad.view(t).unwrap();
            bad
              .addRasterPass('bad', {
                accesses: [{ resource: v, usage: 'color-attachment' }],
                colorAttachments: [{ view: v, loadOp: 'clear', storeOp: 'store' }],
                encode: () => {},
              })
              .unwrap();
            return compile(bad, gpu);
          }
          return f.child(resources, {
            wrongView: kind === 'view',
            ...(kind === 'extent' ? { extent: 4 } : {}),
            fail: kind === 'failure',
          });
        },
      })
      .unwrap();
    f.parent
      .addCopyPass('later', {
        accesses: [],
        encode: () => {
          later = true;
        },
      })
      .unwrap();
    const graph = compile(f.parent, gpu),
      result = graph.execute(frame(gpu));
    expect(result.ok).toBe(false);
    expect(later).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe(
        kind === 'failure' ? 'pass-encode-failed' : 'resource-descriptor-invalid',
      );
    await graph.retire();
  });

  it.each([
    'device',
    'retired',
    'forged',
    'created',
    'unused-texture',
    'recursive',
  ] as const)('rejects a %s child', async (kind) => {
    const gpu = await device(),
      parent = new RenderGraphBuilder<Frame>(),
      other = kind === 'device' ? await device() : gpu;
    const child = new RenderGraphBuilder<Frame>();
    if (kind === 'created') child.createBuffer('unowned', { size: 16 }).unwrap();
    if (kind === 'unused-texture')
      child
        .importTexture(
          'unadvertised',
          { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
          () => {
            throw new Error('unused import must not resolve');
          },
        )
        .unwrap();
    child.addCopyPass('work', { accesses: [], encode: () => {} }).unwrap();
    const compiledChild = compile(child, other);
    if (kind === 'retired') await compiledChild.retire();
    let graph: CompiledRenderGraph<Frame>;
    parent
      .addSubgraphPass('slot', {
        accesses: [],
        child: () =>
          kind === 'recursive'
            ? graph
            : kind === 'forged'
              ? Object.create(Object.getPrototypeOf(compiledChild))
              : compiledChild,
      })
      .unwrap();
    graph = compile(parent, gpu);
    const result = graph.execute(frame(gpu));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('resource-descriptor-invalid');
    await graph.retire();
  });

  it('rejects a physical parent buffer alias captured outside the advertised ports', async () => {
    const gpu = await device(),
      parent = new RenderGraphBuilder<Frame>();
    const input = parent.createBuffer('hidden', { size: 16 }).unwrap();
    let captured: Buffer | undefined;
    parent
      .addComputePass('capture', {
        accesses: [{ resource: input, usage: 'storage-write' }],
        encode: ({ resources }) => {
          captured = resources.buffer(input).unwrap();
        },
      })
      .unwrap();
    parent
      .addSubgraphPass('slot', {
        accesses: [],
        child: () => {
          const child = new RenderGraphBuilder<Frame>();
          const alias = child
            .importBuffer('alias', { size: 16, usage: 0x80 }, () => required(captured))
            .unwrap();
          child
            .addComputePass('illegal', {
              accesses: [{ resource: alias, usage: 'storage-read' }],
              encode: () => {
                throw new Error('must not encode');
              },
            })
            .unwrap();
          return compile(child, gpu);
        },
      })
      .unwrap();
    const graph = compile(parent, gpu),
      result = graph.execute(frame(gpu));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        code: 'resource-descriptor-invalid',
        detail: { field: 'buffer-port' },
      });
    await graph.retire();
  });

  it('rejects retirement caused by an import getter before encoding the resolved child', async () => {
    const gpu = await device(),
      parent = new RenderGraphBuilder<Frame>(),
      child = new RenderGraphBuilder<Frame>();
    const physical = gpu.createBuffer({ size: 16, usage: 0x80 }).unwrap();
    let compiledChild: CompiledRenderGraph<Frame>,
      encoded = false;
    const input = child
      .importBuffer('private', { size: 16, usage: 0x80 }, () => {
        void compiledChild.retire();
        return physical;
      })
      .unwrap();
    child
      .addComputePass('stale', {
        accesses: [{ resource: input, usage: 'storage-read' }],
        encode: () => {
          encoded = true;
        },
      })
      .unwrap();
    compiledChild = compile(child, gpu);
    parent.addSubgraphPass('slot', { accesses: [], child: () => compiledChild }).unwrap();
    const graph = compile(parent, gpu);
    expect(graph.execute(frame(gpu)).ok).toBe(false);
    expect(encoded).toBe(false);
    await graph.retire();
  });

  it('keeps ordinary pass usage validation strict while allowing ordered child scope ports', async () => {
    const gpu = await device(),
      f = fixture(gpu);
    f.parent
      .addSubgraphPass('slot', {
        accesses: [
          { resource: f.data, usage: 'copy-src' },
          { resource: f.data, usage: 'storage-write' },
          { resource: f.view, usage: 'color-attachment' },
        ],
        child: (_frame, resources) => f.child(resources),
      })
      .unwrap();
    const graph = compile(f.parent, gpu);
    expect(graph.execute(frame(gpu)).ok).toBe(true);
    const ordinary = new RenderGraphBuilder<Frame>();
    const input = ordinary
      .importBuffer('input', { size: 16, usage: 0x84 }, () =>
        gpu.createBuffer({ size: 16, usage: 0x84 }).unwrap(),
      )
      .unwrap();
    ordinary
      .addCopyPass('invalid-copy', {
        accesses: [{ resource: input, usage: 'storage-write' }],
        encode: () => {},
      })
      .unwrap();
    expect(ordinary.compile({ device: gpu, surfaceSize }).ok).toBe(false);
    await graph.retire();
  });
});

it('captures a native command callback once and keeps actual pass instrumentation', async () => {
  const gpu = await device();
  const builder = new RenderGraphBuilder<Frame>();
  let reads = 0;
  let calls = 0;
  let escaped: ((pass: RenderGraphNativePass) => void) | undefined;
  const commands: NonNullable<SubgraphPass<Frame>['commands']> = ({ execute }) => {
    calls++;
    escaped = execute;
    execute({ kind: 'compute', name: 'current-compute', encode: () => {} });
  };
  const descriptor = Object.defineProperty({ accesses: [] }, 'commands', {
    get() {
      reads++;
      return reads === 1
        ? commands
        : () => {
            throw Error('changed callback');
          };
    },
  }) as unknown as SubgraphPass<Frame>;
  builder.addSubgraphPass('slot', descriptor).unwrap();
  const graph = compile(builder, gpu);
  const observed: string[] = [];
  graph
    .execute(frame(gpu), undefined, {
      begin: (pass) => {
        observed.push(`${pass.executionIndex}:${pass.kind}:${pass.name}`);
        return undefined;
      },
    })
    .unwrap();
  expect(reads).toBe(1);
  expect(calls).toBe(1);
  expect(observed).toEqual(['0:compute:current-compute']);
  expect(() => required(escaped)({ kind: 'copy', name: 'escaped', encode: () => {} })).toThrow();
  await graph.retire();
});
