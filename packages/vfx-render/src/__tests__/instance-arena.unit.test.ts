import type { RenderFeatureWork } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import { createVfxInstanceArena, type VfxArenaInstance } from '../feature/instance-arena';

type Resource = RenderFeatureWork['resources'][number];
type BufferResource = Extract<Resource, { readonly kind: 'buffer' }>;
type Bindings = Extract<Resource, { readonly kind: 'compute-bindings' }>;
type Pass = RenderFeatureWork['passes'][number];
type Draw = Extract<Pass, { readonly kind: 'raster' }>['draws'][number];

function instance(prefix: string, program = 'stock-program'): VfxArenaInstance {
  return { prefix, owner: `owner:${prefix}`, program };
}

function stateWork(instances: readonly VfxArenaInstance[]): RenderFeatureWork {
  return {
    scope: 'frame',
    resources: instances.flatMap((row): Resource[] => [
      { kind: 'buffer', name: `${row.prefix}.particles`, size: 112, usage: ['storage'] },
      {
        kind: 'compute-bindings',
        name: `${row.prefix}.bindings`,
        program: row.program,
        entries: [{ binding: 0, resource: `${row.prefix}.particles` }],
      },
    ]),
    passes: [],
  };
}

function workAt(work: readonly RenderFeatureWork[], index = 0): RenderFeatureWork {
  const result = work[index];
  if (result === undefined) throw new Error(`Missing work at ${index}`);
  return result;
}

function resource<K extends Resource['kind']>(
  work: RenderFeatureWork,
  name: string,
  kind: K,
): Extract<Resource, { readonly kind: K }> {
  const result = work.resources.find((entry) => entry.name === name && entry.kind === kind);
  if (result === undefined) throw new Error(`Missing ${kind} resource ${name}`);
  return result as Extract<Resource, { readonly kind: K }>;
}

function buffers(work: RenderFeatureWork): readonly BufferResource[] {
  return work.resources.filter((entry): entry is BufferResource => entry.kind === 'buffer');
}

function stateRange(work: RenderFeatureWork, prefix: string): Bindings['entries'][number] {
  const entry = resource(work, `${prefix}.bindings`, 'compute-bindings').entries[0];
  if (entry === undefined) throw new Error(`Missing state binding for ${prefix}`);
  return entry;
}

function owners(instances: readonly VfxArenaInstance[]): ReadonlySet<string> {
  return new Set(instances.map((row) => row.owner));
}

