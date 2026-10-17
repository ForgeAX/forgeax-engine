import type { RenderFeatureWork } from '@forgeax/engine-render';
import { expect, it } from 'vitest';
import { createVfxDirectComputeFrame } from '../feature/direct-compute-frame';
import type { VfxArenaRange } from '../feature/instance-arena';

type Resource = RenderFeatureWork['resources'][number];
type Pass = RenderFeatureWork['passes'][number];
const strides = [112, 4, 24, 20, 4, 4, 24];
const ranges = (slot: number) =>
  strides.map((stride, index) => ({
    name: `physical-${index}`,
    offset: stride * 256 * slot,
    size: stride * 4,
    source: `logical-${slot}-${index}`,
    owner: `owner-${slot}`,
    scope: 'frame',
    slot,
    layout: {
      id: index,
      size: stride * 4,
      stride: stride * 256,
      capacity: 16,
      slots: [],
      lastUsed: 1,
      usage: ['storage'],
    },
  })) as VfxArenaRange[];
const input = (slot: number) => ({
  program: 'program',
  ranges: ranges(slot),
  entries: ['spawn', 'update'],
  runtime: new Uint32Array(76).fill(slot + 1),
  customStride: 24,
});
it('copies current runtime rows and preserves independent nonzero whole-buffer bases', () => {
  const frame = createVfxDirectComputeFrame(),
    a = input(1),
    b = input(2);
  frame.simulation({ ...a, tick: 0, reset: [] });
  frame.simulation({ ...b, tick: 0, reset: [] });
  a.runtime.fill(99);
  b.runtime.fill(88);
  const resources: Resource[] = [],
    passes: Pass[] = [];
  frame.finishFrame(resources, passes);
  const table = resources.find((r) => r.kind === 'buffer' && r.name.endsWith('.table'));
  expect(table?.kind).toBe('buffer');
  if (table?.kind !== 'buffer' || table.data === undefined) return;
  const words = new Uint32Array(
    table.data.buffer,
    table.data.byteOffset,
    table.data.byteLength / 4,
  );
  expect(words[0]).toBe(2);
  expect(words[84]).toBe(3);
  expect([...words.slice(76, 84)]).toEqual([256, 256, 256, 256, 256, 256, 256, 1]);
  expect([...words.slice(160, 168)]).toEqual([512, 512, 512, 512, 512, 512, 512, 1]);
  expect(passes[0]?.kind).toBe('compute');
  if (passes[0]?.kind === 'compute')
    expect(
      passes[0].dispatches.map((d) => (d.kind === 'direct' ? d.workgroups : undefined)),
    ).toEqual([
      [1, 2],
      [1, 2],
    ]);
  const retained = words.slice();
  const next = createVfxDirectComputeFrame();
  next.simulation({ ...input(3), tick: 0, reset: [] });
  next.finishFrame([], []);
  expect(words).toEqual(retained);
});
it('orders an intervening reset after prior simulation and before its own wave', () => {
  const frame = createVfxDirectComputeFrame(),
    copy = { source: 'zero', destination: 'physical-0', size: 112 };
  frame.simulation({ ...input(1), tick: 0, reset: [] });
  frame.simulation({ ...input(1), tick: 1, reset: [copy] });
  frame.simulation({ ...input(2), tick: 1, reset: [] });
  const passes: Pass[] = [];
  frame.finishFrame([], passes);
  expect(passes.map((p) => p.kind)).toEqual(['compute', 'copy', 'compute']);
  if (passes[1]?.kind === 'copy') expect(passes[1].copies).toEqual([copy]);
});
it('keeps views and fresh frames independent and emits no unused raw-only control resources', () => {
  const frame = createVfxDirectComputeFrame();
  const empty: Resource[] = [];
  frame.finishFrame(empty, []);
  expect(empty).toEqual([]);
  frame.projection('main', input(1));
  frame.projection('side', input(2));
  const common: Resource[] = [],
    main: Resource[] = [],
    side: Resource[] = [];
  frame.finishFrame(common, []);
  frame.finishView('main', main, []);
  frame.finishView('side', side, []);
  expect(common).toHaveLength(1);
  const table = (rows: Resource[]) =>
    rows.find((r) => r.kind === 'buffer' && r.name.endsWith('.table'));
  expect(table(main)).not.toBe(table(side));
  expect(table(main)?.name).not.toBe(table(side)?.name);
});
