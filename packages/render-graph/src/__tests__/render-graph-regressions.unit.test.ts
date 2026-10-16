import type { Buffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import { RenderGraph } from '../graph.js';

interface Frame {
  readonly encoder: RhiCommandEncoder;
  readonly external: Buffer;
}

describe('RenderGraph fixed temporal regressions', () => {
  it('accepts write-read-write without depending on a future writer', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<Frame>();
    const x = graph.createBuffer('x', { size: 16 }).unwrap();
    const y = graph.createBuffer('y', { size: 16 }).unwrap();
    graph.addCopyPass('seed-x', {
      accesses: [{ resource: x, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addCopyPass('consume-x', {
      accesses: [
        { resource: x, usage: 'copy-src' },
        { resource: y, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });
    graph.addCopyPass('rewrite-x', {
      accesses: [
        { resource: y, usage: 'copy-src' },
        { resource: x, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });

    const result = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.inspect().passes.map((pass) => pass.name)).toEqual([
        'seed-x',
        'consume-x',
        'rewrite-x',
      ]);
    }
  });

  it('accepts first read only when a resource is imported from its owner', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<Frame>();
    const input = graph
      .importBuffer('external-input', { size: 16, usage: 0x0040 }, (frame) => frame.external)
      .unwrap();
    graph.addComputePass('consume-external', {
      accesses: [{ resource: input, usage: 'uniform-read' }],
      encode: () => undefined,
    });

    expect(graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).ok).toBe(true);
  });

  it('rejects a repeated pass label at declaration time', () => {
    const graph = new RenderGraphBuilder<Frame>();
    expect(graph.addCopyPass('duplicate-label', { accesses: [], encode: () => undefined }).ok).toBe(
      true,
    );
    const duplicate = graph.addCopyPass('duplicate-label', {
      accesses: [],
      encode: () => undefined,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('duplicate-pass-name');
  });

  it('owns compute pass begin and end for the current RenderGraph facade', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraph<Frame>();
    graph.addResource('external', { kind: 'buffer', lifetime: 'persistent' });
    graph.addComputePass('compute', {
      reads: ['external'],
      writes: [],
      encode: ({ pass }) => pass.dispatchWorkgroups(1),
    });
    expect(graph.compile({ backendKind: 'null', caps: device.caps, device }).ok).toBe(true);
    const encoder = device.createCommandEncoder({ label: 'facade-compute' }).unwrap();
    graph.execute({ encoder, external: device.createBuffer({ size: 16, usage: 0x40 }).unwrap() });
    expect(encoder.finish().ok).toBe(true);
  });

  it('runs compute after-work only after ending the graph-owned pass', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraph<Frame>();
    const events: string[] = [];
    graph.addResource('external', { kind: 'buffer', lifetime: 'persistent' });
    graph.addComputePass('timed-compute', {
      reads: ['external'],
      writes: [],
      encode: ({ pass }) => {
        events.push('encode');
        pass.dispatchWorkgroups(1);
      },
      after: () => events.push('after'),
    });
    expect(graph.compile({ backendKind: 'null', caps: device.caps, device }).ok).toBe(true);
    const rawEncoder = device.createCommandEncoder({ label: 'timed-compute' }).unwrap();
    const encoder = {
      beginComputePass: (...args: Parameters<RhiCommandEncoder['beginComputePass']>) => {
        events.push('begin');
        const pass = rawEncoder.beginComputePass(...args);
        const end = pass.end.bind(pass);
        pass.end = () => {
          events.push('end');
          end();
        };
        return pass;
      },
    } as RhiCommandEncoder;
    graph.execute({
      encoder,
      external: device.createBuffer({ size: 16, usage: 0x40 }).unwrap(),
    });

    expect(events).toEqual(['begin', 'encode', 'end', 'after']);
    expect(rawEncoder.finish().ok).toBe(true);
  });
});
