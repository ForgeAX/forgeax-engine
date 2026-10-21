import type { TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { type ComputePassDescriptor, RenderGraph, type ResourceDescriptor } from '../graph';
import type { RenderGraphFrame } from '../types';

async function deviceForTest() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

it('keeps accepted pass accesses and callback when the author changes its descriptor', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph<number>();
  const first = vi.fn();
  const replacement = vi.fn();
  const descriptor = { reads: [] as string[], writes: ['out'], execute: first };
  graph.addResource('out', { kind: 'buffer', lifetime: 'transient' }).unwrap();
  graph.addPass('write', descriptor);
  descriptor.reads.push('missing');
  descriptor.writes.length = 0;
  descriptor.execute = replacement;
  const compiled = graph.compile({ caps: device.caps }).unwrap();
  graph.execute(7);
  expect(compiled.passes[0]).toEqual({ name: 'write', reads: [], writes: ['out'] });
  expect(first).toHaveBeenCalledWith(7, expect.anything());
  expect(replacement).not.toHaveBeenCalled();
});

it('keeps accepted resource lifetime and target allocation size after author mutation', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph();
  const resource: ResourceDescriptor = { kind: 'buffer', lifetime: 'persistent' };
  const mutableResource = { ...resource };
  graph.addResource('input', mutableResource).unwrap();
  graph.addPass('read', { reads: ['input'], writes: [] });
  mutableResource.lifetime = 'transient';
  const size = { w: 4, h: 8 };
  const viewFormats: TextureFormat[] = ['rgba8unorm-srgb'];
  graph.addColorTarget('color', { format: 'rgba8unorm', size, viewFormats }).unwrap();
  graph.addColorTargetAlias('color-alias', 'color').unwrap();
  size.w = 32;
  viewFormats.push('rgba16float');
  const creates = vi.spyOn(device, 'createTexture');
  try {
    graph.compile({ caps: device.caps, device }).unwrap();
    expect(graph.getColorTargetDescriptor('color')?.size).toEqual({ width: 4, height: 8 });
    expect(graph.getColorTargetTexture('color-alias')).toBe(graph.getColorTargetTexture('color'));
    expect(creates.mock.calls[0]?.[0].viewFormats).toEqual(['rgba8unorm-srgb']);
  } finally {
    graph.drain();
  }
});

it('captures compute callbacks once while preserving their receiver state across executions', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph<RenderGraphFrame>();
  const calls: string[] = [];
  const descriptor = {
    label: 'first',
    reads: [],
    writes: [],
    begin() {
      calls.push(`begin:${this.label}`);
      return {};
    },
    encode() {
      calls.push(`encode:${this.label}`);
    },
    after() {
      calls.push(`after:${this.label}`);
    },
  } satisfies ComputePassDescriptor<RenderGraphFrame> & { label: string };
  graph.addComputePass('compute', descriptor);
  descriptor.label = 'live';
  descriptor.begin = () => {
    throw new Error('replacement must not run');
  };
  descriptor.encode = () => {
    throw new Error('replacement must not run');
  };
  descriptor.after = () => {
    throw new Error('replacement must not run');
  };
  graph.compile({ caps: device.caps }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  graph.execute({ encoder });
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  expect(calls).toEqual(['begin:live', 'encode:live', 'after:live']);
});

it('accepts prototype pass accessors and methods while snapshotting their values', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph();
  let calls = 0;
  class Pass {
    get reads() {
      return [];
    }
    get writes() {
      return [];
    }
    execute() {
      calls += 1;
    }
  }
  graph.addPass('class-pass', new Pass());
  graph.compile({ caps: device.caps }).unwrap();
  graph.execute(undefined);
  expect(calls).toBe(1);
});

it('accepts inherited resource and nested target properties', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph();
  class Resource {
    get kind() {
      return 'buffer' as const;
    }
    get lifetime() {
      return 'persistent' as const;
    }
  }
  let width = 4;
  class Size {
    get w() {
      return width;
    }
    get h() {
      return 8;
    }
  }
  class Target {
    get size() {
      return new Size();
    }
    get format() {
      return 'rgba8unorm' as const;
    }
    get viewFormats() {
      return ['rgba8unorm-srgb'] as const;
    }
  }
  graph.addResource('input', new Resource()).unwrap();
  graph.addPass('read', { reads: ['input'], writes: [] });
  graph.addColorTarget('color', new Target()).unwrap();
  width = 32;
  try {
    graph.compile({ caps: device.caps, device }).unwrap();
    expect(graph.getColorTargetDescriptor('color')?.size).toEqual({ width: 4, height: 8 });
    expect(graph.listResources()).toContainEqual({
      key: 'input',
      kind: 'buffer',
      lifetime: 'persistent',
    });
  } finally {
    graph.drain();
  }
});

it('retains inherited color-domain connections and conversion kinds', async () => {
  const device = await deviceForTest();
  const graph = new RenderGraph();
  graph
    .addColorTarget('hdr', { format: 'rgba16float', size: 'swapchain', domain: 'linear-hdr' })
    .unwrap();
  graph
    .addColorTarget('ldr', { format: 'rgba8unorm', size: 'swapchain', domain: 'linear-ldr' })
    .unwrap();
  class Conversion {
    get kind() {
      return 'tone-map' as const;
    }
  }
  class Connection {
    get source() {
      return 'hdr';
    }
    get destination() {
      return 'ldr';
    }
    get conversion() {
      return new Conversion();
    }
  }
  graph.addPass('seed', { reads: [], writes: ['hdr'] });
  graph.addPass('tone', { reads: ['hdr'], writes: ['ldr'], colorConnections: [new Connection()] });
  expect(graph.compile({ caps: device.caps }).ok).toBe(true);
});