describe('stock VFX instance arena semantics', () => {
  it('transfers private copy/indirect/raster commands with identical ranges and no repeated offset', () => {
    const instances = [instance('player-a'), instance('player-b')];
    const make = (): RenderFeatureWork => {
      const copy = { source: 'external-zero', destination: 'player-b.particles', size: 16 };
      const draw: Draw = {
        program: 'draw',
        bindings: [],
        vertexData: [],
        draw: { kind: 'draw-indirect', resource: 'player-b.particles', offset: 4 },
      };
      return {
        ...stateWork(instances),
        passes: [
          { kind: 'copy', name: 'reset-0', enabled: false, copies: [copy] },
          {
            kind: 'compute',
            name: 'tick',
            program: 'stock-program',
            bindings: 'player-b.bindings',
            dispatches: [
              { kind: 'indirect', entryPoint: 'main', resource: 'player-b.particles', offset: 8 },
            ],
          },
          { kind: 'copy', name: 'reset-1', enabled: true, copies: [copy] },
          { kind: 'copy', name: 'reset-2', enabled: true, copies: [copy] },
          { kind: 'raster', name: 'draw', colorAttachments: [], draws: [draw] },
          { kind: 'shadow-caster', name: 'shadow', draws: [draw] },
        ],
      };
    };
    const source = make(),
      expected = make();
    const sourceResources = structuredClone(source.resources);
    const before = structuredClone(expected);
    const raw = createVfxInstanceArena(),
      owned = createVfxInstanceArena();
    const input = { instances, liveOwners: owners(instances), generation: 1 };
    const result = workAt(owned({ ...input, work: [source], transferPasses: true }));
    expect(result).toEqual(workAt(raw({ ...input, work: [expected] })));
    expect(expected).toEqual(before);
    expect(result.passes).toBe(source.passes);
    expect(source.resources).toEqual(sourceResources);
    const retained = structuredClone(result);
    owned({ ...input, work: [make()], transferPasses: true });
    expect(result).toEqual(retained);
    owned({ ...input, generation: 2, work: [make()], transferPasses: true });
    expect(result).toEqual(retained);
  });

  it('keeps same-named view command ownership separate when consuming two fresh views', () => {
    const instances = [instance('player-a'), instance('player-b')];
    const make = (): RenderFeatureWork[] =>
      ['main', 'side'].map((view) => ({
        scope: { view },
        resources: instances.map((entry) => ({
          kind: 'buffer',
          name: `${entry.prefix}.instances`,
          size: 32,
          usage: ['storage', 'vertex', 'indirect'],
        })),
        passes: [
          {
            kind: 'raster',
            name: 'draw',
            colorAttachments: [],
            draws: [
              {
                program: 'draw',
                bindings: [],
                vertexData: [],
                draw: { kind: 'draw-indirect', resource: 'player-b.instances', offset: 4 },
              },
            ],
          },
        ],
      }));
    const source = make(),
      expected = make();
    const input = { instances, liveOwners: owners(instances), generation: 1 };
    const result = createVfxInstanceArena()({ ...input, work: source, transferPasses: true });
    expect(result).toEqual(createVfxInstanceArena()({ ...input, work: expected }));
    const first = result[0]?.passes[0],
      second = result[1]?.passes[0];
    if (first?.kind !== 'raster' || second?.kind !== 'raster') throw new Error('Missing views');
    expect(first.draws[0]?.draw).not.toBe(second.draws[0]?.draw);
    expect(first.draws[0]?.draw).toMatchObject({ offset: 260 });
    expect(second.draws[0]?.draw).toMatchObject({ offset: 260 });
    expect(first.draws[0]?.draw).not.toEqual(second.draws[0]?.draw);
  });

  it('keeps unchanged private command arrays while packing their resource buffers', () => {
    const pack = createVfxInstanceArena();
    const a = instance('player-a');
    const passes: readonly Pass[] = Object.freeze([
      Object.freeze({
        kind: 'compute' as const,
        name: 'simulate',
        program: a.program,
        bindings: 'player-a.bindings',
        dispatches: Object.freeze([
          Object.freeze({ kind: 'direct' as const, entryPoint: 'main', workgroups: [1] as const }),
        ]),
      }),
      Object.freeze({
        kind: 'copy' as const,
        name: 'custom-copy',
        copies: Object.freeze([{ source: 'custom-source', destination: 'custom-dest', size: 4 }]),
      }),
      Object.freeze({
        kind: 'raster' as const,
        name: 'direct-draw',
        colorAttachments: [],
        draws: Object.freeze([
          {
            program: 'custom',
            bindings: [],
            vertexData: [],
            draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
          },
        ]),
      }),
    ]);
    const source: RenderFeatureWork = { ...stateWork([a]), passes };
    const packed = workAt(
      pack({ work: [source], instances: [a], liveOwners: owners([a]), generation: 1 }),
    );
    expect(buffers(packed)).toHaveLength(1);
    expect(buffers(packed)[0]?.name).not.toBe('player-a.particles');
    expect(Object.hasOwn(buffers(packed)[0] ?? {}, 'uploads')).toBe(false);
    expect(packed.passes).toBe(passes);
    for (const [index, pass] of passes.entries()) expect(packed.passes[index]).toBe(pass);
  });

  it('copies only commands whose arena ranges change and leaves a retained source plan intact', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a'), instance('player-b')];
    const direct = { kind: 'direct' as const, entryPoint: 'direct', workgroups: [2] as const };
    const indirect = {
      kind: 'indirect' as const,
      entryPoint: 'indirect',
      resource: 'player-b.particles',
      offset: 4,
    };
    const custom = {
      kind: 'indirect' as const,
      entryPoint: 'provider',
      resource: 'custom-provider',
      offset: 8,
    };
    const pass: Pass = Object.freeze({
      kind: 'compute',
      name: 'mixed',
      program: 'stock-program',
      bindings: 'player-b.bindings',
      dispatches: Object.freeze([direct, indirect, custom]),
    });
    const source: RenderFeatureWork = { ...stateWork(instances), passes: Object.freeze([pass]) };
    const before = structuredClone(source);
    const input = { work: [source], instances, liveOwners: owners(instances), generation: 1 };
    const first = workAt(pack(input)),
      repeated = workAt(pack(input));
    const mapped = first.passes[0];
    if (mapped?.kind !== 'compute' || pass.kind !== 'compute')
      throw new Error('Missing compute work');
    expect(mapped).not.toBe(pass);
    expect(mapped.dispatches).not.toBe(pass.dispatches);
    expect(mapped.dispatches[0]).toBe(direct);
    expect(mapped.dispatches[2]).toBe(custom);
    expect(mapped.dispatches[1]).toEqual({
      ...indirect,
      resource: stateRange(first, 'player-b').resource,
      offset: 260,
    });
    expect(mapped.dispatches[1]?.kind === 'indirect' && mapped.dispatches[1].resource).not.toBe(
      indirect.resource,
    );
    expect(repeated).toEqual(first);
    expect(source).toEqual(before);
    expect(indirect).toEqual({
      kind: 'indirect',
      entryPoint: 'indirect',
      resource: 'player-b.particles',
      offset: 4,
    });
  });

  it('shares one state buffer between players while retaining aligned, disjoint ranges', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a'), instance('player-b')];
    const packed = workAt(
      pack({
        work: [stateWork(instances)],
        instances,
        liveOwners: owners(instances),
        generation: 1,
      }),
    );
    const a = stateRange(packed, 'player-a');
    const b = stateRange(packed, 'player-b');

    expect(buffers(packed)).toHaveLength(1);
    expect(a.resource).toBe(b.resource);
    expect(a.size).toBe(112);
    expect(b.size).toBe(112);
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(256);
    expect((a.offset ?? 0) % 256).toBe(0);
    expect((b.offset ?? 0) % 256).toBe(0);
    expect((a.offset ?? 0) + (a.size ?? 0)).toBeLessThanOrEqual(b.offset ?? 0);
    expect(resource(packed, a.resource, 'buffer').size).toBe(16 * 256);
  });

  it('keeps each tick upload in player declaration order at its own offset', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a'), instance('player-b')];
    const a0 = new Uint32Array([10, 11]);
    const b0 = new Uint32Array([20, 21]);
    const b1 = new Uint32Array([22, 23]);
    const a1 = new Uint32Array([12, 13]);
    const runtimeWork = (
      secondA: Uint32Array | undefined,
      secondB: Uint32Array | undefined,
    ): RenderFeatureWork => ({
      scope: 'frame',
      resources: [
        {
          kind: 'buffer',
          name: 'player-a.tick-0.runtime',
          size: 192,
          usage: ['uniform'],
          data: a0,
        },
        {
          kind: 'buffer',
          name: 'player-b.tick-0.runtime',
          size: 192,
          usage: ['uniform'],
          data: b0,
        },
        {
          kind: 'buffer',
          name: 'player-a.tick-1.runtime',
          size: 192,
          usage: ['uniform'],
          ...(secondA === undefined ? {} : { data: secondA }),
        },
        {
          kind: 'buffer',
          name: 'player-b.tick-1.runtime',
          size: 192,
          usage: ['uniform'],
          ...(secondB === undefined ? {} : { data: secondB }),
        },
        {
          kind: 'compute-bindings',
          name: 'tick-0.bindings',
          program: 'stock-program',
          entries: [
            { binding: 0, resource: 'player-a.tick-0.runtime' },
            { binding: 1, resource: 'player-b.tick-0.runtime' },
          ],
        },
        {
          kind: 'compute-bindings',
          name: 'tick-1.bindings',
          program: 'stock-program',
          entries: [
            { binding: 0, resource: 'player-a.tick-1.runtime' },
            { binding: 1, resource: 'player-b.tick-1.runtime' },
          ],
        },
      ],
      passes: [],
    });
    const first = workAt(
      pack({
        work: [runtimeWork(undefined, b1)],
        instances,
        liveOwners: owners(instances),
        generation: 1,
      }),
    );
    const tick0Name = resource(first, 'tick-0.bindings', 'compute-bindings').entries[0]?.resource;
    const tick1Name = resource(first, 'tick-1.bindings', 'compute-bindings').entries[0]?.resource;
    if (tick0Name === undefined || tick1Name === undefined)
      throw new Error('Missing tick bindings');
    const tick0 = resource(first, tick0Name, 'buffer');
    const tick1 = resource(first, tick1Name, 'buffer');

    expect(buffers(first)).toHaveLength(2);
    expect(tick0.uploads?.map((upload) => upload.offset)).toEqual([0, 256]);
    expect(tick0.uploads?.[0]?.data).toBe(a0);
    expect(tick0.uploads?.[1]?.data).toBe(b0);
    expect(tick1.uploads?.map((upload) => upload.offset)).toEqual([256]);
    expect(tick1.uploads?.[0]?.data).toBe(b1);

    const second = workAt(
      pack({
        work: [runtimeWork(a1, undefined)],
        instances,
        liveOwners: owners(instances),
        generation: 1,
      }),
    );
    const nextTick1 = resource(second, tick1Name, 'buffer');
    expect(nextTick1.uploads?.map((upload) => upload.offset)).toEqual([0]);
    expect(nextTick1.uploads?.[0]?.data).toBe(a1);
    expect(tick1.uploads?.[0]?.data).toBe(b1);
  });

  it('opens a second slab after sixteen slots without resizing or moving the first slab', () => {
    const pack = createVfxInstanceArena();
    const firstInstances = Array.from({ length: 16 }, (_, index) => instance(`player-${index}`));
    const first = workAt(
      pack({
        work: [stateWork(firstInstances)],
        instances: firstInstances,
        liveOwners: owners(firstInstances),
        generation: 1,
      }),
    );
    const originalBuffer = buffers(first)[0];
    if (originalBuffer === undefined) throw new Error('Missing first slab');
    const allInstances = [...firstInstances, instance('player-16')];
    const second = workAt(
      pack({
        work: [stateWork(allInstances)],
        instances: allInstances,
        liveOwners: owners(allInstances),
        generation: 1,
      }),
    );
    const seventeenth = stateRange(second, 'player-16');

    expect(buffers(first)).toHaveLength(1);
    expect(buffers(second)).toHaveLength(2);
    expect(resource(second, originalBuffer.name, 'buffer').size).toBe(originalBuffer.size);
    expect(originalBuffer.size).toBe(16 * 256);
    for (const row of firstInstances)
      expect(stateRange(second, row.prefix)).toEqual(stateRange(first, row.prefix));
    expect(seventeenth.resource).not.toBe(originalBuffer.name);
    expect(seventeenth.offset).toBe(0);
    expect(resource(second, seventeenth.resource, 'buffer').size).toBe(originalBuffer.size);
  });

  it('retains absent live owners and reuses a slot only after its owner retires', () => {
    const pack = createVfxInstanceArena();
    const a = instance('player-a');
    const b = instance('player-b');
    const c = instance('player-c');
    const d = instance('player-d');
    const first = workAt(
      pack({
        work: [stateWork([a, b])],
        instances: [a, b],
        liveOwners: owners([a, b]),
        generation: 1,
      }),
    );
    for (let frame = 0; frame < 10; frame += 1) {
      pack({ work: [], instances: [], liveOwners: owners([a, b]), generation: 1 });
    }
    const held = workAt(
      pack({
        work: [stateWork([a, c])],
        instances: [a, c],
        liveOwners: owners([a, b, c]),
        generation: 1,
      }),
    );
    expect(stateRange(held, a.prefix)).toEqual(stateRange(first, a.prefix));
    expect(stateRange(held, c.prefix).resource).toBe(stateRange(first, b.prefix).resource);
    expect(stateRange(held, c.prefix).offset).toBe(512);

    const retired = workAt(
      pack({
        work: [stateWork([a, c, d])],
        instances: [a, c, d],
        liveOwners: owners([a, c, d]),
        generation: 1,
      }),
    );
    expect(stateRange(retired, a.prefix)).toEqual(stateRange(held, a.prefix));
    expect(stateRange(retired, c.prefix)).toEqual(stateRange(held, c.prefix));
    expect(stateRange(retired, d.prefix).resource).toBe(stateRange(first, b.prefix).resource);
    expect(stateRange(retired, d.prefix).offset).toBe(stateRange(first, b.prefix).offset);
  });

  it('reuses logical leases when a packed frame is discarded before any physical preparation', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a'), instance('player-b')];
    const input = {
      work: [stateWork(instances)],
      instances,
      liveOwners: owners(instances),
      generation: 1,
    };
    // Discarding this declaration models an aborted frame; no GPU owner is involved.
    const discarded = workAt(pack(input));
    const repeated = workAt(pack(input));
    const reorderedInstances = [...instances].reverse();
    const reordered = workAt(
      pack({ ...input, work: [stateWork(reorderedInstances)], instances: reorderedInstances }),
    );

    for (const row of instances) {
      expect(stateRange(repeated, row.prefix)).toEqual(stateRange(discarded, row.prefix));
      expect(stateRange(reordered, row.prefix)).toEqual(stateRange(discarded, row.prefix));
    }
    expect(buffers(repeated)).toHaveLength(1);
    expect(buffers(reordered)).toHaveLength(1);
  });

  it('starts a cold layout for a new device generation', () => {
    const pack = createVfxInstanceArena();
    const a = instance('player-a');
    const b = instance('player-b');
    const first = workAt(
      pack({
        work: [stateWork([a, b])],
        instances: [a, b],
        liveOwners: owners([a, b]),
        generation: 4,
      }),
    );
    const warm = workAt(
      pack({ work: [stateWork([b])], instances: [b], liveOwners: owners([a, b]), generation: 4 }),
    );
    const cold = workAt(
      pack({ work: [stateWork([b])], instances: [b], liveOwners: owners([b]), generation: 5 }),
    );

    expect(stateRange(warm, b.prefix)).toEqual(stateRange(first, b.prefix));
    expect(stateRange(warm, b.prefix).offset).toBe(256);
    expect(stateRange(cold, b.prefix).offset).toBe(0);
    expect(buffers(cold)).toHaveLength(1);
    expect(buffers(cold)[0]).not.toBe(buffers(first)[0]);
  });

  it('rewrites frame-to-view ranges, copies and indirect commands without changing draw order', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a'), instance('player-b')];
    const frame: RenderFeatureWork = {
      scope: 'frame',
      resources: instances.map(
        (row): BufferResource => ({
          kind: 'buffer',
          name: `${row.prefix}.args`,
          size: 64,
          usage: ['storage', 'indirect', 'copy-src'],
        }),
      ),
      passes: [],
    };
    const drawB: Draw = {
      program: 'draw-b',
      bindings: [],
      vertexData: [{ slot: 0, resource: 'player-b.vertex' }],
      indexData: { resource: 'player-b.index', format: 'uint16' },
      draw: { kind: 'draw-indexed-indirect', resource: 'player-b.args', offset: 20 },
    };
    const drawA: Draw = {
      program: 'draw-a',
      bindings: [],
      vertexData: [],
      draw: { kind: 'draw-indirect', resource: 'player-a.args' },
    };
    const direct: Draw = {
      program: 'draw-direct',
      bindings: [],
      vertexData: [],
      draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
    };
    const view: RenderFeatureWork = {
      scope: { view: 'main' },
      resources: [
        ...instances.flatMap((row): Resource[] => [
          {
            kind: 'buffer',
            name: `${row.prefix}.instances`,
            size: 64,
            usage: ['storage', 'vertex'],
          },
          { kind: 'buffer', name: `${row.prefix}.indices`, size: 32, usage: ['index'] },
        ]),
        {
          kind: 'vertex-data',
          name: 'player-b.vertex',
          layout: 'instance-layout',
          buffer: 'player-b.instances',
          offset: 16,
          size: 32,
        },
        {
          kind: 'index-data',
          name: 'player-b.index',
          format: 'uint16',
          buffer: 'player-b.indices',
          offset: 4,
          size: 8,
        },
        {
          kind: 'compute-bindings',
          name: 'view.bindings',
          program: 'stock-program',
          entries: [
            { binding: 0, resource: 'player-b.args' },
            { binding: 1, resource: 'player-b.instances' },
            { binding: 2, resource: 'player-b.indices' },
          ],
        },
      ],
      passes: [
        {
          kind: 'copy',
          name: 'project',
          copies: [
            {
              source: 'player-b.args',
              destination: 'player-b.instances',
              sourceOffset: 4,
              destinationOffset: 8,
              size: 16,
            },
          ],
        },
        {
          kind: 'compute',
          name: 'compact',
          program: 'stock-program',
          bindings: 'view.bindings',
          dispatches: [
            { kind: 'indirect', entryPoint: 'main', resource: 'player-b.args', offset: 12 },
          ],
        },
        { kind: 'raster', name: 'render', colorAttachments: [], draws: [drawB, drawA, direct] },
      ],
    };
    const packed = pack({
      work: [frame, view],
      instances,
      liveOwners: owners(instances),
      generation: 1,
    });
    const packedFrame = workAt(packed);
    const packedView = workAt(packed, 1);
    const entries = resource(packedView, 'view.bindings', 'compute-bindings').entries;
    const args = entries[0],
      vertex = entries[1],
      index = entries[2];
    if (args === undefined || vertex === undefined || index === undefined)
      throw new Error('Missing view ranges');
    const copy = packedView.passes[0],
      compute = packedView.passes[1],
      raster = packedView.passes[2];
    if (copy?.kind !== 'copy' || compute?.kind !== 'compute' || raster?.kind !== 'raster') {
      throw new Error('Changed pass order');
    }

    expect(args.offset).toBe(256);
    expect(packedView.resources.some((entry) => entry.name === args.resource)).toBe(false);
    expect(resource(packedFrame, args.resource, 'buffer').size).toBe(16 * 256);
    expect(copy.copies).toEqual([
      {
        source: args.resource,
        destination: vertex.resource,
        sourceOffset: 260,
        destinationOffset: 264,
        size: 16,
      },
    ]);
    expect(resource(packedView, 'player-b.vertex', 'vertex-data')).toMatchObject({
      buffer: vertex.resource,
      offset: 272,
      size: 32,
    });
    expect(resource(packedView, 'player-b.index', 'index-data')).toMatchObject({
      buffer: index.resource,
      offset: 260,
      size: 8,
    });
    expect(compute.dispatches).toEqual([
      { kind: 'indirect', entryPoint: 'main', resource: args.resource, offset: 268 },
    ]);
    expect(packedView.passes.map((pass) => pass.name)).toEqual(
      view.passes.map((pass) => pass.name),
    );
    expect(raster.draws.map((draw) => draw.program)).toEqual(['draw-b', 'draw-a', 'draw-direct']);
    expect(raster.draws[0]).toMatchObject({
      ...drawB,
      draw: { kind: 'draw-indexed-indirect', resource: args.resource, offset: 276 },
    });
    expect(raster.draws[1]).toMatchObject({
      ...drawA,
      draw: { kind: 'draw-indirect', resource: args.resource, offset: 0 },
    });
    expect(raster.draws[2]).toBe(direct);
  });

  it('preserves unrelated custom and provider resources, including existing upload declarations', () => {
    const pack = createVfxInstanceArena();
    const instances = [instance('player-a')];
    const custom: BufferResource = {
      kind: 'buffer',
      name: 'custom.particles',
      size: 32,
      usage: ['storage'],
      data: new Uint32Array([1, 2]),
    };
    const uploads: BufferResource = {
      kind: 'buffer',
      name: 'player-a.prepacked',
      size: 512,
      usage: ['uniform'],
      uploads: [{ offset: 256, data: new Uint32Array([3, 4]) }],
    };
    const provider: Resource = {
      kind: 'prepared-gpu-resource',
      name: 'player-a.provider',
      resource: { kind: 'buffer', value: { external: true }, size: 64, usage: ['storage'] },
    };
    const customBindings: Bindings = {
      kind: 'compute-bindings',
      name: 'custom.bindings',
      program: 'custom-program',
      entries: [
        { binding: 0, resource: custom.name },
        { binding: 1, resource: provider.name },
      ],
    };
    const customVertex: Resource = {
      kind: 'vertex-data',
      name: 'custom.vertex',
      layout: 'custom-layout',
      buffer: custom.name,
    };
    const authoredVertex: Resource = {
      kind: 'vertex-data',
      name: 'custom.authored-vertex',
      layout: 'custom-layout',
      data: new Float32Array([0, 1, 2]),
    };
    const customGraphics: Resource = {
      kind: 'graphics-bindings',
      name: 'custom.graphics',
      program: 'custom-material',
      values: { instances: custom.name },
    };
    const untouched = [
      custom,
      uploads,
      provider,
      customBindings,
      customVertex,
      authoredVertex,
      customGraphics,
    ];
    const work: RenderFeatureWork = {
      scope: 'frame',
      resources: [...stateWork(instances).resources, ...untouched],
      passes: [],
    };
    const packed = workAt(
      pack({ work: [work], instances, liveOwners: owners(instances), generation: 1 }),
    );

    expect(stateRange(packed, 'player-a').resource).not.toBe('player-a.particles');
    for (const original of untouched) {
      expect(packed.resources.find((entry) => entry.name === original.name)).toBe(original);
    }
    const tooSmall = workAt(
      pack({
        work: [work],
        instances,
        liveOwners: owners(instances),
        generation: 2,
        limits: { maxBufferSize: 256 },
      }),
    );
    for (const original of work.resources) {
      expect(tooSmall.resources.find((entry) => entry.name === original.name)).toBe(original);
    }
  });
  it('rejects a logical range that could otherwise enter the next player slot', () => {
    const pack = createVfxInstanceArena();
    const rows = [instance('player-a'), instance('player-b')];
    const work = stateWork(rows);
    const invalid: RenderFeatureWork = {
      ...work,
      resources: work.resources.map((resource) =>
        resource.kind === 'compute-bindings' && resource.name === 'player-a.bindings'
          ? {
              ...resource,
              entries: [{ binding: 0, resource: 'player-a.particles', offset: 96, size: 32 }],
            }
          : resource,
      ),
    };
    expect(() =>
      pack({ work: [invalid], instances: rows, liveOwners: owners(rows), generation: 1 }),
    ).toThrow('Invalid owned VFX arena range');
  });
});

it('bounds retained physical storage slabs by whole-buffer binding limits and aligns element bases', () => {
  const arena = createVfxInstanceArena(),
    a = instance('a'),
    b = instance('b');
  const frame = arena.beginRetainedFrame({
    liveOwners: owners([a, b]),
    generation: 1,
    limits: {
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 65536,
      maxStorageBufferBindingSize: 8192,
    },
  });
  const first = frame.acquire(a, 'a.particles', 560, ['storage'], 'frame', 112),
    second = frame.acquire(b, 'b.particles', 560, ['storage'], 'frame', 112);
  expect(first.name).toBe(second.name);
  expect(second.offset % 112).toBe(0);
  expect(second.offset % 256).toBe(0);
  expect(frame.declaration(first).size).toBeLessThanOrEqual(8192);
  expect(frame.supports(8193, ['storage'])).toBe(false);
});

describe('incremental retained arena frames', () => {
  const bindingsFor = (prefix: string): RenderFeatureWork => ({
    scope: 'frame',
    resources: [
      {
        kind: 'compute-bindings',
        name: `${prefix}.bindings`,
        program: 'stock-program',
        entries: [{ binding: 0, resource: `${prefix}.particles` }],
      },
    ],
    passes: [],
  });
  const pack = (
    arena: ReturnType<typeof createVfxInstanceArena>,
    rows: readonly VfxArenaInstance[],
    prefix: string,
  ) =>
    stateRange(
      workAt(
        arena({
          work: [bindingsFor(prefix)],
          instances: rows,
          liveOwners: owners(rows),
          generation: 1,
        }),
      ),
      prefix,
    );

  it('maps a retained lease only in a frame that retained it again', () => {
    const arena = createVfxInstanceArena(),
      a = instance('a');
    const first = arena.beginRetainedFrame({ liveOwners: owners([a]), generation: 1 });
    const range = first.acquire(a, 'a.particles', 112, ['storage']);
    expect(pack(arena, [a], 'a').resource).toBe(range.name);
    // The persistent index keeps the lease, but this frame never confirmed it.
    const second = arena.beginRetainedFrame({ liveOwners: owners([a]), generation: 1 });
    expect(pack(arena, [a], 'a').resource).toBe('a.particles');
    const third = arena.beginRetainedFrame({ liveOwners: owners([a]), generation: 1 });
    expect(third.retain([range])).toBe(true);
    expect(pack(arena, [a], 'a')).toMatchObject({ resource: range.name, offset: range.offset });
    expect(second).not.toBe(third);
  });

  it('refuses a released lease even when its range object is offered again', () => {
    const arena = createVfxInstanceArena(),
      a = instance('a'),
      b = instance('b');
    const first = arena.beginRetainedFrame({ liveOwners: owners([a, b]), generation: 1 });
    const range = first.acquire(a, 'a.particles', 112, ['storage']);
    // Owner a retires: its slot is released and must not be revived.
    arena.beginRetainedFrame({ liveOwners: owners([b]), generation: 1 });
    const revived = arena.beginRetainedFrame({ liveOwners: owners([a, b]), generation: 1 });
    expect(revived.retain([range])).toBe(false);
    const fresh = revived.acquire(a, 'a.particles', 112, ['storage']);
    expect(fresh).not.toBe(range);
    expect(pack(arena, [a, b], 'a')).toMatchObject({ resource: fresh.name, offset: fresh.offset });
  });

  it('drops every retained lease on a device generation change', () => {
    const arena = createVfxInstanceArena(),
      a = instance('a');
    const first = arena.beginRetainedFrame({ liveOwners: owners([a]), generation: 1 });
    const range = first.acquire(a, 'a.particles', 112, ['storage']);
    const next = arena.beginRetainedFrame({ liveOwners: owners([a]), generation: 2 });
    expect(next.retain([range])).toBe(false);
  });
});
